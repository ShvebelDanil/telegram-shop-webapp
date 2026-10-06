from fastapi import FastAPI, HTTPException, Request
import aiosqlite
from fastapi.staticfiles import StaticFiles
import os
import json
import hashlib
import hmac
import time
from collections import Counter
from datetime import datetime, timedelta
from urllib.parse import parse_qsl
from pydantic import BaseModel
from typing import List, Literal, Optional
from aiogram import Bot
from os import getenv
from dotenv import load_dotenv

from handlers.shop_dp import (
    LOCATION_NAMES, DELIVERY_LOCATION, SHOP_TZ, get_products, get_user_bonus_balance, DB_NAME,
    reduce_query, restock_items, get_next_order_seq, compute_order_number, manager_pay_per_unit,
)
from handlers.subscription import is_subscribed

NOT_SUBSCRIBED_DETAIL = "Магазин доступен подписчикам канала — вернитесь в бота и подпишитесь"

load_dotenv()

# Акция на весь каталог: DISCOUNT_PERCENT=20 и DISCOUNT_UNTIL=2026-12-31 (включительно,
# по SHOP_TZ) в .env; 0 или пусто — акции нет. Бэкенд — единственный источник истины
# по деньгам: эта же цена уходит и в каталог вебаппа, и в сумму заказа менеджеру.
DISCOUNT_RATE = int(getenv("DISCOUNT_PERCENT", "0") or 0) / 100
_discount_until_raw = getenv("DISCOUNT_UNTIL", "").strip()
DISCOUNT_END = (datetime.fromisoformat(_discount_until_raw).replace(tzinfo=SHOP_TZ) + timedelta(days=1)
                if _discount_until_raw else None)


def _discount_active() -> bool:
    return DISCOUNT_RATE > 0 and (DISCOUNT_END is None or datetime.now(SHOP_TZ) < DISCOUNT_END)


def _apply_discount(price: int) -> int:
    return round(price * (1 - DISCOUNT_RATE))


def _with_discount(products: list[dict]) -> list[dict]:
    """Добавляет original_price и уценивает price, пока акция активна. Наличие/id не трогает."""
    if not _discount_active():
        return products
    result = []
    for p in products:
        p = dict(p)
        p["original_price"] = p["price"]
        p["price"] = _apply_discount(p["price"])
        result.append(p)
    return result

# Точки, временно скрытые из вебаппа (товары не удаляются, только не отдаются по API).
# Скрытая точка: пустой каталог, заказы и подбор в неё отклоняются.
HIDDEN_LOCATIONS: set[str] = set()

TOKEN = getenv("BOT_TOKEN")
bot = Bot(token=TOKEN)


def _verify_webapp_uid(uid: Optional[int], sig: Optional[str]) -> Optional[int]:
    """Проверяет подпись uid из URL вебаппа (?uid=...&sig=...).
    Подпись ставит бот в момент отрисовки кнопки «Каталог» — тем же ключом (BOT_TOKEN).
    Возвращает int ID только при валидной sig: иначе кто угодно мог бы подставить
    чужой ID в ссылку и получить заказ в чужой чат."""
    if not uid or not sig:
        return None
    expected = hmac.new((TOKEN or "").encode(), f"uid:{uid}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(sig)):
        print("⚠️ Подпись webapp_uid не сошлась — игнорирую ID из URL")
        return None
    return int(uid)


INIT_DATA_TTL_SECONDS = 24 * 60 * 60


def _extract_user_from_init_data(init_data: str | None) -> Optional[dict]:
    """Валидирует подпись initData (HMAC-SHA256, алгоритм из доков Telegram)
    и возвращает dict юзера из поля user. None — строки нет или подпись не сошлась.
    initData приходит от клиента всегда, даже когда initDataUnsafe.user пуст."""
    if not init_data:
        return None
    try:
        pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    except ValueError:
        return None

    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", (TOKEN or "").encode(), hashlib.sha256).digest()
    calculated = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated, received_hash):
        print("⚠️ Подпись initData не сошлась — возможно, подделка. Игнорирую initData")
        return None

    # Без проверки возраста перехваченный initData (он ходит и в GET query → в логи) валиден вечно.
    try:
        if time.time() - int(pairs.get("auth_date", 0)) > INIT_DATA_TTL_SECONDS:
            return None
    except ValueError:
        return None

    try:
        return json.loads(pairs.get("user", "{}"))
    except json.JSONDecodeError:
        return None


