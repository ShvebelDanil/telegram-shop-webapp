"""Расчёт стоимости доставки для /api/delivery-cost (preview) и /api/order
(авторитетный пересчёт при оформлении). Модуль не тянет aiogram — безопасно
импортировать и из handlers/routes.py, и из server_api.py без риска цикла."""

import aiohttp
from os import getenv
from dotenv import load_dotenv
from geopy.distance import geodesic

load_dotenv()

MAP_TOKEN = getenv("YANDEX_TOKEN")
CITY_NAME = getenv("CITY_NAME", "Москва")


def _parse_shop_coord(raw: str | None) -> tuple[float, float]:
    """SHOP_COORD из .env: "широта, долгота". Падаем на старте, если криво —
    лучше уронить процесс при деплое, чем молча считать доставку от (0, 0)."""
    if not raw:
        raise ValueError("SHOP_COORD не задан в .env (пример: SHOP_COORD=\"54.934868, 73.380924\")")
    try:
        lat_raw, lon_raw = (part.strip() for part in raw.split(","))
        lat, lon = float(lat_raw), float(lon_raw)
    except ValueError as exc:
        raise ValueError(f"SHOP_COORD задан неверно: {raw!r} (ожидается \"широта, долгота\")") from exc
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise ValueError(f"SHOP_COORD вне допустимого диапазона: {raw!r}")
    return (lat, lon)


shop_coord = _parse_shop_coord(getenv("SHOP_COORD"))

start_delivery_price = 150
price_per_km = 50

# Свой OSRM (сервис osrm в docker-compose, карта города из OpenStreetMap) —
# расстояние по дорогам без внешних ключей. Если он лёг — прямая × ROAD_FACTOR
# (средний коэффициент извилистости городских маршрутов).
OSRM_URL = getenv("OSRM_URL", "http://osrm:5000")
ROAD_FACTOR = 1.4


async def _road_km(session: aiohttp.ClientSession, a: tuple[float, float], b: tuple[float, float]) -> float:
    """Длина маршрута на машине между (lat, lon) точками, км."""
    # OSRM ждёт координаты в порядке lon,lat.
    url = f"{OSRM_URL}/route/v1/driving/{a[1]},{a[0]};{b[1]},{b[0]}"
    try:
        async with session.get(url, params={"overview": "false"}, timeout=aiohttp.ClientTimeout(total=3)) as resp:
            data = await resp.json()
        if data.get("code") != "Ok":
            raise ValueError(data.get("code"))
        return data["routes"][0]["distance"] / 1000
    except Exception as exc:
        print(f"OSRM недоступен ({exc!r}), считаем по прямой × {ROAD_FACTOR}")
        return geodesic(a, b).kilometers * ROAD_FACTOR


async def compute_delivery_cost(address: str) -> tuple[float, int]:
    """(distance_km, delivery_cost). Любая проблема — геокодинг не нашёл адрес,
    адрес слишком общий (город/район), сеть легла — гасится в один и тот же
    фолбэк: 0.0 / 250. Никогда не бросает наружу,
    чтобы флап Яндекс-API не валил оформление заказа."""
    base_url = "https://geocode-maps.yandex.ru/1.x/"
    params = {
        "apikey": MAP_TOKEN,
        "geocode": f"{CITY_NAME}, {address}",
        "format": "json"
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(base_url, params=params) as resp:
                if resp.status != 200:
                    raise Exception(f"Сервис недоступен: {resp.status}")

                data = await resp.json()
                feature_member = data["response"]["GeoObjectCollection"]["featureMember"]

                if not feature_member:
                    raise ValueError("address_not_found")

                geo_obj = feature_member[0]["GeoObject"]
                kind = geo_obj["metaDataProperty"]["GeocoderMetaData"].get("kind")
                if kind in ("locality", "district"):
                    raise ValueError("address_too_vague")

                coord_str = geo_obj["Point"]["pos"]
                lon, lat = map(float, coord_str.split())
                user_coord = (lat, lon)

            distance = round(await _road_km(session, shop_coord, user_coord), 1)
            if distance < 3:
                delivery_cost = start_delivery_price
            else:
                delivery_cost = round(distance * price_per_km)
            return distance, delivery_cost
    except Exception:
        import traceback
        print("Ошибка геокодирования")
        traceback.print_exc()
        return 0.0, 250
