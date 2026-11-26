// booking-service: horários disponíveis, criação e cancelamento de agendamentos.
const express = require('express');
const { Pool, types } = require('pg');
const { logger, client, httpLogger, metricsMiddleware, metricsHandler, retry } = require('./lib/observability');
const { HttpError, requireAuth, requireAdmin, notFound, errorHandler, start } = require('./lib/http');
const {
  DATE_RE, DATETIME_RE, nowLocal, addMinutes, minutesOfDay, formatHour, configurePgTimestamps,
} = require('./lib/time');
const { connectBroker, publish } = require('./broker');

configurePgTimestamps(types);

const PORT = Number(process.env.PORT || 3000);
const CATALOG_URL = process.env.CATALOG_URL || 'http://catalog-service:3000';
const OPEN_MIN = Number(process.env.OPEN_HOUR || 9) * 60;
const CLOSE_MIN = Number(process.env.CLOSE_HOUR || 18) * 60;
const SLOT_MIN = 30;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

const bookingsCreated = new client.Counter({
  name: 'bookings_created_total',
  help: 'Agendamentos criados',
  labelNames: ['service_name'],
});
const bookingsCancelled = new client.Counter({
  name: 'bookings_cancelled_total',
  help: 'Agendamentos cancelados',
});
const bookingConflicts = new client.Counter({
  name: 'booking_conflicts_total',
  help: 'Tentativas de agendar um horário já ocupado',
});
const catalogCalls = new client.Histogram({
  name: 'catalog_request_duration_seconds',
  help: 'Duração das chamadas ao catalog-service',
  labelNames: ['result'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 3],
});

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS booking;
    CREATE TABLE IF NOT EXISTS booking.bookings (
      id                SERIAL PRIMARY KEY,
      user_id           INTEGER NOT NULL,
      user_name         TEXT NOT NULL,
      user_email        TEXT NOT NULL,
      service_id        INTEGER NOT NULL,
      service_name      TEXT NOT NULL,
      price             NUMERIC(10, 2) NOT NULL,
      professional_id   INTEGER NOT NULL,
      professional_name TEXT NOT NULL,
      start_at          TIMESTAMP NOT NULL,
      end_at            TIMESTAMP NOT NULL,
      status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bookings_professional_start_idx ON booking.bookings (professional_id, start_at);
    CREATE INDEX IF NOT EXISTS bookings_user_idx ON booking.bookings (user_id);
  `);
}

// Chamada síncrona entre micro serviços (booking -> catalog).
async function fetchCatalog(path, notFoundMessage) {
  const stopTimer = catalogCalls.startTimer();
  let response;
  try {
    response = await fetch(`${CATALOG_URL}${path}`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    stopTimer({ result: 'error' });
    logger.error({ err: err.message, path }, 'catalog-service indisponível');
    throw new HttpError(502, 'Catálogo indisponível no momento');
  }
  stopTimer({ result: response.ok ? 'success' : String(response.status) });
  if (response.status === 404 || response.status === 400) throw new HttpError(404, notFoundMessage);
  if (!response.ok) throw new HttpError(502, 'Catálogo indisponível no momento');
  const item = await response.json();
  if (!item.active) throw new HttpError(404, notFoundMessage);
  return item;
}

const getService = (id) => fetchCatalog(`/services/${encodeURIComponent(id)}`, 'Serviço não encontrado');
const getProfessional = (id) => fetchCatalog(`/professionals/${encodeURIComponent(id)}`, 'Profissional não encontrado');

const BOOKING_COLUMNS = `id, user_id, user_name, user_email, service_id, service_name, price::float AS price,
  professional_id, professional_name, start_at, end_at, status, created_at`;

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

// GET /availability?date=2026-12-04&serviceId=1&professionalId=2
app.get('/availability', async (req, res) => {
  const { date, serviceId, professionalId } = req.query;
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new HttpError(400, 'Data inválida (use AAAA-MM-DD)');
  if (!serviceId || !professionalId) throw new HttpError(400, 'Informe serviceId e professionalId');

  const [service, professional] = await Promise.all([getService(serviceId), getProfessional(professionalId)]);
  const { rows } = await pool.query(
    `SELECT start_at, end_at FROM booking.bookings
     WHERE professional_id = $1 AND status = 'confirmed' AND start_at::date = $2`,
    [professional.id, date],
  );
  const busy = rows.map((b) => [minutesOfDay(b.start_at), minutesOfDay(b.end_at)]);
  const now = nowLocal();

  const slots = [];
  for (let start = OPEN_MIN; start + service.duration_min <= CLOSE_MIN; start += SLOT_MIN) {
    const end = start + service.duration_min;
    const hour = formatHour(start);
    const overlaps = busy.some(([s, e]) => start < e && end > s);
    if (!overlaps && `${date}T${hour}` > now) slots.push(hour);
  }

  res.json({ date, service, professional, slots });
});

// POST / { serviceId, professionalId, startAt: "2026-12-04T10:00" }
app.post('/', requireAuth, async (req, res) => {
  const { serviceId, professionalId, startAt } = req.body ?? {};
  if (typeof startAt !== 'string' || !DATETIME_RE.test(startAt)) {
    throw new HttpError(400, 'Horário inválido (use AAAA-MM-DDTHH:MM)');
  }
  const [service, professional] = await Promise.all([getService(serviceId), getProfessional(professionalId)]);

  const startMin = minutesOfDay(startAt);
  const endMin = startMin + service.duration_min;
  if (startMin < OPEN_MIN || endMin > CLOSE_MIN || startMin % SLOT_MIN !== 0) {
    throw new HttpError(400, 'Horário fora do expediente');
  }
  if (startAt <= nowLocal()) throw new HttpError(400, 'Não é possível agendar no passado');
  const endAt = addMinutes(startAt, service.duration_min);

  // O advisory lock por profissional impede reservas duplicadas mesmo com várias réplicas.
  const db = await pool.connect();
  let booking;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [professional.id]);
    const conflict = await db.query(
      `SELECT 1 FROM booking.bookings
       WHERE professional_id = $1 AND status = 'confirmed' AND start_at < $3 AND end_at > $2 LIMIT 1`,
      [professional.id, startAt, endAt],
    );
    if (conflict.rowCount) {
      bookingConflicts.inc();
      throw new HttpError(409, 'Esse horário acabou de ser ocupado. Escolha outro.');
    }
    const { rows } = await db.query(
      `INSERT INTO booking.bookings
        (user_id, user_name, user_email, service_id, service_name, price, professional_id, professional_name, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${BOOKING_COLUMNS}`,
      [req.user.sub, req.user.name, req.user.email, service.id, service.name, service.price,
        professional.id, professional.name, startAt, endAt],
    );
    await db.query('COMMIT');
    [booking] = rows;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }

  bookingsCreated.inc({ service_name: booking.service_name });
  req.log.info({ bookingId: booking.id, userId: booking.user_id, startAt }, 'agendamento criado');
  publish('booking.created', booking);
  res.status(201).json(booking);
});

app.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLUMNS} FROM booking.bookings WHERE user_id = $1 ORDER BY start_at DESC`,
    [req.user.sub],
  );
  res.json(rows);
});