def _verify_user_id(init_data: Optional[str], webapp_uid: Optional[int], webapp_sig: Optional[str]) -> Optional[int]:
    """Криптографически подтверждённый Telegram ID: сначала initData (HMAC),
    затем подписанная ссылка вебаппа (?uid=...&sig=...). None — ничего не сошлось."""
    init_user = _extract_user_from_init_data(init_data)
    if init_user and init_user.get("id"):
        return int(init_user["id"])
    if webapp_uid:
        return _verify_webapp_uid(webapp_uid, webapp_sig)
    return None

app = FastAPI()


async def _require_subscriber(init_data: Optional[str], webapp_uid: Optional[int], webapp_sig: Optional[str]) -> None:
    """Гейт каталога: запрос подписан ботом (пришёл из настоящего Telegram WebApp, а не
    от сканера) и юзер подписан на канал REQUIRED_CHANNEL, если он задан (handlers/subscription.py)."""
    user_id = _verify_user_id(init_data, webapp_uid, webapp_sig)
    if user_id is None:
        raise HTTPException(status_code=403, detail="Каталог доступен только из Telegram WebApp")
    # Старые кнопки «Каталог» в чатах и подписанные ссылки живут вечно — без этой
    # проверки гейт подписки в /start обходится ими.
    if not await is_subscribed(bot, user_id):
        raise HTTPException(status_code=403, detail=NOT_SUBSCRIBED_DETAIL)


def _require_admin(init_data: Optional[str]) -> int:
    """Требует свежий initData (TTL) от Telegram ID из ADMINS_ID. Подписанная ссылка
    ?uid=&sig= здесь НЕ принимается: у неё нет срока жизни, и утёкшая ссылка
    админа давала бы вечный доступ к правке склада."""
    init_user = _extract_user_from_init_data(init_data)
    verified_id = int(init_user["id"]) if init_user and init_user.get("id") else None
    from handlers.routes import admins_id
    if verified_id is None or verified_id not in admins_id:
        raise HTTPException(status_code=403, detail="Доступно только администраторам")
    return verified_id


# --- Каталог по точкам: /api/products/<location> ---
# Вебапп тянет каталог строго своей точки — без клиентской фильтрации и путаницы.
# Дефисы нормализуются: /api/products/some-point → some_point.


def _normalize_location(location_raw: str) -> str:
    return location_raw.strip().lower().replace("-", "_")


@app.get("/api/products/{location}")
async def get_products_by_location(
    location: str,
    init_data: Optional[str] = None,
    webapp_uid: Optional[int] = None,
    webapp_sig: Optional[str] = None,
):
    """Каталог конкретной точки (ключи LOCATION_NAMES)."""
    await _require_subscriber(init_data, webapp_uid, webapp_sig)

    loc = _normalize_location(location)
    if loc not in LOCATION_NAMES:
        raise HTTPException(status_code=404, detail="Неизвестная точка самовывоза")

    if loc in HIDDEN_LOCATIONS:
        return []

    return _with_discount(await get_products(loc))


@app.get("/api/admin/products/{location}")
async def get_admin_products(
    location: str,
    init_data: Optional[str] = None,
):
    """Каталог для админ-вебаппа (управление наличием) — та же точка, что и у
    покупателей, но без скидки (реальная цена из БД) и без фильтра HIDDEN_LOCATIONS —
    админу нужно видеть и скрытую точку, и товары с нулевым остатком."""
    _require_admin(init_data)

    loc = _normalize_location(location)
    if loc not in LOCATION_NAMES:
        raise HTTPException(status_code=404, detail="Неизвестная точка самовывоза")

    return await get_products(loc)


class StockAdjustRequest(BaseModel):
    product_id: int
    delta: int
    init_data: Optional[str] = None


@app.post("/api/admin/stock")
async def adjust_stock_endpoint(payload: StockAdjustRequest):
    """+1/-1 из админ-вебаппа. Не пересекается с резервом склада заказов
    (reduce_query/restock_items/PENDING_ORDERS) — это прямая ручная правка."""
    _require_admin(payload.init_data)

    from handlers.shop_dp import adjust_stock
    try:
        new_count = await adjust_stock(payload.product_id, payload.delta)
    except ValueError:
        raise HTTPException(status_code=404, detail="Товар не найден")
    return {"count": new_count}


