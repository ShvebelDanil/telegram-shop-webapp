#!/usr/bin/env bash
# Готовит карту города для сервиса osrm (docker-compose.yml) в ./osrm-data.
# Запуск из корня проекта: bash osrm/prepare.sh
# Регион (выгрузка Geofabrik) и рамка города — переменными, по умолчанию Москва:
#   REGION_URL=https://download.geofabrik.de/russia/volga-fed-district-latest.osm.pbf \
#   BBOX=49.0,55.65,49.35,55.9 bash osrm/prepare.sh      # Казань
# Первый деплой и раз в несколько месяцев (свежая карта), затем: docker compose restart osrm
#
# Вырезка города укладывается в ~1 ГБ RAM. Если `free -h` показывает 1 ГБ и нет swap:
#   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
set -euo pipefail

OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1
REGION_URL=${REGION_URL:-https://download.geofabrik.de/russia/central-fed-district-latest.osm.pbf}
# Рамка города с пригородами: мин. долгота, мин. широта, макс. долгота, макс. широта
BBOX=${BBOX:-37.2,55.45,38.0,56.0}

DATA_DIR="$(pwd)/osrm-data"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

curl -fL -o region.osm.pbf "$REGION_URL"
command -v osmium >/dev/null || apt-get install -y osmium-tool
osmium extract -b "$BBOX" region.osm.pbf -o city.osm.pbf --overwrite
rm region.osm.pbf

docker run --rm -v "$DATA_DIR:/data" "$OSRM_IMAGE" osrm-extract -p /opt/car.lua /data/city.osm.pbf
docker run --rm -v "$DATA_DIR:/data" "$OSRM_IMAGE" osrm-partition /data/city.osrm
docker run --rm -v "$DATA_DIR:/data" "$OSRM_IMAGE" osrm-customize /data/city.osrm
rm city.osm.pbf

echo "Готово: $DATA_DIR/city.osrm*"
