from aiogram import Dispatcher
import asyncio
from os import getenv

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from server_api import app, bot
import uvicorn

from aiogram.fsm.storage.memory import MemoryStorage
from dotenv import load_dotenv
from handlers.routes import router, manager_chat_id, admins_id
from handlers.shop_dp import init_db, seed_products, DB_NAME, SHOP_TZ
from handlers.cron import send_daily_report, send_db_backup, expire_stale_pending_orders

load_dotenv()
TOKEN = getenv("BOT_TOKEN")

if not TOKEN:
    raise ValueError("Токен не найден! Проверьте файл .env")

dp = Dispatcher(storage=MemoryStorage())
dp.include_router(router)


async def main():
    await init_db()
    await seed_products()

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=8000,
        loop="asyncio"
    )
    server = uvicorn.Server(config)

    asyncio.create_task(server.serve())
    print("FastAPI запущен на http://127.0.0.1:8000")

    await bot.delete_webhook(drop_pending_updates=True)

    scheduler = AsyncIOScheduler(timezone=SHOP_TZ)

    scheduler.add_job(send_daily_report, trigger="cron", hour=0, minute=0, kwargs={"bot": bot, "manager_chat_id": manager_chat_id})

    # Автовозврат резерва склада для забытых/неоплаченных заказов (TTL 24 часа).
    scheduler.add_job(expire_stale_pending_orders, trigger="interval", minutes=30, kwargs={"bot": bot})

    if admins_id:
        scheduler.add_job(send_db_backup, trigger="cron", hour=4, minute=0, kwargs={"bot": bot, "chat_id": admins_id[0], "db_path": DB_NAME})
    else:
        print("⚠️ ADMINS_ID пуст — бэкап БД не запланирован, некому слать")

    scheduler.start()

    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())