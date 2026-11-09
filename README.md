# Nimbus Auth — Vercel + Neon

Бесплатная версия сервера аккаунтов Nimbus. Работает как serverless-функция на Vercel, данные хранит в PostgreSQL на Neon. API и формат ответов совпадают с `NimbusAuthServer`, поэтому лаунчер и сайт работают без изменений.

## Что нужно

- Аккаунт [Vercel](https://vercel.com) — бесплатный Hobby, карта не нужна.
- Аккаунт [Neon](https://neon.com) — бесплатный план, карта не нужна.

## 1. База данных Neon

1. Зарегистрируйся на Neon и создай проект, например `nimbus`.
2. Открой **Dashboard → Connection Details**.
3. Скопируй строку подключения вида:

```
postgresql://user:password@ep-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Таблицы создадутся сами при первом запросе к API.

## 2. Деплой на Vercel

1. Открой [vercel.com/new](https://vercel.com/new) и импортируй репозиторий `nimbus-auth-vercel`.
2. Framework Preset: **Other**. Build Command и Output Directory оставь пустыми.
3. В **Environment Variables** добавь:
   - `DATABASE_URL` = строка подключения из Neon.
4. Нажми **Deploy**.
5. Получишь адрес вида `https://nimbus-auth.vercel.app`.

Проверка:

```
https://nimbus-auth.vercel.app/api/health
```

Ответ:

```json
{"ok":true,"service":"nimbus-auth","version":1,"storage":"neon"}
```

## API

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/health` | проверка работы |
| POST | `/api/register` | `{username, password, repeat}` → токен и пользователь |
| POST | `/api/login` | `{username, password}` → токен и пользователь |
| GET | `/api/me` | заголовок `Authorization: Bearer <токен>` → пользователь |
| POST | `/api/logout` | завершает сессию |

Пароли хранятся как scrypt-хэш. UUID совпадает с оффлайн-UUID Minecraft. Сессия живёт 30 дней. После 8 неверных попыток вход блокируется на 15 минут, регистрация с одного IP ограничена 10 в час.

## Переменные окружения

| Переменная | Обязательна | Что делает |
|---|---|---|
| `DATABASE_URL` | да | строка подключения Neon |

Поддерживаются также `POSTGRES_URL` и `NEON_DATABASE_URL` — удобно, если база подключена через интеграцию Vercel.

## Ограничения бесплатных планов

- Vercel Hobby: 1 млн вызовов функций, 4 CPU-часа и 100 ГБ трафика в месяц.
- Neon Free: 1 ГБ хранилища, 100 CU-часов в месяц, вычисления засыпают после 5 минут простоя и просыпаются за полсекунды.

Для аккаунтов лаунчера этого достаточно с большим запасом.

## Резервная копия

В Neon: **Project → Backups → Create backup** или `pg_dump` со строкой подключения. Аккаунты и сессии лежат в таблицах `accounts` и `sessions`.
