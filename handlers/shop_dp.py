import aiosqlite
from os import getenv
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

load_dotenv()

DB_NAME = getenv("DB_NAME", "shop.db")

# orders.time хранится как SQLite CURRENT_TIMESTAMP — это всегда UTC. Бизнес-«сегодня»
# для менеджеров — локальное время магазина, поэтому date('now') в SQL врёт на
# несколько часов около полуночи. Границы считаем в Python и передаём готовые UTC-строки.
SHOP_TZ = ZoneInfo(getenv("SHOP_TZ", "Europe/Moscow"))


PERIODS = ("day", "week", "month", "quarter")


def period_bounds(period: str, at: datetime | None = None) -> tuple[datetime, datetime]:
    """Календарный период в SHOP_TZ, содержащий момент `at` (по умолчанию — сейчас):
    [начало, конец) — день с 00:00, неделя с понедельника, месяц с 1-го, квартал
    с 1 янв/апр/июл/окт. Незаконченный период естественно обрывается на «сейчас» —
    будущих заказов в БД нет."""
    at = (at or datetime.now(SHOP_TZ)).astimezone(SHOP_TZ)
    day = at.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "day":
        return day, day + timedelta(days=1)
    if period == "week":
        start = day - timedelta(days=day.weekday())
        return start, start + timedelta(days=7)
    if period in ("month", "quarter"):
        months = 1 if period == "month" else 3
        first_month = day.month if period == "month" else (day.month - 1) // 3 * 3 + 1
        start = day.replace(month=first_month, day=1)
        end_month = first_month + months
        end = start.replace(year=start.year + (end_month - 1) // 12, month=(end_month - 1) % 12 + 1)
        return start, end
    raise ValueError(f"unknown period: {period}")


def _to_utc_str(dt: datetime) -> str:
    return dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%d %H:%M:%S")


# Точки продаж. Каждая — отдельный склад и отдельный менеджер в отчётах.
# Доставка всегда едет с DELIVERY_LOCATION. Ключи должны совпадать с webapp/src/shop.ts.
LOCATION_PARK = "park"
LOCATION_CENTER = "center"
DELIVERY_LOCATION = LOCATION_CENTER

LOCATION_NAMES = {
    LOCATION_PARK: "Кофейня в парке",
    LOCATION_CENTER: "Кофейня в центре",
}
_LOCATION_DIGITS = {LOCATION_PARK: "1", LOCATION_CENTER: "2"}


def compute_order_number(order_type: str, location: str | None, seq: int) -> str:
    """9-значный номер заказа: [точка][тип][7-значный сквозной счётчик].
    Тип: 1=доставка, 0=самовывоз. У доставки точка — DELIVERY_LOCATION."""
    point = DELIVERY_LOCATION if order_type == "delivery" else location
    location_digit = _LOCATION_DIGITS.get(point, "0")
    type_digit = "1" if order_type == "delivery" else "0"
    return f"{location_digit}{type_digit}{seq:07d}"


async def init_db():
    async with aiosqlite.connect(DB_NAME) as db:
        await db.execute("""
        CREATE TABLE IF NOT EXISTS shop (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        variant TEXT,
        tag INTEGER,
        count INTEGER NOT NULL,
        price INTEGER NOT NULL,
        url TEXT,
        location TEXT NOT NULL
        )""")
        await db.execute("""
        CREATE TABLE IF NOT EXISTS users (
        user_id TEXT NOT NULL UNIQUE,
        phone TEXT,
        bonus_balance INTEGER DEFAULT 0
        )""")
        await db.execute("""
        CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        payment_type TEXT NOT NULL,
        cash_amount INTEGER DEFAULT 0,
        card_amount INTEGER DEFAULT 0,
        amount INTEGER NOT NULL,
        delivery_amount INTEGER,
        service_amount INTEGER,
        location TEXT,
        order_number TEXT,
        manager_pay INTEGER DEFAULT 0,
        time TEXT DEFAULT CURRENT_TIMESTAMP
        )""")
        await db.execute("""
        CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
        )""")
        # Сквозной счётчик номеров заказов (см. get_next_order_seq).
        await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ("order_seq", "0"))
        await db.commit()


PRODUCT_COLUMNS = ("id", "name", "type", "variant", "count", "price", "url", "location")
_PRODUCT_SELECT = f"SELECT {', '.join(PRODUCT_COLUMNS)} FROM shop"


