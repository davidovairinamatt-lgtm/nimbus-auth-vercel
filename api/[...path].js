const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const SESSION_DAYS = 30;
const MAX_BODY = 16 * 1024;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 128;
const DAY = 24 * 60 * 60 * 1000;

const failures = new Map();
const hits = new Map();

let sqlClient = null;
let schemaPromise = null;

function databaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    ''
  );
}

function sql() {
  if (!sqlClient) {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL is not set');
    sqlClient = neon(url);
  }
  return sqlClient;
}

/** Creates the two tables on first request; safe to call concurrently. */
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const q = sql();
      await q`CREATE TABLE IF NOT EXISTS accounts (
        username_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        last_login BIGINT NOT NULL,
        failed_count INTEGER NOT NULL DEFAULT 0,
        failed_at BIGINT NOT NULL DEFAULT 0
      )`;
      await q`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username_key TEXT NOT NULL,
        expires BIGINT NOT NULL
      )`;
      await q`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** Same UUID Minecraft derives for offline-mode players. */
function offlineUuid(name) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function limited(map, key, max, windowMs) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  map.set(key, list);
  return list.length > max;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    try {
      return Promise.resolve(req.body ? JSON.parse(req.body) : {});
    } catch {
      return Promise.reject(new Error('bad json'));
    }
  }
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_BODY) {
      reject(new Error('too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function checkCredentials({ username, password, repeat }, isRegister) {
  const name = String(username || '').trim();
  const pass = String(password || '');
  if (!NAME_RE.test(name)) {
    return { error: 'Ник: от 3 до 16 символов, только латиница, цифры и _' };
  }
  if (pass.length < MIN_PASSWORD || pass.length > MAX_PASSWORD) {
    return { error: `Пароль: от ${MIN_PASSWORD} до ${MAX_PASSWORD} символов` };
  }
  if (isRegister && pass !== String(repeat || '')) {
    return { error: 'Пароли не совпадают' };
  }
  return { name, pass };
}

function userView(record) {
  return {
    username: record.display_name,
    uuid: offlineUuid(record.display_name),
    createdAt: Number(record.created_at)
  };
}

function bearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createSession(q, key) {
  const token = newToken();
  const now = Date.now();
  await q`INSERT INTO sessions (token, username_key, expires) VALUES (${token}, ${key}, ${now + SESSION_DAYS * DAY})`;
  return token;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, service: 'nimbus-auth', version: 1, storage: 'neon' });
    }

    await ensureSchema();
    const q = sql();
    const now = Date.now();
    const ip = clientIp(req);

    if (req.method === 'POST' && path === '/api/register') {
      if (limited(hits, `reg:${ip}`, 10, 60 * 60 * 1000)) {
        return send(res, 429, { ok: false, error: 'Слишком много регистраций с этого адреса, попробуй позже' });
      }
      const body = await readBody(req);
      const check = checkCredentials(body, true);
      if (check.error) return send(res, 400, { ok: false, error: check.error });

      const key = check.name.toLowerCase();
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(check.pass, salt);
      const inserted = await q`
        INSERT INTO accounts (username_key, display_name, salt, hash, created_at, last_login)
        VALUES (${key}, ${check.name}, ${salt}, ${hash}, ${now}, ${now})
        ON CONFLICT (username_key) DO NOTHING
        RETURNING username_key
      `;
      if (!inserted.length) {
        return send(res, 409, { ok: false, error: 'Этот ник уже занят' });
      }

      await q`DELETE FROM sessions WHERE expires < ${now}`;
      const token = await createSession(q, key);
      return send(res, 201, {
        ok: true,
        token,
        user: userView({ display_name: check.name, created_at: now })
      });
    }

    if (req.method === 'POST' && path === '/api/login') {
      if (limited(hits, `login:${ip}`, 60, 10 * 60 * 1000)) {
        return send(res, 429, { ok: false, error: 'Слишком много запросов, подожди несколько минут' });
      }
      const body = await readBody(req);
      const check = checkCredentials(body, false);
      if (check.error) return send(res, 400, { ok: false, error: check.error });

      const key = check.name.toLowerCase();
      const rows = await q`
        SELECT display_name, salt, hash, created_at, failed_count, failed_at
        FROM accounts WHERE username_key = ${key}
      `;
      const record = rows[0];
      if (!record) {
        return send(res, 401, { ok: false, error: 'Неверный ник или пароль' });
      }

      const failedAt = Number(record.failed_at || 0);
      const windowStart = now - 15 * 60 * 1000;
      if (failedAt > windowStart && Number(record.failed_count) >= 8) {
        return send(res, 429, { ok: false, error: 'Слишком много неверных попыток. Подожди 15 минут' });
      }

      const given = Buffer.from(hashPassword(check.pass, record.salt), 'hex');
      const expected = Buffer.from(record.hash, 'hex');
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        const count = failedAt > windowStart ? Number(record.failed_count) + 1 : 1;
        await q`UPDATE accounts SET failed_count = ${count}, failed_at = ${now} WHERE username_key = ${key}`;
        return send(res, 401, { ok: false, error: 'Неверный ник или пароль' });
      }

      await q`UPDATE accounts SET failed_count = 0, failed_at = 0, last_login = ${now} WHERE username_key = ${key}`;
      await q`DELETE FROM sessions WHERE expires < ${now}`;
      const token = await createSession(q, key);
      return send(res, 200, { ok: true, token, user: userView(record) });
    }

    if (req.method === 'GET' && path === '/api/me') {
      const token = bearer(req);
      if (!token) return send(res, 401, { ok: false, error: 'Сессия истекла, войди снова' });
      const rows = await q`
        SELECT a.display_name, a.created_at
        FROM sessions s
        JOIN accounts a ON a.username_key = s.username_key
        WHERE s.token = ${token} AND s.expires > ${now}
      `;
      if (!rows.length) {
        return send(res, 401, { ok: false, error: 'Сессия истекла, войди снова' });
      }
      return send(res, 200, { ok: true, user: userView(rows[0]) });
    }

    if (req.method === 'POST' && path === '/api/logout') {
      const token = bearer(req);
      if (token) {
        await q`DELETE FROM sessions WHERE token = ${token}`;
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { ok: false, error: 'Нет такого адреса' });
  } catch (error) {
    if (error.message === 'bad json' || error.message === 'too large') {
      return send(res, 400, { ok: false, error: 'Некорректный запрос' });
    }
    if (error.message === 'DATABASE_URL is not set') {
      console.error('[auth] DATABASE_URL is not set');
      return send(res, 503, { ok: false, error: 'База данных не подключена' });
    }
    console.error('[auth]', error);
    return send(res, 500, { ok: false, error: 'Внутренняя ошибка сервера' });
  }
};
