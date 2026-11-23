import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { requireArea } from '../../middleware/workspace.js';
import { REPORT_HOURS } from './hourly.service.js';

const NUMERIC_ID_RE = /^\d{1,24}$/;

/**
 * Gasto por hora (montado em /api/tiktok/hourly, depois de sessão + conta aprovada). Área "Relatórios" para colaboradores.
 *  - GET  /?hours=24|48|168&advertiserId=…   série por hora, por moeda
 *  - POST /refresh                           coleta agora (só as conexões do próprio usuário; poucas vezes por 5 minutos)
 */
export function createHourlyRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.tiktokRead ?? 120, windowMs: 60 * 1000 });
  const refreshLimiter = new RateLimiter({ max: limits.hourlyRefresh ?? 3, windowMs: 5 * 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const reports = requireArea('reports');

  router.get('/', reports, throttle(readLimiter), async (req, res) => {
    const hours = Number(req.query.hours ?? 24);
    if (!REPORT_HOURS.includes(hours)) throw badRequest(`Período inválido (use ${REPORT_HOURS.join(', ')} horas).`);
    const raw = req.query.advertiserId;
    if (raw !== undefined && raw !== '' && (typeof raw !== 'string' || !NUMERIC_ID_RE.test(raw))) throw badRequest('Conta de anúncio inválida.');
    res.json(await service.report(req.actor, { hours, advertiserId: raw ? raw : null }));
  });

  router.post('/refresh', reports, throttle(refreshLimiter), async (req, res) => {
    res.json(await service.refresh(req.actor));
  });

  router.stop = () => {
    readLimiter.stop();
    refreshLimiter.stop();
  };
  return router;
}