async def get_products(location: str):
    """Наличие конкретной точки. Поле location обязательно в ответе — по нему вебапп
    чистит корзину при смене точки."""
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute(f"{_PRODUCT_SELECT} WHERE location = ? ORDER BY id", (location,))
        return [dict(zip(PRODUCT_COLUMNS, row)) for row in await cursor.fetchall()]


def normalize_phone(raw_phone: str) -> str | None:
    """Валидация/нормализация телефона: 10 цифр -> +7XXXXXXXXXX, 11 начиная с 8 ->
    +7..., иначе (11 цифр) -> +digits. None, если цифр не 10 и не 11."""
    digits = re.sub(r"\D", "", raw_phone or "")
    if len(digits) not in (10, 11):
        return None
    if len(digits) == 10:
        return f"+7{digits}"
    if digits.startswith("8"):
        return f"+7{digits[1:]}"
    return f"+{digits}"


async def add_user(user_id, phone):
    # Явный UPSERT: INSERT OR REPLACE удалил бы строку целиком вместе с бонусным балансом.
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute("SELECT user_id FROM users WHERE user_id = ?", (str(user_id),))
        if await cursor.fetchone():
            await db.execute("UPDATE users SET phone = ? WHERE user_id = ?", (phone, str(user_id)))
        else:
            await db.execute("INSERT INTO users (user_id, phone) VALUES (?, ?)", (str(user_id), phone))
        await db.commit()


async def get_user_bonus_balance(user_id) -> int:
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute("SELECT bonus_balance FROM users WHERE user_id = ?", (str(user_id),))
        row = await cursor.fetchone()
        if not row or row[0] is None:
            return 0
        return int(row[0])


async def _ensure_user_row(db, user_id):
    """Гарантирует ровно одну строку юзера (user_id — UNIQUE)."""
    cursor = await db.execute("SELECT 1 FROM users WHERE user_id = ?", (str(user_id),))
    if await cursor.fetchone() is None:
        await db.execute("INSERT INTO users (user_id, phone, bonus_balance) VALUES (?, NULL, 0)", (str(user_id),))


async def add_user_bonus(user_id, bonus_amount: int):
    async with aiosqlite.connect(DB_NAME) as db:
        await _ensure_user_row(db, user_id)
        await db.execute(
            "UPDATE users SET bonus_balance = bonus_balance + ? WHERE user_id = ?",
            (int(bonus_amount), str(user_id))
        )
        await db.commit()


async def use_user_bonus(user_id, bonus_amount: int):
    async with aiosqlite.connect(DB_NAME) as db:
        await _ensure_user_row(db, user_id)
        await db.execute(
            "UPDATE users SET bonus_balance = MAX(bonus_balance - ?, 0) WHERE user_id = ?",
            (int(bonus_amount), str(user_id))
        )
        await db.commit()


async def get_phone_number(user_id) -> str | None:
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute("SELECT phone FROM users WHERE user_id = ?", (str(user_id),))
        result = await cursor.fetchone()
        return result[0] if result else None


# ЗП менеджера за одну отданную единицу товара по категории (shop.type).
MANAGER_PAY_PER_UNIT = {"coffee": 15, "tea": 15, "dessert": 10, "beans": 50}


def manager_pay_per_unit(product_type: str) -> int:
    return MANAGER_PAY_PER_UNIT.get(product_type, 0)


