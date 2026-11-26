// auth-service: cadastro, login e emissão de tokens JWT.
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { logger, client, httpLogger, metricsMiddleware, metricsHandler, retry } = require('./lib/observability');
const { HttpError, requireAuth, notFound, errorHandler, start } = require('./lib/http');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const loginAttempts = new client.Counter({
  name: 'auth_logins_total',
  help: 'Tentativas de login por resultado',
  labelNames: ['result'],
});
const registrations = new client.Counter({
  name: 'auth_registrations_total',
  help: 'Usuários cadastrados',
});

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO auth.users (name, email, password_hash, role)
       VALUES ('Administrador', $1, $2, 'admin') ON CONFLICT (email) DO NOTHING`,
      [ADMIN_EMAIL.toLowerCase(), hash],
    );
  }
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

function signToken(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '8h' },
  );
}

const app = express();
app.use(express.json());
app.use(httpLogger);
app.use(metricsMiddleware);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'database unavailable' });
  }
});
app.get('/metrics', metricsHandler);

app.post('/register', async (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string'
      || !name.trim() || !email.includes('@')) {
    throw new HttpError(400, 'Informe nome, e-mail válido e senha');
  }
  if (password.length < 6) throw new HttpError(400, 'A senha deve ter pelo menos 6 caracteres');

  const hash = await bcrypt.hash(password, 10);
  let user;
  try {
    const { rows } = await pool.query(
      'INSERT INTO auth.users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), email.trim().toLowerCase(), hash],
    );
    [user] = rows;
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'E-mail já cadastrado');
    throw err;
  }

  registrations.inc();
  req.log.info({ userId: user.id }, 'usuário cadastrado');
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'Informe e-mail e senha');
  }

  const { rows } = await pool.query('SELECT * FROM auth.users WHERE email = $1', [email.trim().toLowerCase()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    loginAttempts.inc({ result: 'failure' });
    req.log.warn({ email: email.trim().toLowerCase() }, 'falha de login');
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }

  loginAttempts.inc({ result: 'success' });
  req.log.info({ userId: user.id }, 'login realizado');
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM auth.users WHERE id = $1', [req.user.sub]);
  if (!rows[0]) throw new HttpError(404, 'Usuário não encontrado');
  res.json(publicUser(rows[0]));
});

app.use(notFound);
app.use(errorHandler);

retry(migrate, { name: 'PostgreSQL' })
  .then(() => start(app, PORT, () => pool.end()))
  .catch((err) => {
    logger.fatal({ err }, 'falha ao iniciar o serviço');
    process.exit(1);
  });
