from aiogram import Router, F
import html
import secrets
import time
from aiogram.types import Message, CallbackQuery
from aiogram.filters import Command

from handlers.keyboards import main_inline_keyboard_start, admin_inline_keyboard, \
    admin_confirm_inline_keyboard, broadcast_confirm_keyboard, subscribe_keyboard
from handlers.subscription import is_subscribed
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.context import FSMContext
from server_api import bot
from handlers.shop_dp import (add_order, reduce_query, get_next_order_seq, compute_order_number,
                              restock_items, get_list_of_user_ids, LOCATION_NAMES, use_user_bonus)
from handlers.reports import build_sales_report_text
from os import getenv
from dotenv import load_dotenv
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
import asyncio

load_dotenv()

manager_chat_id = getenv("MANAGER_CHAT_ID")
admins_id_raw = getenv("ADMINS_ID", "")
admins_id = [int(item.strip()) for item in admins_id_raw.split(",") if item.strip()]
PAY_LINK = getenv("PAY_LINK", "")
SHOP_NAME = getenv("SHOP_NAME", "Зерно")
# @username менеджера для связи — в «Частых вопросах» и при отмене заказа.
MANAGER_CONTACT = getenv("MANAGER_CONTACT", "@manager")
# Если в группе менеджеров включены "Темы" (форум) — общий чат без message_thread_id
# шлёт в General; если General скрыт/закрыт, отправка падает. MANAGER_TOPIC_ID
# указывает конкретную тему (id темы, не путать с order_key). Необязателен.
_manager_topic_id_raw = getenv("MANAGER_TOPIC_ID", "").strip()
manager_topic_id = int(_manager_topic_id_raw) if _manager_topic_id_raw else None


router = Router()

PENDING_ORDERS = {}


def new_order_key() -> str:
    """Случайный ключ заказа: таймстемп в секундах давал коллизии при двух заказах в одну секунду.
    8 hex-символов с запасом влезают в лимит callback_data (64 байта)."""
    return secrets.token_hex(4)

def _drop_pending_card_orders(user_id: int) -> None:
    """Удаляет висячие карточные заказы юзера из PENDING_ORDERS.
    При повторном выборе способа оплаты старый заказ не должен оставаться доступным
    в вебаппе — иначе юзер мог бы оплатить уже неактуальную сумму."""
    stale_keys = [
        key for key, order in PENDING_ORDERS.items()
        if order.get("user_id") == user_id and order.get("payment_method") == "card"
    ]
    for key in stale_keys:
        PENDING_ORDERS.pop(key, None)

def build_user_link_and_mention(user) -> tuple[str, str]:
    """user: aiogram User/Chat (есть .id, .first_name, .username).
    Текст ссылки никогда не пустой: first_name -> @username -> 'Пользователь' —
    иначе при пустом first_name менеджер видит невидимую (пустую) ссылку."""
    first_name = getattr(user, "first_name", None)
    username = getattr(user, "username", None)
    anchor_text = html.escape(first_name) if first_name else (
        html.escape(f"@{username}") if username else "Пользователь"
    )
    user_link = f'<a href="tg://user?id={user.id}">{anchor_text}</a>'
    # Без username менеджеру нечем найти клиента, если ссылка tg://user?id= не
    # резолвится (зависит от приватности "Пересланные сообщения" у самого юзера,
    # не от нашего кода) — добавляем голый id как подстраховку.
    mention = f"@{html.escape(username)}" if username else f"нет юзернейма (id: {user.id})"
    return user_link, mention

WELCOME_TEXT = (f"Привет! Это бот кофейни «{SHOP_NAME}».\n\nЗдесь можно:\n1. Открыть меню и заказать\n"
                "2. Посмотреть ответы на частые вопросы\n\nЧто интересует?")
SUBSCRIBE_TEXT = "Бот доступен подписчикам нашего канала. Подпишитесь и нажмите «Я подписался»."