class CartItem(BaseModel):
    # Цену/название с клиента не принимаем вовсе — их берёт _load_authoritative_items из БД.
    id: int
    quantity: int


class OrderData(BaseModel):
    items: List[CartItem]
    # Сырая подписанная Telegram строка initData — проверяем HMAC и достаём юзера
    init_data: Optional[str] = None
    # ID и подпись из URL вебаппа (?uid=...&sig=...) — бот подставляет их,
    # когда рисует кнопку «Каталог»
    webapp_uid: Optional[int] = None
    webapp_sig: Optional[str] = None
    # delivery — доставка, pickup — самовывоз
    order_type: Optional[str] = "delivery"
    # заполнено только при самовывозе: ключ из LOCATION_NAMES
    location: Optional[str] = None
    bonus_to_use: Optional[int] = 0
    # Весь checkout теперь целиком в вебаппе (телефон/адрес/способ оплаты
    # вводятся тут же, а не в переписке с ботом) — см. CheckoutFlow.tsx.
    phone: str
    address: Optional[str] = None
    payment_method: Literal["cash", "card"]


async def _load_authoritative_items(cart_items: List[CartItem], location: str) -> List[dict]:
    """Подтягивает актуальную цену/название/наличие товаров из БД по id —
    с клиента берём только id и quantity. Дубли id схлопываются (иначе проверка
    остатка шла бы по каждой строке отдельно), товар обязан быть из точки заказа."""
    quantities = Counter()
    for item in cart_items:
        if item.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Некорректное количество для товара id={item.id}")
        quantities[item.id] += item.quantity

    async with aiosqlite.connect(DB_NAME) as db:
        result = []
        for product_id, quantity in quantities.items():
            cursor = await db.execute(
                "SELECT id, name, variant, price, count, type FROM shop WHERE id = ? AND location = ?",
                (product_id, location),
            )
            row = await cursor.fetchone()
            if row is None:
                raise HTTPException(status_code=400, detail=f"Товар id={product_id} не найден в выбранной точке")
            if quantity > row[4]:
                raise HTTPException(status_code=400, detail=f"Недостаточно товара на складе: {row[1]}")
            price = _apply_discount(row[3]) if _discount_active() else row[3]
            result.append({
                "id": row[0],
                "name": row[1],
                "variant": row[2],
                "price": price,
                "quantity": quantity,
                "manager_pay": manager_pay_per_unit(row[5]),
            })
        return result


