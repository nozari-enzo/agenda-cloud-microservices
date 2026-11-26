// Publicação de eventos no RabbitMQ (exchange "agenda", tipo topic).
const amqp = require('amqplib');
const { logger, client, retry } = require('./lib/observability');

const EXCHANGE = 'agenda';
let channel = null;

const eventsPublished = new client.Counter({
  name: 'events_published_total',
  help: 'Eventos publicados no RabbitMQ',
  labelNames: ['routing_key', 'result'],
});

async function connect() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  connection.on('error', (err) => logger.error({ err: err.message }, 'erro na conexão com RabbitMQ'));
  connection.on('close', () => {
    channel = null;
    logger.warn('conexão com RabbitMQ perdida, reconectando');
    setTimeout(connectBroker, 5000);
  });
  const ch = await connection.createChannel();
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  channel = ch;
  logger.info('conectado ao RabbitMQ');
}

function connectBroker() {
  return retry(connect, { name: 'RabbitMQ', attempts: Infinity, delayMs: 5000 })
    .catch((err) => logger.error({ err }, 'não foi possível conectar ao RabbitMQ'));
}

// Se o broker estiver fora, o agendamento continua valendo; o evento é registrado como falho.
function publish(routingKey, payload) {
  if (!channel) {
    eventsPublished.inc({ routing_key: routingKey, result: 'failure' });
    logger.error({ routingKey, bookingId: payload.id }, 'evento não publicado: RabbitMQ indisponível');
    return false;
  }
  const body = Buffer.from(JSON.stringify({ ...payload, occurred_at: new Date().toISOString() }));
  channel.publish(EXCHANGE, routingKey, body, { persistent: true, contentType: 'application/json' });
  eventsPublished.inc({ routing_key: routingKey, result: 'success' });
  logger.info({ routingKey, bookingId: payload.id }, 'evento publicado');
  return true;
}

const isConnected = () => channel !== null;

module.exports = { connectBroker, publish, isConnected };