async def add_order(amount, payment_type, user_id, delivery_amount, service_amount, location=None, order_number=None,
                    manager_pay=0):
    """Записывает выданный заказ. location — точка для разбивки отчётов по менеджерам
    (у доставки None), manager_pay — ЗП менеджера за этот заказ, фиксируется в момент выдачи."""
    cash_amount = amount if payment_type == "cash" else 0
    card_amount = amount if payment_type == "card" else 0
    async with aiosqlite.connect(DB_NAME) as db:
        await db.execute(
            "INSERT INTO orders (amount, payment_type, cash_amount, card_amount, user_id, delivery_amount, service_amount, location, order_number, manager_pay) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (amount, payment_type, cash_amount, card_amount, user_id, delivery_amount, service_amount, location, order_number, manager_pay))
        await db.commit()


CARD_ACQUIRING_FEE = 0.97  # комиссия эквайринга: на счёт падает 97% от оплаты картой


def _empty_sales_row() -> dict:
    return {"cash": 0, "card": 0, "card_net": 0.0, "delivery": 0, "service": 0, "manager_pay": 0}


async def get_sales_report(start: datetime, end: datetime) -> dict:
    """Сводка выручки за [start, end) по точкам (менеджерам):
    {<location>: {"cash", "card", "card_net", "delivery", "service", "manager_pay"}, ..., "total": {...}}.

    card_net = card * CARD_ACQUIRING_FEE (что фактически приходит на счёт).
    Доставка и заказы без точки засчитываются DELIVERY_LOCATION."""
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute(
            """
            SELECT COALESCE(NULLIF(location, ''), ?) AS loc,
                   SUM(cash_amount) AS cash,
                   SUM(card_amount) AS card,
                   SUM(COALESCE(delivery_amount, 0)) AS delivery,
                   SUM(COALESCE(service_amount, 0)) AS service,
                   SUM(COALESCE(manager_pay, 0)) AS manager_pay
            FROM orders
            WHERE time >= ? AND time < ?
            GROUP BY loc
            """,
            (DELIVERY_LOCATION, _to_utc_str(start), _to_utc_str(end)),
        )
        rows = await cursor.fetchall()

    report = {loc: _empty_sales_row() for loc in LOCATION_NAMES}
    for loc, cash, card, delivery, service, manager_pay in rows:
        bucket = report.get(loc, report[DELIVERY_LOCATION])
        bucket["cash"] += cash or 0
        bucket["card"] += card or 0
        bucket["delivery"] += delivery or 0
        bucket["service"] += service or 0
        bucket["manager_pay"] += manager_pay or 0

    for bucket in report.values():
        bucket["card_net"] = round(bucket["card"] * CARD_ACQUIRING_FEE, 2)

    total = _empty_sales_row()
    for bucket in report.values():
        for key in total:
            total[key] = round(total[key] + bucket[key], 2)
    report["total"] = total
    return report


async def get_list_of_user_ids():
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute("SELECT DISTINCT user_id FROM orders")
        return [row[0] for row in await cursor.fetchall()]


async def reduce_query(cart_items: list):
    """Списывает товары со склада всё-или-ничего. Возвращает список id, которых не хватило
    на складе; если он не пуст — вся транзакция откатывается, склад не меняется."""
    shortages = []
    async with aiosqlite.connect(DB_NAME) as db:
        for item in cart_items:
            product_id = item["id"]
            ordered_quantity = item["quantity"]

            cursor = await db.execute(
                "UPDATE shop SET count = count - ? WHERE id = ? AND count >= ?",
                (ordered_quantity, product_id, ordered_quantity),
            )
            if cursor.rowcount == 0:
                shortages.append(product_id)
        if shortages:
            await db.rollback()
        else:
            await db.commit()
    return shortages


async def restock_items(cart_items: list) -> None:
    """Возвращает товары на склад — обратная операция к reduce_query: при отклонении
    заказа менеджером или при истечении неподтверждённого заказа."""
    async with aiosqlite.connect(DB_NAME) as db:
        for item in cart_items:
            await db.execute(
                "UPDATE shop SET count = count + ? WHERE id = ?",
                (item["quantity"], item["id"]),
            )
        await db.commit()


async def adjust_stock(product_id: int, delta: int) -> int:
    """Ручная правка остатка из админ-вебаппа (+1/-1). Атомарно меняет count на delta,
    не даёт уйти в минус. Возвращает новый остаток; ValueError, если товара нет."""
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute("SELECT id FROM shop WHERE id = ?", (product_id,))
        if await cursor.fetchone() is None:
            raise ValueError("product_not_found")
        await db.execute(
            "UPDATE shop SET count = MAX(count + ?, 0) WHERE id = ?", (delta, product_id)
        )
        cursor = await db.execute("SELECT count FROM shop WHERE id = ?", (product_id,))
        row = await cursor.fetchone()
        await db.commit()
        return row[0]


async def get_recommendations(tag: int, location: str):
    """Квиз «Подобрать напиток»: до трёх разных товаров с этим tag в наличии в точке заказа,
    у каждого — первый вариант в наличии (иначе выдача забивалась объёмами одного напитка).
    Точка обязательна: корзина привязана к одной точке, товар из другой туда не добавить."""
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute(
            f"""{_PRODUCT_SELECT} WHERE id IN (
                    SELECT MIN(id) FROM shop WHERE tag = ? AND location = ? AND count > 0 GROUP BY name
                ) ORDER BY RANDOM() LIMIT 3""",
            (tag, location),
        )
        return [dict(zip(PRODUCT_COLUMNS, row)) for row in await cursor.fetchall()]


async def get_next_order_seq() -> int:
    """Атомарно увеличивает и возвращает следующий номер заказа (settings.order_seq).
    SQLite сериализует писателей на уровне файла — UPDATE+SELECT в одном соединении
    гонки не создаёт."""
    async with aiosqlite.connect(DB_NAME) as db:
        await db.execute(
            "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'order_seq'"
        )
        cursor = await db.execute("SELECT value FROM settings WHERE key = 'order_seq'")
        row = await cursor.fetchone()
        await db.commit()
        return int(row[0])


# --- Демо-меню -------------------------------------------------------------
# tag — ответ на квиз «Подобрать напиток», три цифры: вкус (1 классика, 2 молочный,
# 3 сладкий) · крепость (1 мягкий, 2 средний, 3 бодрящий) · бюджет (1 до 250 ₽, 2 любой).
# Варианты одного товара (объём, вкус) — отдельные строки с одинаковым name.
DEMO_MENU = [
    # (name, type, tag, [(variant, price), ...])
    ("Эспрессо", "coffee", 131, [("30 мл", 150), ("60 мл", 200)]),
    ("Американо", "coffee", 121, [("250 мл", 180), ("350 мл", 220)]),
    ("Капучино", "coffee", 221, [("250 мл", 220), ("350 мл", 270), ("450 мл", 320)]),
    ("Латте", "coffee", 221,[("250 мл", 230), ("350 мл", 280), ("450 мл", 330)]),
    ("Флэт уайт", "coffee", 232, [("250 мл", 260)]),
    ("Раф ванильный", "coffee", 312, [("350 мл", 320), ("450 мл", 370)]),
    ("Латте «Солёная карамель»", "coffee", 322, [("350 мл", 330), ("450 мл", 380)]),
    ("Колд брю", "coffee", 132, [("350 мл", 290)]),
    ("Чай листовой", "tea", 111, [("Эрл Грей", 200), ("Сенча", 200), ("Молочный улун", 230)]),
    ("Какао с маршмеллоу", "tea", 311, [("350 мл", 250)]),
    ("Матча латте", "tea", 212, [("350 мл", 310)]),
    ("Лимонад", "tea", 312, [("Манго-маракуйя", 270), ("Клубника-базилик", 270)]),
    ("Круассан", "dessert", None, [("Классический", 150), ("Миндальный", 210), ("С ветчиной и сыром", 250)]),
    ("Чизкейк", "dessert", None, [("Нью-Йорк", 290), ("Солёная карамель", 310)]),
    ("Тирамису", "dessert", None, [(None, 320)]),
    ("Печенье", "dessert", None, [("Шоколадное", 120), ("Овсяное", 110)]),
    ("Бразилия Моджиана", "beans", None, [("250 г", 650), ("1 кг", 2200)]),
    ("Эфиопия Иргачеффе", "beans", None, [("250 г", 890), ("1 кг", 3100)]),
    ("Колумбия Декаф", "beans", None, [("250 г", 790)]),
]
_DEMO_STOCK = {"coffee": 50, "tea": 40, "dessert": 8, "beans": 5}
# Несколько позиций «нет в наличии», чтобы в демо было видно и это состояние.
_DEMO_SOLD_OUT = {(LOCATION_PARK, "Тирамису", None), (LOCATION_PARK, "Эфиопия Иргачеффе", "1 кг"),
                  (LOCATION_CENTER, "Лимонад", "Клубника-базилик")}


async def seed_products():
    """Заполняет каталог демо-меню, только если таблица shop пуста —
    уже сохранённое наличие никогда не трогает."""
    async with aiosqlite.connect(DB_NAME) as db:
        cursor = await db.execute("SELECT COUNT(*) FROM shop")
        if (await cursor.fetchone())[0]:
            return
        rows = [
            (name, product_type, variant, tag,
             0 if (location, name, variant) in _DEMO_SOLD_OUT else _DEMO_STOCK[product_type],
             price, f"/img/{product_type}.svg", location)
            for location in LOCATION_NAMES
            for name, product_type, tag, variants in DEMO_MENU
            for variant, price in variants
        ]
        await db.executemany(
            "INSERT INTO shop (name, type, variant, tag, count, price, url, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        await db.commit()
        print(f"Каталог заполнен демо-меню, строк: {len(rows)}")