@app.post("/api/order")
async def create_order(order: OrderData):
    """Единая точка оформления заказа: телефон/адрес/способ оплаты собраны в вебаппе
    (CheckoutFlow.tsx), здесь заказ финализируется целиком — валидация, резерв склада
    (для наличных) или постановка в ожидание оплаты (для карты), отправка менеджеру."""
    if not order.items:
        raise HTTPException(status_code=400, detail="Корзина пуста")

    # Криптографически подтверждённый Telegram ID — единственный источник, которому
    # доверяем (никаких неподтверждённых фолбэков — иначе кто угодно мог бы прислать
    # чужой user_id и бот отправил бы сообщение от своего имени постороннему юзеру).
    user_id = _verify_user_id(order.init_data, order.webapp_uid, order.webapp_sig)
    if user_id is None:
        raise HTTPException(status_code=403, detail="Не удалось подтвердить личность — откройте магазин из Telegram")
    if not await is_subscribed(bot, user_id):
        raise HTTPException(status_code=403, detail=NOT_SUBSCRIBED_DETAIL)

    from handlers.shop_dp import normalize_phone, add_user
    from handlers.delivery import compute_delivery_cost
    from handlers.routes import (
        PENDING_ORDERS, build_user_link_and_mention, build_final_checkout_text,
        finalize_cash_order, create_pending_card_order,
    )

    # Наличный заказ сразу резервирует склад на 24ч — без лимита один юзер мог бы
    # заблокировать весь ассортимент и завалить чат менеджеров.
    if order.payment_method == "cash" and any(
        o["user_id"] == user_id and o["payment_method"] == "cash" for o in PENDING_ORDERS.values()
    ):
        raise HTTPException(status_code=409, detail="У вас уже есть активный заказ — дождитесь, пока менеджер его обработает")

    phone = normalize_phone(order.phone)
    if phone is None:
        raise HTTPException(status_code=400, detail="Введите корректный номер телефона (например, +79991112233)")

    await add_user(user_id, phone)

    order_type = order.order_type if order.order_type in ("delivery", "pickup") else "delivery"

    location = None
    delivery_cost = 0.0
    distance_km = 0.0
    address = None
    if order_type == "pickup":
        if order.location not in LOCATION_NAMES:
            raise HTTPException(status_code=400, detail="Не указана точка самовывоза")
        if order.location in HIDDEN_LOCATIONS:
            raise HTTPException(status_code=400, detail="Эта точка самовывоза временно не работает")
        location = order.location
    else:
        address = (order.address or "").strip()
        if not address:
            raise HTTPException(status_code=400, detail="Введите адрес доставки")
        # Авторитетный пересчёт на сервере — клиентскому числу из preview
        # (/api/delivery-cost) не доверяем, тот же принцип, что и для цены товаров.
        distance_km, delivery_cost = await compute_delivery_cost(address)

    # Доставка всегда едет с DELIVERY_LOCATION — корзина оттуда же.
    authoritative_items = await _load_authoritative_items(order.items, location or DELIVERY_LOCATION)

    total_price = sum(item["price"] * item["quantity"] for item in authoritative_items)
    requested_bonus_to_use = max(int(order.bonus_to_use or 0), 0)
    available_bonus = await get_user_bonus_balance(user_id)
    bonus_to_use = min(requested_bonus_to_use, int(total_price), available_bonus)

    chat = await bot.get_chat(user_id)
    user_link, user_mention = build_user_link_and_mention(chat)
    username = chat.username or f"id_{user_id}"

    final_checkout_text, _final_price = build_final_checkout_text(
        order_type=order_type,
        cart_items=authoritative_items,
        total_price=total_price,
        user_link=user_link,
        user_mention=user_mention,
        phone=phone,
        bonus_used=bonus_to_use,
        delivery_cost=delivery_cost,
        distance_km=distance_km,
        address=address,
        location=location,
    )

    print(f"ВХОДЯЩИЕ ДАННЫЕ ИЗ ВЕБАППА: user_id={user_id}, order_type={order_type}, "
          f"payment_method={order.payment_method}, items={len(order.items)}")

    if order.payment_method == "cash":
        try:
            result = await finalize_cash_order(
                user_id=user_id, username=username, cart_items=authoritative_items,
                total_price=total_price, delivery_cost=delivery_cost, bonus_used=bonus_to_use,
                order_type=order_type, location=location, final_checkout_text=final_checkout_text,
            )
        except ValueError:
            raise HTTPException(status_code=409, detail="Часть товаров только что раскупили, обновите корзину")
        except RuntimeError:
            raise HTTPException(status_code=502, detail="Не удалось отправить заказ менеджеру, попробуйте ещё раз через минуту")
        return {"status": "confirmed", "order_number": result["order_number"]}

    create_pending_card_order(
        user_id=user_id, username=username, cart_items=authoritative_items,
        total_price=total_price, delivery_cost=delivery_cost,
        order_type=order_type, location=location, final_checkout_text=final_checkout_text,
    )
    return {"status": "card_pending"}

@app.get("/api/bonus/{user_id}")
async def get_bonus_balance(
    user_id: int,
    init_data: Optional[str] = None,
    webapp_uid: Optional[int] = None,
    webapp_sig: Optional[str] = None,
):
    """Требует подтверждённую Telegram-личность, совпадающую с user_id из пути —
    иначе баланс любого пользователя можно было прочитать простым перебором id."""
    verified_id = _verify_user_id(init_data, webapp_uid, webapp_sig)

    if verified_id is None or verified_id != user_id:
        raise HTTPException(status_code=403, detail="Нет доступа к балансу этого пользователя")

    balance = await get_user_bonus_balance(user_id)
    return {"bonus_balance": balance}


