import hashlib
import hmac
from os import getenv

from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from dotenv import load_dotenv

from handlers.subscription import CHANNEL_URL

load_dotenv()

WEBAPP_URL = getenv("WEBAPP_URL", "")
if not WEBAPP_URL:
    raise ValueError("WEBAPP_URL не задан в .env — укажите https-адрес вебаппа (Telegram WebApp требует HTTPS)")
_WEBAPP_SECRET = (getenv("BOT_TOKEN") or "").encode()


def webapp_url_for(user_id: int) -> str:
    """Ссылка на вебапп с подписанным ID юзера: ?uid=<id>&sig=<hmac>.
    Бот знает ID в момент отрисовки кнопки, вебапп заберёт его из URL,
    а FastAPI примет этот ID только при валидной sig — иначе кто угодно
    мог бы подставить чужой ID и отправить заказ в чужой чат."""
    sig = hmac.new(_WEBAPP_SECRET, f"uid:{user_id}".encode(), hashlib.sha256).hexdigest()
    return f"{WEBAPP_URL}?uid={user_id}&sig={sig}"


def main_inline_keyboard_start(user_id: int):
    keyboard_1 = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="🛒 Каталог", web_app=WebAppInfo(url=webapp_url_for(user_id)))],
        [InlineKeyboardButton(text="❓ Частые вопросы", callback_data="help")]
    ])
    return keyboard_1


def subscribe_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📢 Канал", url=CHANNEL_URL)],
        [InlineKeyboardButton(text="✅ Я подписался", callback_data="check_sub")],
    ])


def admin_inline_keyboard(user_id: int):
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="Прибыль за день", callback_data="day_sum"), InlineKeyboardButton(text="Прибыль за неделю", callback_data=f"week_sum")],
        [InlineKeyboardButton(text="Прибыль за месяц", callback_data="month_sum"),
         InlineKeyboardButton(text="Прибыль за квартал", callback_data=f"quartal_sum")],
        [InlineKeyboardButton(text="Разослать уведомление", callback_data="broadcast"),],
        # ?admin=1 — вебапп открывает отдельный экран управления наличием
        # (+1/-1 по товарам); проверка прав всё равно на бэке (_require_admin),
        # это просто удобный вход.
        [InlineKeyboardButton(text="📦 Управление наличием", web_app=WebAppInfo(url=f"{webapp_url_for(user_id)}&admin=1"))],
    ])
    return keyboard

def broadcast_confirm_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Отправить всем", callback_data="broadcast_send"),
         InlineKeyboardButton(text="❌ Отмена", callback_data="broadcast_cancel")]
    ])

def admin_confirm_inline_keyboard(order_key: str) -> InlineKeyboardMarkup:
    keyboard_1 = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Заказ отдан", callback_data=f"confirm_order:{order_key}"), InlineKeyboardButton(text="❌ Отменить заказ", callback_data=f"reject_order:{order_key}")]
    ])
    return keyboard_1
