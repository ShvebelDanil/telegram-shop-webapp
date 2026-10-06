"""Доступ к боту и каталогу только для подписчиков канала REQUIRED_CHANNEL.
Модуль без роутера — его импортируют и handlers/routes.py, и server_api.py."""

import time
from os import getenv

from aiogram import Bot
from dotenv import load_dotenv

load_dotenv()

# @username публичного канала; пусто — проверка выключена. Бот должен быть админом
# канала, иначе getChatMember отдаёт ошибку и проверка пропускает всех (см. ниже).
REQUIRED_CHANNEL = getenv("REQUIRED_CHANNEL", "").strip()
CHANNEL_URL = f"https://t.me/{REQUIRED_CHANNEL.lstrip('@')}"

_SUBSCRIBED_TTL_SECONDS = 300
# Кэшируем только положительный ответ: отписка заметна через ≤5 минут, а подписка —
# сразу, по кнопке «Я подписался».
_subscribed_until: dict[int, float] = {}


async def is_subscribed(bot: Bot, user_id: int) -> bool:
    from handlers.routes import admins_id
    if not REQUIRED_CHANNEL or user_id in admins_id:
        return True
    if _subscribed_until.get(user_id, 0) > time.monotonic():
        return True
    try:
        member = await bot.get_chat_member(REQUIRED_CHANNEL, user_id)
    except Exception as exc:
        # Fail-open: сломанная проверка (бот не админ канала, сеть) не должна останавливать продажи.
        print(f"⚠️ Проверка подписки на {REQUIRED_CHANNEL} не удалась: {exc!r} — пропускаю {user_id}")
        return True
    subscribed = member.status in ("member", "administrator", "creator") or bool(getattr(member, "is_member", False))
    if subscribed:
        _subscribed_until[user_id] = time.monotonic() + _SUBSCRIBED_TTL_SECONDS
    return subscribed