@app.get("/api/phone/{user_id}")
async def get_phone(
    user_id: int,
    init_data: Optional[str] = None,
    webapp_uid: Optional[int] = None,
    webapp_sig: Optional[str] = None,
):
    """Точная копия принципа /api/bonus/{user_id}: телефон отдаём только владельцу,
    чтобы CheckoutFlow.tsx мог престрелить поле для постоянных клиентов."""
    verified_id = _verify_user_id(init_data, webapp_uid, webapp_sig)
    if verified_id is None or verified_id != user_id:
        raise HTTPException(status_code=403, detail="Нет доступа к данным этого пользователя")

    from handlers.shop_dp import get_phone_number
    phone = await get_phone_number(user_id)
    return {"phone": phone}


class DeliveryCostRequest(BaseModel):
    address: str
    init_data: Optional[str] = None
    webapp_uid: Optional[int] = None
    webapp_sig: Optional[str] = None


@app.post("/api/delivery-cost")
async def get_delivery_cost(payload: DeliveryCostRequest):
    """Preview стоимости доставки для CheckoutFlow.tsx, пока юзер ещё вводит адрес.
    Не авторитетно — /api/order всегда пересчитывает заново на сервере при сабмите,
    этому эндпоинту не нужна привязка к конкретному юзеру, только подпись бота
    (тот же гейт, что у /api/products)."""
    # ponytail: без rate limit — юзер с валидной подписью может жечь квоту геокодера; per-user лимит, если квота начнёт кончаться.
    await _require_subscriber(payload.init_data, payload.webapp_uid, payload.webapp_sig)

    if not payload.address or not payload.address.strip():
        raise HTTPException(status_code=400, detail="Введите адрес")

    from handlers.delivery import compute_delivery_cost
    distance_km, delivery_cost = await compute_delivery_cost(payload.address)
    return {"distance_km": distance_km, "delivery_cost": delivery_cost}


@app.get("/api/recommend")
async def recommend(
    tag: int,
    location: str,
    init_data: Optional[str] = None,
    webapp_uid: Optional[int] = None,
    webapp_sig: Optional[str] = None,
):
    """Квиз «Подобрать напиток» (RecommendModal.tsx): tag — вкус+крепость+бюджет, по цифре
    на каждый ответ (см. DEMO_MENU в shop_dp.py). location обязателен — результат сразу
    можно добавить в корзину, а она привязана к одной точке."""
    await _require_subscriber(init_data, webapp_uid, webapp_sig)

    if location not in LOCATION_NAMES:
        raise HTTPException(status_code=400, detail="Неизвестная точка самовывоза")
    if location in HIDDEN_LOCATIONS:
        return []

    from handlers.shop_dp import get_recommendations
    return _with_discount(await get_recommendations(tag, location))


@app.get("/api/pending-order/{user_id}")
async def get_pending_order(
    user_id: int,
    init_data: Optional[str] = None,
    webapp_uid: Optional[int] = None,
    webapp_sig: Optional[str] = None,
):
    """Сводка неоплаченного карточного заказа для экрана оплаты вебаппа:
    состав, доставка, сервисный сбор, списанные бонусы и ссылка на оплату.
    Тот же принцип, что у /api/bonus: без валидной подписи — 403.
    Ленивый импорт handlers.routes — он сам импортирует server_api (bot),
    на верхнем уровне был бы циклический импорт."""
    verified_id = _verify_user_id(init_data, webapp_uid, webapp_sig)
    if verified_id is None or verified_id != user_id:
        raise HTTPException(status_code=403, detail="Нет доступа к заказам этого пользователя")

    from handlers.routes import PENDING_ORDERS, SERVICE_FEE

    # Берём самый свежий карточный заказ юзера (при повторных кликах бот
    # старые удаляет, но страховка от рассинхрона не помешает).
    pending = None
    for order_data in PENDING_ORDERS.values():
        if order_data.get("user_id") != user_id or order_data.get("payment_method") != "card":
            continue
        if pending is None or order_data["created_at"] > pending["created_at"]:
            pending = order_data

    if pending is None:
        raise HTTPException(status_code=404, detail="Неоплаченный заказ не найден или уже обработан")

    items = [
        {
            "name": item["name"],
            "variant": item.get("variant"),
            "quantity": item["quantity"],
            "price": item["price"],
            "sum": item["price"] * item["quantity"],
        }
        for item in pending["cart_items"]
    ]
    total_price = pending["total_price"]
    delivery_cost = pending.get("delivery_cost", 0.0)
    bonus_applied = min(int(pending.get("bonus_used", 0) or 0), int(total_price))

    return {
        "items": items,
        "total_price": total_price,
        "delivery_cost": delivery_cost,
        "service_fee": SERVICE_FEE,
        "bonus_used": bonus_applied,
        "full_price": pending["full_price"],
        "pay_url": pending["pay_url"],
    }


