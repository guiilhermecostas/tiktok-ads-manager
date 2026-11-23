import { Router } from 'express';
import { RateLimiter } from '../../lib/rate-limit.js';
import { tooMany } from '../../lib/http-error.js';
import { requireArea } from '../../middleware/workspace.js';

/**
 * Saldo das Business Centers e das contas de anúncio (montado em /api/tiktok/balance, depois de sessão + conta aprovada).
 * Área "Contas TikTok" para colaboradores: é informação financeira. `?refresh=1` ignora o cache de 60 s (poucas vezes por 5 minutos).
 */
export function createBalanceRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.tiktokRead ?? 120, windowMs: 60 * 1000 });
  const refreshLimiter = new RateLimiter({ max: limits.balanceRefresh ?? 6, windowMs: 5 * 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const accounts = requireArea('accounts');

  // "Atualizar" (?refresh=1) conta no limite próprio; a consulta normal só no limite geral de leitura.
  const refreshGuard = (req, res, next) => (req.query.refresh === '1' ? throttle(refreshLimiter)(req, res, next) : next());

  router.get('/', accounts, throttle(readLimiter), refreshGuard, async (req, res) => {
    res.json(await service.overview(req.actor, { fresh: req.query.refresh === '1' }));
  });

  router.stop = () => {
    readLimiter.stop();
    refreshLimiter.stop();
  };
  return router;
}
