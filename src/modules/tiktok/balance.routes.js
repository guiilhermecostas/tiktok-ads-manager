import { Router } from 'express';
import { MAX_TRANSFERS_PER_HOUR } from '../../../shared/balance-transfer.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { tooMany } from '../../lib/http-error.js';
import { asObject } from '../../lib/validation.js';
import { requireArea } from '../../middleware/workspace.js';

/**
 * Saldo das Business Centers e das contas de anúncio (montado em /api/tiktok/balance, depois de sessão + conta aprovada).
 * Área "Contas TikTok" para colaboradores: é informação financeira. `?refresh=1` ignora o cache de 60 s (poucas vezes por 5 minutos).
 *  - GET  /              BCs e contas com o saldo (+ `canTransfer`: só o dono move dinheiro)
 *  - POST /transfer      { connectionId, bcId, advertiserId, type: RECHARGE|REFUND, amount, operationId, password }  move dinheiro BC ↔ conta
 *  - GET  /spend         gasto total (vitalício) de cada conta e de cada BC (em cache por 10 min; `?refresh=1` refaz)
 *  - GET  /history       histórico de depósitos de UMA BC (`kind=bc&bcId=`) ou de UMA conta (`kind=account&advertiserId=`), com `connectionId`,
 *                        `range` (90|180|365), `filter` (deposits|all) e `page`. A BC de uma conta é descoberta no servidor.
 *  - GET  /transfers     últimas transferências DA PESSOA
 * Mover dinheiro: só o dono (nunca colaborador), com a senha, no máximo 20 por hora e bloqueio depois de 5 senhas erradas em 15 minutos.
 */
export function createBalanceRouter({ service, activity, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.tiktokRead ?? 120, windowMs: 60 * 1000 });
  const refreshLimiter = new RateLimiter({ max: limits.balanceRefresh ?? 6, windowMs: 5 * 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const spendRefreshLimiter = new RateLimiter({ max: limits.balanceRefresh ?? 6, windowMs: 5 * 60 * 1000 }); // "Atualizar agora" refaz saldo E gasto: cada um com o seu limite, para um clique não gastar o do outro
  const historyLimiter = new RateLimiter({ max: limits.balanceHistory ?? 40, windowMs: 60 * 1000 });
  const accounts = requireArea('accounts');
  const transferLimiter = new RateLimiter({ max: limits.balanceTransfer ?? MAX_TRANSFERS_PER_HOUR, windowMs: 60 * 60 * 1000 });
  const passwordFailures = new RateLimiter({ max: limits.balanceTransferPassword ?? 5, windowMs: 15 * 60 * 1000 }); // só as senhas ERRADAS contam
  const personKey = (req) => String(req.user.id); // o limite é da PESSOA (um colaborador não esgota o do dono, nem o contrário)

  // "Atualizar" (?refresh=1) conta no limite próprio; a consulta normal só no limite geral de leitura.
  const refreshGuard = (req, res, next) => (req.query.refresh === '1' ? throttle(refreshLimiter)(req, res, next) : next());

  router.get('/', accounts, throttle(readLimiter), refreshGuard, async (req, res) => {
    res.json({ ...(await service.overview(req.actor, { fresh: req.query.refresh === '1' })), canTransfer: req.user.id === req.actor.id });
  });

  const spendRefreshGuard = (req, res, next) => (req.query.refresh === '1' ? throttle(spendRefreshLimiter)(req, res, next) : next());

  router.get('/spend', accounts, throttle(readLimiter), spendRefreshGuard, async (req, res) => {
    res.json(await activity.spend(req.actor, { fresh: req.query.refresh === '1' }));
  });

  router.get('/history', accounts, throttle(historyLimiter), async (req, res) => {
    res.json(await activity.history(req.actor, req.query));
  });

  router.get('/transfers', accounts, throttle(readLimiter), async (req, res) => {
    res.json({ transfers: await service.recentTransfers(req.user) });
  });

  router.post('/transfer', accounts, (req, _res, next) => {
    const blocked = passwordFailures.peek(personKey(req));
    if (!blocked.allowed) return next(tooMany(blocked.retryAfterSec));
    const result = transferLimiter.consume(personKey(req));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  }, async (req, res) => {
    try {
      res.status(201).json(await service.transfer(req.actor, req.user, asObject(req.body)));
    } catch (err) {
      if (err?.code === 'invalid_password') passwordFailures.consume(personKey(req));
      throw err;
    }
  });

  router.stop = () => {
    readLimiter.stop();
    refreshLimiter.stop();
    spendRefreshLimiter.stop();
    historyLimiter.stop();
    transferLimiter.stop();
    passwordFailures.stop();
  };
  return router;
}