class ConfirmCardPaymentRequest(BaseModel):
    user_id: int
    init_data: Optional[str] = None
    webapp_uid: Optional[int] = None
    webapp_sig: Optional[str] = None


@app.post("/api/confirm-card-payment")
async def confirm_card_payment(payload: ConfirmCardPaymentRequest):
    """Юзер сам подтвердил оплату по статичной ссылке СБП (кнопка «Я оплатил» в вебаппе) —
    отправляем заказ в группу менеджеров с кнопками «Заказ отдан»/«Отменить».
    Идемпотентно — повторный вызов на уже отправленный заказ ничего не шлёт повторно."""
    verified_id = _verify_user_id(payload.init_data, payload.webapp_uid, payload.webapp_sig)
    if verified_id is None or verified_id != payload.user_id:
        raise HTTPException(status_code=403, detail="Нет доступа к заказам этого пользователя")

    from handlers.routes import PENDING_ORDERS, manager_chat_id, manager_topic_id
    from handlers.keyboards import admin_confirm_inline_keyboard

    pending_key, pending = None, None
    for key, order_data in PENDING_ORDERS.items():
        if order_data.get("user_id") != payload.user_id or order_data.get("payment_method") != "card":
            continue
        if pending is None or order_data["created_at"] > pending["created_at"]:
            pending, pending_key = order_data, key

    if pending is None:
        raise HTTPException(status_code=404, detail="Неоплаченный заказ не найден или уже обработан")

    if pending.get("sent_to_manager"):
        return {"status": "already_sent"}

    # Резервируем склад только сейчас — в момент оплаты, а не при выборе «Картой»
    # (иначе передумавшие клиенты надолго блокируют товар).
    shortages = await reduce_query(pending["cart_items"])
    if shortages:
        raise HTTPException(status_code=409, detail="Часть товаров закончилась, обновите корзину и оформите заказ заново")

    order_seq = await get_next_order_seq()
    order_number = compute_order_number(pending.get("order_type", "delivery"), pending.get("location"), order_seq)
    admin_text = f"НОВЫЙ ЗАКАЗ №{order_number} (💳 КАРТА — ПРОВЕРЬТЕ ПОСТУПЛЕНИЕ)\n\n{pending['final_checkout_text']}"

    try:
        manager_message = await bot.send_message(
            chat_id=manager_chat_id,
            text=admin_text,
            parse_mode="HTML",
            message_thread_id=manager_topic_id,
            reply_markup=admin_confirm_inline_keyboard(pending_key),
        )
    except Exception as e:
        # Не отправилось менеджеру — откатываем резерв склада. sent_to_manager
        # остаётся False, так что юзер может просто нажать «Я оплатил» ещё раз.
        print(f"Ошибка отправки заказа менеджеру: {e}")
        await restock_items(pending["cart_items"])
        raise HTTPException(status_code=502, detail="Не удалось отправить заказ менеджеру, попробуйте ещё раз через минуту")

    pending["order_number"] = order_number
    pending["manager_message_id"] = manager_message.message_id
    pending["stock_reserved"] = True
    pending["sent_to_manager"] = True

    # Дублируем в чат на случай, если юзер закроет вебапп раньше, чем увидит экран «спасибо».
    try:
        await bot.send_message(
            chat_id=payload.user_id,
            text=f"Спасибо за заказ! Номер заказа: {order_number}\nВскоре с вами свяжется менеджер для уточнения деталей.",
        )
    except Exception:
        pass

    return {"status": "sent"}

frontend_dist_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "webapp", "dist"))


@app.middleware("http")
async def static_cache_control(request: Request, call_next):
    """Vite кладёт JS/CSS с хэшем в имени (/assets/*) — их можно кэшировать навсегда.
    Всё остальное, включая index.html, всегда должно грузиться заново — иначе после
    обновления бота юзеры, уже открывавшие вебапп, годами видят старую версию (кэш Telegram WebView)."""
    response = await call_next(request)
    if request.url.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response

app.mount("/", StaticFiles(directory=frontend_dist_path, html=True), name="dist")
