FROM node:20-alpine AS frontend-builder

WORKDIR /app/webapp

COPY webapp/package*.json ./

RUN npm ci

COPY webapp/ ./

RUN npm run build


FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN rm -rf /app/webapp

COPY --from=frontend-builder /app/webapp/dist /app/webapp/dist

EXPOSE 8000

# main.py поднимает и uvicorn (FastAPI + статика вебаппа), и aiogram-бота.
# server_api.py сам по себе сервер не запускает — контейнер бы просто завершился.
CMD ["python", "main.py"]