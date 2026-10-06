from aiogram import Bot
from aiogram.types import FSInputFile
from datetime import datetime, timedelta
import os
import time
import aiosqlite
from handlers.routes import PENDING_ORDERS, manager_chat_id, manager_topic_id
from handlers.reports import build_sales_report_text
from handlers.shop_dp import restock_items, SHOP_TZ

# Держим заказ зарезервированным ровно 24 часа с момента создания, пока менеджер
# не подтвердит — после этого возвращаем товар на склад. Не привязано к календарным
# суткам: заказ, оформленный в 23:50, живёт до следующего дня в 23:50, а не до 0:00.
PENDING_ORDER_TTL_SECONDS = 24 * 60 * 60


async def _expire_pending_order(bot: Bot, order_key: str, order_data: dict) -> None:
    """Убирает один заказ из PENDING_ORDERS: возвращает склад (если был зарезервирован),
    уведомляет клиента и менеджеров, что 24 часа истекли."""
    PENDING_ORDERS.pop(order_key, None)
    try:
        if order_data.get("stock_reserved"):
            await restock_items(order_data["cart_items"])
    except Exception as e:
        print(f"Ошибка возврата остатка для {order_key}: {e}")

    order_number = order_data.get("order_number")
    number_line = f"Номер заказа: {order_number}\n" if order_number else ""
    try:
        await bot.send_message(
            chat_id=order_data["user_id"],
            text=f"⏰ {number_line}Ваш заказ не был подтверждён менеджером в течение 24 часов и был отменён. "
                 "Пожалуйста, оформите заказ заново.",
        )
    except Exception:
        pass

    # Менеджеры видели только заказы, отправленные им в чат (наличные / «Я оплатил»).
    # Снимаем кнопки, иначе «Заказ отдан» на 25-й час выдал бы товар мимо склада и отчёта.
    manager_message_id = order_data.get("manager_message_id")
    if manager_message_id:
        try:
            await bot.edit_message_reply_markup(chat_id=manager_chat_id, message_id=manager_message_id, reply_markup=None)
        except Exception as e:
            print(f"Не удалось снять кнопки с заказа {order_key}: {e}")
        try:
            restock_note = ", товар возвращён на склад" if order_data.get("stock_reserved") else ""
            await bot.send_message(
                chat_id=manager_chat_id,
                message_thread_id=manager_topic_id,
                reply_to_message_id=manager_message_id,
                text=f"⏰ Заказ №{order_number} снят по сроку (24 часа){restock_note}.",
            )
        except Exception as e:
            print(f"Не удалось уведомить менеджеров об истечении {order_key}: {e}")


async def expire_stale_pending_orders(bot: Bot) -> None:
    """Каждые несколько минут проверяет PENDING_ORDERS и снимает резерв склада
    с заказов старше PENDING_ORDER_TTL_SECONDS (24ч от created_at) — клиент либо
    передумал, либо не успел оплатить картой. Единственная точка истечения заказов:
    никакого сброса в полночь, только возраст конкретного заказа."""
    now = time.time()
    stale_keys = [
        key for key, order_data in PENDING_ORDERS.items()
        if now - order_data.get("created_at", now) > PENDING_ORDER_TTL_SECONDS
    ]
    for key in stale_keys:
        order_data = PENDING_ORDERS.get(key)
        if order_data is not None:
            await _expire_pending_order(bot, key, order_data)


async def send_daily_report(bot: Bot, manager_chat_id: int):
    """Запускается в 00:00 (SHOP_TZ) и отчитывается за только что закончившийся день целиком."""
    try:
        yesterday = datetime.now(SHOP_TZ) - timedelta(days=1)
        report_text = await build_sales_report_text("day", at=yesterday, title="Автоматический отчёт за день")
        await bot.send_message(chat_id=manager_chat_id, text=report_text, parse_mode="HTML")
    except Exception as e:
        print(f"Ошибка отправления отчета {e}")


async def send_db_backup(bot: Bot, chat_id: int, db_path: str):
    """Раз в день шлёт консистентный снепшот БД в личку — на случай если сервер/аккаунт хостинга ляжет."""
    backup_path = f"{db_path}.backup"
    try:
        async with aiosqlite.connect(db_path) as source, aiosqlite.connect(backup_path) as dest:
            await source.backup(dest)

        current_date = datetime.now().strftime("%d/%m/%Y")
        await bot.send_document(
            chat_id=chat_id,
            document=FSInputFile(backup_path, filename=f"shop_backup_{current_date.replace('/', '-')}.db"),
            caption=f"💾 Бэкап БД за {current_date}",
        )
    except Exception as e:
        print(f"Ошибка отправления бэкапа БД: {e}")
    finally:
        if os.path.exists(backup_path):
            os.remove(backup_path)