@router.message(Command("start"))
async def send_welcome(message: Message, state: FSMContext):
    await state.clear()
    if not await is_subscribed(message.bot, message.from_user.id):
        await message.answer(SUBSCRIBE_TEXT, reply_markup=subscribe_keyboard())
        return
    await message.answer(WELCOME_TEXT, reply_markup=main_inline_keyboard_start(message.from_user.id))


@router.callback_query(F.data == "check_sub")
async def check_subscription(callback: CallbackQuery):
    if not await is_subscribed(callback.bot, callback.from_user.id):
        await callback.answer("Подписка не найдена", show_alert=True)
        return
    await callback.message.edit_text(WELCOME_TEXT, reply_markup=main_inline_keyboard_start(callback.from_user.id))
    await callback.answer()


@router.callback_query(lambda query: query.data == "help")
async def open_help_link(callback: CallbackQuery):
    if not await is_subscribed(callback.bot, callback.from_user.id):
        await callback.message.answer(SUBSCRIBE_TEXT, reply_markup=subscribe_keyboard())
        await callback.answer()
        return
    await callback.message.answer(
        "1. <b>Как сделать заказ?</b>\n"
        "Откройте меню, выберите способ получения, добавьте позиции в корзину и оформите заказ — "
        "телефон, адрес и оплата вводятся прямо в приложении.\n\n"
        "2. <b>Что такое самовывоз?</b>\n"
        "Вы сами забираете заказ в выбранной кофейне — без платы за доставку.\n\n"
        "3. <b>Я оформил заказ. Что дальше?</b>\n"
        "Менеджер получит заказ сразу и свяжется с вами, если что-то нужно уточнить.\n\n"
        f"По всем остальным вопросам пишите {MANAGER_CONTACT}", parse_mode="HTML")
    await callback.answer()


SERVICE_FEE = 20
# Полный выкуп товара бонусами: юзер отдаёт символический 1 руб за товар (наличными).
FULL_BONUS_REDEEM_CASH = 1


def _pickup_label(location: str | None) -> str:
    return LOCATION_NAMES.get(location, "Не указана")


def build_final_checkout_text(
    *, order_type: str, cart_items: list, total_price: float, user_link: str,
    user_mention: str, phone: str, bonus_used: int, delivery_cost: float = 0.0,
    distance_km: float = 0.0, address: str | None = None, location: str | None = None,
) -> tuple[str, float]:
    """Собирает текст заказа для менеджера (самовывоз или доставка) из данных формы
    вебаппа. Возвращает (final_text, final_price)."""
    order_items_text = ""
    for item in cart_items:
        item_name = html.escape(str(item["name"]))
        variant = f" ({html.escape(str(item['variant']))})" if item.get("variant") else ""
        order_items_text += f"• {item_name}{variant} x {item['quantity']} шт. - {item['price'] * item['quantity']} руб.\n"

    phone_escaped = html.escape(str(phone))

    # Бонусы покрывают только стоимость товаров (доставка/сервис платятся отдельно).
    bonus_applied = min(bonus_used, total_price)
    is_full_bonus_redeem = total_price > 0 and bonus_applied >= total_price
    # При полном выкупе бонусами товар стоит символический 1 руб (наличными).
    symbolic_cash = FULL_BONUS_REDEEM_CASH if is_full_bonus_redeem else 0

    # «Списание бонусов» показываем только когда бонус реально списывается,
    # а не рисуем «-0 руб» при пустом тумблере.
    bonus_lines = ""
    if bonus_applied > 0:
        bonus_lines = f"🎁 Списание бонусов: -{bonus_applied} руб"
        if is_full_bonus_redeem:
            bonus_lines += f" (полный выкуп бонусами · символический {FULL_BONUS_REDEEM_CASH} руб за товар)"
    bonus_line_block = f"{bonus_lines}\n" if bonus_lines else ""

    if order_type == "pickup":
        final_price = total_price - bonus_applied + SERVICE_FEE + symbolic_cash
        final_text = (
            f"📦 <b>Оформлен самовывоз!</b>\n\n"
            f"🛒 Ваш заказ: {order_items_text}\n"
            f"📍 Точка самовывоза: <b>{_pickup_label(location)}</b>\n"
            f"👤 Ваше имя/юз: {user_link}/{user_mention}\n"
            f"📞 Ваш телефон: {phone_escaped}\n"
            f"📔 Сумма заказа: {total_price} руб\n"
            f"{bonus_line_block}"
            f"⚙️ Работа сервиса: {SERVICE_FEE} руб\n"
            f"💰 <b>Итого:</b> {final_price} руб"
        )
    else:
        address_escaped = html.escape(str(address))
        final_price = total_price - bonus_applied + delivery_cost + SERVICE_FEE + symbolic_cash
        final_text = (
            f"🚗 <b>Оформлена доставка!</b>\n\n"
            f"🛒 Ваш заказ: {order_items_text}\n"
            f"👤 Ваше имя/юз: {user_link}/{user_mention}\n"
            f"📞 Ваш телефон: {phone_escaped}\n"
            f"📍 Ваш адрес: {address_escaped}\n"
            f"📔 Сумма заказа: {total_price} руб\n"
            f"{bonus_line_block}"
            f"🚗 Стоимость доставки ({distance_km} км): {delivery_cost} руб\n"
            f"⚙️ Работа сервиса: {SERVICE_FEE} руб\n"
            f"💰 <b>Итого:</b> {final_price} руб"
        )

    return final_text, final_price


