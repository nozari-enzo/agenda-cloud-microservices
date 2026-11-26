// Utilitários HTTP comuns: erros, autenticação JWT e inicialização do servidor.
// Igual em todos os serviços (cópia intencional, ver observability.js).
const jwt = require('jsonwebtoken');
const { logger } = require('./observability');

const { JWT_SECRET } = process.env;
if (!JWT_SECRET) throw new Error('JWT_SECRET não definido');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function requireAuth(req, res, next) {
  const [type, token] = (req.headers.authorization || '').split(' ');
  if (type !== 'Bearer' || !token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' });
    return next();
  });
}

function notFound(req, res) {
  res.status(404).json({ error: 'Rota não encontrada' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) (req.log || logger).error({ err }, 'erro ao processar requisição');
  res.status(status).json({ error: err.expose ? err.message : 'Erro interno' });
}

// Sobe o servidor e encerra de forma limpa no SIGTERM (rolling update do Kubernetes).
function start(app, port, cleanup) {
  const server = app.listen(port, () => logger.info({ port }, 'serviço iniciado'));
  const shutdown = async (signal) => {
    logger.info({ signal }, 'encerrando serviço');
    server.close();
    try {
      if (cleanup) await cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

module.exports = { HttpError, requireAuth, requireAdmin, notFound, errorHandler, start };
