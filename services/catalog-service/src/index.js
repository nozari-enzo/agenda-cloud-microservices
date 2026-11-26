// catalog-service: serviços oferecidos (corte, barba...) e profissionais.
const express = require('express');
const { Pool } = require('pg');
const { logger, httpLogger, metricsMiddleware, metricsHandler, retry } = require('./lib/observability');
const { HttpError, requireAdmin, notFound, errorHandler, start } = require('./lib/http');

const PORT = Number(process.env.PORT || 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const SEED_SERVICES = [
  ['Corte de cabelo', 'Corte masculino ou feminino com lavagem', 30, 50],
  ['Barba', 'Barba com toalha quente', 30, 35],
  ['Coloração', 'Coloração completa', 90, 150],
  ['Manicure', 'Cutilagem e esmaltação', 45, 40],
];
const SEED_PROFESSIONALS = [
  ['Ana Souza', 'Cabeleireira'],
  ['Bruno Lima', 'Barbeiro'],
  ['Carla Mendes', 'Manicure'],
];

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS catalog;
    CREATE TABLE IF NOT EXISTS catalog.services (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 15 AND 480 AND duration_min % 15 = 0),
      price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
      active       BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS catalog.professionals (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      specialty TEXT NOT NULL DEFAULT '',
      active    BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Dados iniciais. O advisory lock evita que duas réplicas insiram ao mesmo tempo.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(1001)');
    const { rows } = await db.query('SELECT count(*)::int AS total FROM catalog.services');
    if (rows[0].total === 0) {
      for (const s of SEED_SERVICES) {
        await db.query('INSERT INTO catalog.services (name, description, duration_min, price) VALUES ($1, $2, $3, $4)', s);
      }
      for (const p of SEED_PROFESSIONALS) {
        await db.query('INSERT INTO catalog.professionals (name, specialty) VALUES ($1, $2)', p);
      }
      logger.info('catálogo inicial criado');
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

const SERVICE_COLUMNS = 'id, name, description, duration_min, price::float AS price, active';
const PROFESSIONAL_COLUMNS = 'id, name, specialty, active';

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido');
  return id;
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

// ---- Serviços ----
app.get('/services', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${SERVICE_COLUMNS} FROM catalog.services WHERE active ORDER BY name`);
  res.json(rows);
});

app.get('/services/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${SERVICE_COLUMNS} FROM catalog.services WHERE id = $1`, [parseId(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Serviço não encontrado');
  res.json(rows[0]);
});

app.post('/services', requireAdmin, async (req, res) => {
  const { name, description = '', durationMin, price } = req.body ?? {};
  const duration = Number(durationMin);
  const value = Number(price);
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Informe o nome do serviço');
  if (!Number.isInteger(duration) || duration < 15 || duration > 480 || duration % 15 !== 0) {
    throw new HttpError(400, 'Duração deve ser múltiplo de 15 minutos (15 a 480)');
  }
  if (!Number.isFinite(value) || value < 0) throw new HttpError(400, 'Preço inválido');

  const { rows } = await pool.query(
    `INSERT INTO catalog.services (name, description, duration_min, price) VALUES ($1, $2, $3, $4) RETURNING ${SERVICE_COLUMNS}`,
    [name.trim(), String(description), duration, value],
  );
  req.log.info({ serviceId: rows[0].id }, 'serviço cadastrado');
  res.status(201).json(rows[0]);
});

app.delete('/services/:id', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('UPDATE catalog.services SET active = false WHERE id = $1', [parseId(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Serviço não encontrado');
  req.log.info({ serviceId: req.params.id }, 'serviço desativado');
  res.status(204).end();
});

// ---- Profissionais ----
app.get('/professionals', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${PROFESSIONAL_COLUMNS} FROM catalog.professionals WHERE active ORDER BY name`);
  res.json(rows);
});

app.get('/professionals/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${PROFESSIONAL_COLUMNS} FROM catalog.professionals WHERE id = $1`, [parseId(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Profissional não encontrado');
  res.json(rows[0]);
});

app.post('/professionals', requireAdmin, async (req, res) => {
  const { name, specialty = '' } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Informe o nome do profissional');
  const { rows } = await pool.query(
    `INSERT INTO catalog.professionals (name, specialty) VALUES ($1, $2) RETURNING ${PROFESSIONAL_COLUMNS}`,
    [name.trim(), String(specialty)],
  );
  req.log.info({ professionalId: rows[0].id }, 'profissional cadastrado');
  res.status(201).json(rows[0]);
});

app.delete('/professionals/:id', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('UPDATE catalog.professionals SET active = false WHERE id = $1', [parseId(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Profissional não encontrado');
  req.log.info({ professionalId: req.params.id }, 'profissional desativado');
  res.status(204).end();
});

app.use(notFound);
app.use(errorHandler);

retry(migrate, { name: 'PostgreSQL' })
  .then(() => start(app, PORT, () => pool.end()))
  .catch((err) => {
    logger.fatal({ err }, 'falha ao iniciar o serviço');
    process.exit(1);
  });