async def finalize_cash_order(
    *, user_id: int, username: str, cart_items: list, total_price: float,
    delivery_cost: float, bonus_used: int, order_type: str, location: str | None,
    final_checkout_text: str,
) -> dict:
    """Оформление заказа наличными из /api/order (server_api.py): резервирует склад,
    присваивает номер, шлёт заказ менеджеру. ValueError('out_of_stock') при нехватке
    остатка (→ HTTP 409), RuntimeError — если менеджеру отправить не удалось (→ 502)."""
    if await reduce_query(cart_items):
        raise ValueError("out_of_stock")

    order_seq = await get_next_order_seq()
    order_number = compute_order_number(order_type, location, order_seq)
    order_key = new_order_key()

    PENDING_ORDERS[order_key] = {
        "username": username,
        "user_id": user_id,
        "delivery_cost": delivery_cost,
        "total_price": total_price,
        "cart_items": cart_items,
        "final_checkout_text": final_checkout_text,
        "payment_method": "cash",
        "bonus_used": bonus_used,
        "order_number": order_number,
        "stock_reserved": True,
        "created_at": time.time(),
        # Точка заказа (None у доставки) — для разбивки отчётов по менеджерам
        "location": location,
    }

    admin_text = f"НОВЫЙ ЗАКАЗ №{order_number} (💵 НАЛИЧНЫЕ)\n\n{final_checkout_text}"

    # Юзер выбрал наличные вместо карты — неоплаченный карточный заказ больше не актуален.
    _drop_pending_card_orders(user_id)

    try:
        manager_message = await bot.send_message(chat_id=manager_chat_id, text=admin_text, parse_mode="HTML",
                                                 message_thread_id=manager_topic_id,
                                                 reply_markup=admin_confirm_inline_keyboard(order_key))
        # Нужен cron'у, чтобы при истечении 24ч снять кнопки с этого сообщения.
        PENDING_ORDERS[order_key]["manager_message_id"] = manager_message.message_id
    except Exception as e:
        # Не смогли уведомить менеджера — откатываем резерв, иначе склад тихо
        # "теряется", а заказ никто никогда не увидит и не подтвердит.
        print(f"Ошибка отправки заказа менеджеру: {e}")
        PENDING_ORDERS.pop(order_key, None)
        await restock_items(cart_items)
        raise RuntimeError("manager_notify_failed") from e

    return {"order_number": order_number}


