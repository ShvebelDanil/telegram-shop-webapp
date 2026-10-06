from handlers.shop_dp import LOCATION_NAMES, get_sales_report, period_bounds
from datetime import datetime, timedelta

# Каждая точка — свой менеджер: «Менеджер 1 (Кофейня в парке)», …
MANAGER_LABELS = {loc: f"Менеджер {i} ({name})" for i, (loc, name) in enumerate(LOCATION_NAMES.items(), 1)}

PERIOD_TITLES = {
    "day": "Выручка за день",
    "week": "Выручка за неделю",
    "month": "Выручка за месяц",
    "quarter": "Выручка за квартал",
}


def _fmt_rub(value) -> str:
    """Деньги без хвостов: 1234.0 → '1234', 1234.5 → '1234.50'."""
    value = round(float(value), 2)
    if value == int(value):
        return str(int(value))
    return f"{value:.2f}"


def _format_manager_block(label: str, row: dict) -> str:
    lines = [f"👤 {label}:"]
    lines.append(f"  💵 Оплата за наличные: {_fmt_rub(row['cash'])} руб")
    # По карте показываем сумму с учётом комиссии эквайринга (то, что реально на счёте)
    lines.append(f"  💳 Оплата по карте: {_fmt_rub(row['card_net'])} руб")
    if row["delivery"]:
        lines.append(f"  🚗 Доставка: {_fmt_rub(row['delivery'])} руб")
    lines.append(f"  ⚙️ Сервисный сбор: {_fmt_rub(row['service'])} руб")
    manager_total = row["cash"] + row["card_net"] + row["delivery"] + row["service"]
    lines.append(f"  💰 Итого: {_fmt_rub(manager_total)} руб")
    lines.append(f"  🧾 ЗП менеджера: {_fmt_rub(row['manager_pay'])} руб")
    return "\n".join(lines)


def format_sales_report(report: dict, title: str) -> str:
    """Готовый текст отчёта по менеджерам + общий итог."""
    parts = [f"📊 {title}", ""]
    for loc in LOCATION_NAMES:
        parts.append(_format_manager_block(MANAGER_LABELS[loc], report[loc]))
        parts.append("")

    total = report["total"]
    total_sum = total["cash"] + total["card_net"] + total["delivery"] + total["service"]
    parts.append(f"<b>Итого: {_fmt_rub(total_sum)} руб</b>")
    parts.append(f"🧾 ЗП менеджеров: {_fmt_rub(total['manager_pay'])} руб")
    return "\n".join(parts)


def _period_label(start: datetime, end: datetime) -> str:
    """«24.09.2026» для дня, «22.09.2026 – 24.09.2026» для остальных; конец — последний
    день периода, но не позже сегодняшнего (незаконченный период идёт до текущего момента)."""
    last_day = min(end - timedelta(days=1), datetime.now(start.tzinfo))
    first, last = start.strftime("%d.%m.%Y"), last_day.strftime("%d.%m.%Y")
    return first if first == last else f"{first} – {last}"


async def build_sales_report_text(period: str, at: datetime | None = None, title: str | None = None) -> str:
    """Отчёт за календарный период (day/week/month/quarter, SHOP_TZ), содержащий момент `at`."""
    start, end = period_bounds(period, at)
    report = await get_sales_report(start, end)
    title = f"{title or PERIOD_TITLES[period]} ({_period_label(start, end)})"
    return format_sales_report(report, title)
