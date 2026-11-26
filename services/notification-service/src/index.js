// notification-service: consome eventos de agendamento do RabbitMQ e envia
// confirmações, cancelamentos e lembretes (e-mail simulado via log).
const express = require('express');
const amqp = require('amqplib');
const { Pool, types } = require('pg');
const { logger, client, httpLogger, metricsMiddleware, metricsHandler, retry } = require('./lib/observability');
const { requireAdmin, notFound, errorHandler, start } = require('./lib/http');
const { nowLocal, addMinutes, formatBr, configurePgTimestamps } = require('./lib/time');

configurePgTimestamps(types);

const PORT = Number(process.env.PORT || 3000);
const EXCHANGE = 'agenda';
const QUEUE = 'notifications';
const DEAD_LETTER_QUEUE = 'notifications.dlq';
const REMINDER_HOURS = Number(process.env.REMINDER_HOURS || 24);
const REMINDER_INTERVAL_MS = Number(process.env.REMINDER_INTERVAL_MS || 60000);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
let channel = null;

const notificationsSent = new client.Counter({
  name: 'notifications_sent_total',
  help: 'Notificações enviadas por tipo',
  labelNames: ['type'],
});
const eventsFailed = new client.Counter({
  name: 'events_failed_total',
  help: 'Eventos que falharam e foram para a dead-letter queue',
});
const deliveryLag = new client.Histogram({
  name: 'notification_delivery_lag_seconds',
  help: 'Tempo entre o evento ser publicado e a notificação ser enviada',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS notif;
    CREATE TABLE IF NOT EXISTS notif.notifications (
      id         SERIAL PRIMARY KEY,
      booking_id INTEGER NOT NULL,
      type       TEXT NOT NULL,
      recipient  TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS notif.reminders (
      booking_id        INTEGER PRIMARY KEY,
      recipient         TEXT NOT NULL,
      user_name         TEXT NOT NULL,
      service_name      TEXT NOT NULL,
      professional_name TEXT NOT NULL,
      start_at          TIMESTAMP NOT NULL,
      sent              BOOLEAN NOT NULL DEFAULT false,
      cancelled         BOOLEAN NOT NULL DEFAULT false
    );
  `);
}

// "Envio" da notificação: grava no banco e registra no log (e-mail simulado).
async function notify(type, bookingId, recipient, message) {
  await pool.query(
    'INSERT INTO notif.notifications (booking_id, type, recipient, message) VALUES ($1, $2, $3, $4)',
    [bookingId, type, recipient, message],
  );
  notificationsSent.inc({ type });
  logger.info({ type, bookingId, recipient }, `e-mail enviado: ${message}`);
}

async function handleEvent(routingKey, event) {
  const when = formatBr(event.start_at);
  if (routingKey === 'booking.created') {
    await notify('confirmation', event.id, event.user_email,
      `Olá ${event.user_name}, seu agendamento de ${event.service_name} com ${event.professional_name} está confirmado para ${when}.`);
    await pool.query(
      `INSERT INTO notif.reminders (booking_id, recipient, user_name, service_name, professional_name, start_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (booking_id) DO NOTHING`,
      [event.id, event.user_email, event.user_name, event.service_name, event.professional_name, event.start_at],
    );
  } else if (routingKey === 'booking.cancelled') {
    await notify('cancellation', event.id, event.user_email,
      `Olá ${event.user_name}, seu agendamento de ${event.service_name} em ${when} foi cancelado.`);
    await pool.query('UPDATE notif.reminders SET cancelled = true WHERE booking_id = $1', [event.id]);
  } else {
    logger.warn({ routingKey }, 'evento desconhecido ignorado');
    return;
  }
  if (event.occurred_at) deliveryLag.observe((Date.now() - Date.parse(event.occurred_at)) / 1000);
}

async function connectConsumer() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  connection.on('error', (err) => logger.error({ err: err.message }, 'erro na conexão com RabbitMQ'));
  connection.on('close', () => {
    channel = null;
    logger.warn('conexão com RabbitMQ perdida, reconectando');
    setTimeout(startConsumer, 5000);
  });

  const ch = await connection.createChannel();
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  await ch.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
  await ch.assertQueue(QUEUE, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': DEAD_LETTER_QUEUE },
  });
  await ch.bindQueue(QUEUE, EXCHANGE, 'booking.*');
  await ch.prefetch(10);

  // Várias réplicas consomem a mesma fila: o RabbitMQ distribui as mensagens entre elas.
  await ch.consume(QUEUE, async (msg) => {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString());
      await handleEvent(msg.fields.routingKey, event);
      ch.ack(msg);
    } catch (err) {
      eventsFailed.inc();
      logger.error({ err, routingKey: msg.fields.routingKey }, 'falha ao processar evento, enviado para a DLQ');
      ch.nack(msg, false, false);
    }
  });
  channel = ch;
  logger.info({ queue: QUEUE }, 'consumindo eventos do RabbitMQ');
}

function startConsumer() {
  return retry(connectConsumer, { name: 'RabbitMQ', attempts: Infinity, delayMs: 5000 })
    .catch((err) => logger.error({ err }, 'não foi possível conectar ao RabbitMQ'));
}

// Lembretes: a cada minuto, envia os que começam nas próximas REMINDER_HOURS horas.
// FOR UPDATE SKIP LOCKED garante que duas réplicas não enviem o mesmo lembrete.
async function sendReminders() {
  const now = nowLocal();
  const limit = addMinutes(now, REMINDER_HOURS * 60);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `UPDATE notif.reminders SET sent = true
       WHERE booking_id IN (
         SELECT booking_id FROM notif.reminders
         WHERE NOT sent AND NOT cancelled AND start_at > $1 AND start_at <= $2
         FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [now, limit],
    );
    for (const r of rows) {
      await db.query(
        'INSERT INTO notif.notifications (booking_id, type, recipient, message) VALUES ($1, $2, $3, $4)',
        [r.booking_id, 'reminder', r.recipient,
          `Lembrete: ${r.user_name}, você tem ${r.service_name} com ${r.professional_name} em ${formatBr(r.start_at)}.`],
      );
    }
    await db.query('COMMIT');
    for (const r of rows) {
      notificationsSent.inc({ type: 'reminder' });
      logger.info({ type: 'reminder', bookingId: r.booking_id, recipient: r.recipient }, 'lembrete enviado');
    }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'falha ao enviar lembretes');
  } finally {
    db.release();
  }
}

const app = express();
app.use(express.json());
app.use(httpLogger);
app.use(metricsMiddleware);

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', broker: channel ? 'connected' : 'disconnected' });
  } catch {
    res.status(503).json({ status: 'database unavailable' });
  }
});
app.get('/metrics', metricsHandler);

app.get('/', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM notif.notifications ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

app.use(notFound);
app.use(errorHandler);

retry(migrate, { name: 'PostgreSQL' })
  .then(() => {
    start(app, PORT, () => pool.end());
    startConsumer();
    setInterval(sendReminders, REMINDER_INTERVAL_MS);
  })
  .catch((err) => {
    logger.fatal({ err }, 'falha ao iniciar o serviço');
    process.exit(1);
  });