@router.callback_query(F.data.startswith("confirm_order:"), F.message.chat.id == int(manager_chat_id))
async def admin_confirm_order(callback: CallbackQuery):
    order_key = callback.data.split(":")[1]

    order_data = PENDING_ORDERS.get(order_key)

    if not order_data:
        await callback.answer(
            "⚠️ Заказ не найден или уже обработан!", show_alert=True
        )
        return

    payment_method = order_data.get("payment_method", "cash")
    bonus_used = int(order_data.get("bonus_used", 0) or 0)
    order_number = order_data.get("order_number")

    # Склад уже зарезервирован в момент создания заказа (finalize_cash_order/confirm_card_payment) —
    # повторно не списываем, тут только фиксируем заказ в orders для отчётов.
    await add_order(
        order_data["total_price"],
        payment_method,
        order_data["user_id"],
        order_data["delivery_cost"],
        SERVICE_FEE,
        location=order_data.get("location"),
        order_number=order_number,
        manager_pay=sum(item.get("manager_pay", 0) * item["quantity"] for item in order_data["cart_items"]),
    )

    # Бонусы списываются в момент фактической оплаты (когда менеджер отдал заказ).
    if bonus_used > 0:
        await use_user_bonus(order_data["user_id"], bonus_used)

    if payment_method == "card":
        header = "ЗАКАЗ (💳 ОПЛАЧЕН КАРТОЙ)"
    else:
        header = "ЗАКАЗ (💵 НАЛИЧНЫЕ)"
    if order_number:
        header = f"{header} №{order_number}"

    del PENDING_ORDERS[order_key]

    try:
        await callback.bot.send_message(
            chat_id=order_data["user_id"],
            text=f"Спасибо за покупку🥰\nНомер заказа: {order_number}\nЖдем вас снова🛍" if order_number
            else "Спасибо за покупку🥰\nЖдем вас снова🛍"
        )
    except Exception:
        pass

    await callback.message.edit_text(
        text=f"{header}\n\n{order_data['final_checkout_text']}",
        parse_mode="HTML",
        reply_markup=None
    )
    await callback.answer("Успешно!")


@router.callback_query(F.data.startswith("reject_order:"), F.message.chat.id == int(manager_chat_id))
async def admin_reject_order(callback: CallbackQuery):
    order_key = callback.data.split(":")[1]

    order_data = PENDING_ORDERS.get(order_key)

    if order_data:
        del PENDING_ORDERS[order_key]

        # Заказ отклонён — если склад уже был зарезервирован (списан при создании
        # заказа/оплате картой), возвращаем товар обратно.
        if order_data.get("stock_reserved"):
            await restock_items(order_data["cart_items"])

        try:
            await callback.bot.send_message(chat_id=order_data["user_id"], text="❌ Ваш заказ был отменён менеджером\n"
                                                                                f"Оформите новый заказ или свяжитесь с менеджером: {MANAGER_CONTACT}")

        except Exception:
            pass

    await callback.message.edit_text(text="❌ <b>ЗАКАЗ ОТМЕНЕН</b>", parse_mode="HTML", reply_markup=None)
    await callback.answer("Заказ отменён")


def create_pending_card_order(
    *, user_id: int, username: str, cart_items: list, total_price: float,
    delivery_cost: float, order_type: str, location: str | None,
    final_checkout_text: str,
) -> None:
    """Оформление заказа картой из /api/order. Склад НЕ резервирует и номер НЕ
    присваивает — это происходит в /api/confirm-card-payment (server_api.py), когда юзер
    нажмёт «Я оплатил» в вебаппе. До этого передумавший клиент ничего не блокирует."""
    order_key = new_order_key()
    full_price = total_price + delivery_cost + SERVICE_FEE

    # Повторный выбор оплаты картой: прошлая незавершённая ссылка не должна остаться висеть.
    _drop_pending_card_orders(user_id)

    PENDING_ORDERS[order_key] = {
        "username": username,
        "user_id": user_id,
        "delivery_cost": delivery_cost,
        "total_price": total_price,
        "cart_items": cart_items,
        "final_checkout_text": final_checkout_text,
        "created_at": time.time(),
        "full_price": full_price,
        "payment_method": "card",
        "bonus_used": 0,
        "sent_to_manager": False,
        "stock_reserved": False,
        "order_number": None,
        "order_type": order_type,
        # Точка заказа (None у доставки) — для разбивки отчётов по менеджерам
        "location": location,
        # Статичная ссылка СБП — сумму юзер вбивает сам, ссылка не параметризуется.
        "pay_url": PAY_LINK,
    }


