// Logs estruturados (pino) e métricas Prometheus (prom-client).
// Este arquivo é igual em todos os serviços: cada micro serviço é independente
// e carrega a própria cópia, sem dependência de build compartilhada.
const pino = require('pino');
const pinoHttp = require('pino-http');
const client = require('prom-client');

const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown-service';

const logger = pino({
  base: { service: SERVICE_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});

client.register.setDefaultLabels({ service: SERVICE_NAME });
client.collectDefaultMetrics();

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de requisições HTTP recebidas',
  labelNames: ['method', 'route', 'status_code'],
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const IGNORED_PATHS = new Set(['/health', '/ready', '/metrics']);

function metricsMiddleware(req, res, next) {
  if (IGNORED_PATHS.has(req.path)) return next();
  const stopTimer = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    stopTimer(labels);
    httpRequests.inc(labels);
  });
  next();
}

const httpLogger = pinoHttp({
  logger,
  autoLogging: { ignore: (req) => IGNORED_PATHS.has(req.url.split('?')[0]) },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

async function metricsHandler(req, res) {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}

// Tenta executar fn até dar certo (ex.: banco ou RabbitMQ ainda subindo).
async function retry(fn, { name, attempts = 30, delayMs = 2000 }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn({ err: err.message, attempt }, `${name} indisponível, tentando novamente`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = { logger, client, httpLogger, metricsMiddleware, metricsHandler, retry };
