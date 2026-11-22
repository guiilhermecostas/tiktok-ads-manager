import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseEnum, parseId, parseText } from '../../lib/validation.js';
import { PROXY_KINDS } from './proxy-dispatcher.js';
import { normalizeProxyHost } from './proxy-net.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function parsePort(value) {
  const port = typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('Porta inválida (use um número de 1 a 65535).');
  return port;
}

/** Usuário da proxy: texto curto sem caracteres de controle (pode ser "" para limpar). */
function parseUsername(value) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') throw badRequest('Usuário da proxy inválido.');
  const text = value.trim();
  if (text.length > 128 || CONTROL_CHARS_RE.test(text)) throw badRequest('Usuário da proxy inválido (até 128 caracteres, sem caracteres de controle).');
  return text;
}

/** Senha da proxy: guardada exatamente como digitada (sem trim), sem caracteres de controle. */
function parsePassword(value) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string' || value.length > 256 || CONTROL_CHARS_RE.test(value)) throw badRequest('Senha da proxy inválida (até 256 caracteres, sem caracteres de controle).');
  return value;
}

function parseBool(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`${label} inválido.`);
  return value;
}

function parseProxy(body) {
  const data = asObject(body);
  return {
    name: parseText(data.name, 'Nome', { min: 1, max: 60 }),
    kind: parseEnum(data.kind, PROXY_KINDS, 'Tipo da proxy'),
    host: normalizeProxyHost(data.host),
    port: parsePort(data.port),
    username: parseUsername(data.username),
    password: parsePassword(data.password),
    clearAuth: parseBool(data.clearAuth, 'Remover autenticação'),
    active: parseBool(data.active, 'Ativar'),
  };
}

/**
 * Rotas de proxies (sessão + conta aprovada já garantidas pelo roteador pai). Cada usuário só enxerga e altera as PRÓPRIAS
 * proxies (de outro usuário: 404). A senha nunca é devolvida.
 */
export function createProxiesRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.proxiesRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.proxiesWrite ?? 30, windowMs: 60 * 1000 });
  // Testar abre conexões para fora e chama serviços externos: limite bem menor.
  const testLimiter = new RateLimiter({ max: limits.proxiesTest ?? 10, windowMs: 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const read = throttle(readLimiter);
  const write = throttle(writeLimiter);

  router.get('/', read, async (req, res) => {
    res.json({ configured: service.isConfigured(), max: service.maxPerUser, proxies: await service.list(req.user) });
  });

  router.post('/', write, async (req, res) => {
    res.status(201).json({ proxy: await service.create(req.user, parseProxy(req.body)) });
  });

  router.patch('/:id', write, async (req, res) => {
    res.json({ proxy: await service.update(req.user, parseId(req.params.id), parseProxy(req.body)) });
  });

  router.delete('/:id', write, async (req, res) => {
    await service.remove(req.user, parseId(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/activate', write, async (req, res) => {
    res.json({ proxy: await service.activate(req.user, parseId(req.params.id)) });
  });

  router.post('/:id/deactivate', write, async (req, res) => {
    res.json({ proxy: await service.deactivate(req.user, parseId(req.params.id)) });
  });

  router.post('/:id/test', throttle(testLimiter), async (req, res) => {
    res.json({ result: await service.test(req.user, parseId(req.params.id)) });
  });

  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
    testLimiter.stop();
  };
  return router;
}