@router.message(Command("admin"), F.from_user.id.in_(admins_id))
async def admin_panel(message: Message):
    await message.answer("Админ-панель", reply_markup=admin_inline_keyboard(message.from_user.id))


@router.callback_query(F.data == "day_sum", F.from_user.id.in_(admins_id))
async def day_sum(callback: CallbackQuery):
    await callback.message.answer(await build_sales_report_text("day"), parse_mode="HTML")
    await callback.answer()


@router.callback_query(F.data == "week_sum", F.from_user.id.in_(admins_id))
async def week_sum(callback: CallbackQuery):
    await callback.message.answer(await build_sales_report_text("week"), parse_mode="HTML")
    await callback.answer()


@router.callback_query(F.data == "month_sum", F.from_user.id.in_(admins_id))
async def month_sum(callback: CallbackQuery):
    await callback.message.answer(await build_sales_report_text("month"), parse_mode="HTML")
    await callback.answer()


@router.callback_query(F.data == "quartal_sum", F.from_user.id.in_(admins_id))
async def quartal_sum(callback: CallbackQuery):
    await callback.message.answer(await build_sales_report_text("quarter"), parse_mode="HTML")
    await callback.answer()


class BroadcastState(StatesGroup):
    wait_for_message = State()

@router.callback_query(F.data == "broadcast", F.from_user.id.in_(admins_id))
async def start_broadcast(callback: CallbackQuery, state: FSMContext):
    await callback.message.answer(text="Введи текст для рассылки:")
    await state.set_state(BroadcastState.wait_for_message)
    await callback.answer()

@router.message(BroadcastState.wait_for_message)
async def broadcast_preview(message: Message, state: FSMContext):
    """Не шлём сразу: случайно пересланное сообщение ушло бы всем покупателям,
    а жалобы на спам — прямой путь к бану бота. Сначала превью + подтверждение."""
    await state.update_data(from_chat_id=message.chat.id, message_id=message.message_id)
    await message.answer("Превью рассылки выше. Отправить всем?", reply_markup=broadcast_confirm_keyboard())


@router.callback_query(F.data == "broadcast_cancel", F.from_user.id.in_(admins_id))
async def broadcast_cancel(callback: CallbackQuery, state: FSMContext):
    await state.clear()
    await callback.message.edit_text("Рассылка отменена")
    await callback.answer()


@router.callback_query(F.data == "broadcast_send", F.from_user.id.in_(admins_id))
async def broadcast_send(callback: CallbackQuery, state: FSMContext):
    data = await state.get_data()
    await state.clear()
    if "message_id" not in data:
        await callback.answer("Нечего отправлять", show_alert=True)
        return
    await callback.message.edit_text("Рассылка идёт…")
    await callback.answer()

    success = 0
    for user in await get_list_of_user_ids():
        for attempt in range(2):  # одна повторная попытка после flood-wait
            try:
                await bot.copy_message(chat_id=user, from_chat_id=data["from_chat_id"], message_id=data["message_id"])
                success += 1
            except TelegramRetryAfter as e:
                await asyncio.sleep(e.retry_after)
                continue
            except TelegramForbiddenError:
                pass
            except Exception as e:
                print(f"❌ Ошибка отправки юзеру {user}: {e}")
            break
        await asyncio.sleep(0.1)

    await callback.message.edit_text(f"<b>Рассылка завершена</b>\nУспешно дошло до {success} чел.", parse_mode="HTML")