// Visão do estabelecimento: GET /?date=2026-12-04
app.get('/', requireAdmin, async (req, res) => {
  const { date } = req.query;
  if (date !== undefined && (typeof date !== 'string' || !DATE_RE.test(date))) {
    throw new HttpError(400, 'Data inválida (use AAAA-MM-DD)');
  }
  const { rows } = date
    ? await pool.query(`SELECT ${BOOKING_COLUMNS} FROM booking.bookings WHERE start_at::date = $1 ORDER BY start_at`, [date])
    : await pool.query(`SELECT ${BOOKING_COLUMNS} FROM booking.bookings ORDER BY start_at DESC LIMIT 100`);
  res.json(rows);
});

app.patch('/:id/cancel', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Identificador inválido');

  const { rows } = await pool.query(`SELECT ${BOOKING_COLUMNS} FROM booking.bookings WHERE id = $1`, [id]);
  const current = rows[0];
  if (!current) throw new HttpError(404, 'Agendamento não encontrado');
  if (current.user_id !== req.user.sub && req.user.role !== 'admin') {
    throw new HttpError(403, 'Você não pode cancelar este agendamento');
  }

  const updated = await pool.query(
    `UPDATE booking.bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING ${BOOKING_COLUMNS}`,
    [id],
  );
  if (!updated.rowCount) throw new HttpError(409, 'Agendamento já estava cancelado');
  const booking = updated.rows[0];

  bookingsCancelled.inc();
  req.log.info({ bookingId: id, by: req.user.sub }, 'agendamento cancelado');
  publish('booking.cancelled', booking);
  res.json(booking);
});

app.use(notFound);
app.use(errorHandler);

retry(migrate, { name: 'PostgreSQL' })
  .then(() => {
    start(app, PORT, () => pool.end());
    connectBroker();
  })
  .catch((err) => {
    logger.fatal({ err }, 'falha ao iniciar o serviço');
    process.exit(1);
  });
