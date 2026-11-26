import { Router } from 'express';
import { validatePaymentInput, validatePlanInput, validateRateInput } from '../../../shared/billing.js';
import { notFound, tooMany, validationError } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId } from '../../lib/validation.js';

const throttle = (limiter) => (req, _res, next) => {
  const result = limiter.consume(String(req.user.id));
  return result.allowed ? next() : next(tooMany(result.retryAfterSec));
};

/**
 * "Plano e cobrança" da própria conta (montado em /api/billing, só o dono do espaço, depois de sessão + conta aprovada):
 *  - GET /me   o plano, o mês em andamento, os meses fechados, os pagamentos e o saldo (tudo em dólar, centavos inteiros). Só leitura.
 */
export function createBillingRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.billingRead ?? 60, windowMs: 60 * 1000 });
  router.get('/me', throttle(readLimiter), async (req, res) => {
    res.json(await service.mine(req.actor.id));
  });
  router.stop = () => readLimiter.stop();
  return router;
}

/**
 * Cobrança no painel do admin (montado em /api/admin/billing, só admin dono do espaço):
 *  - GET  /                              todas as pessoas com plano, mês em andamento, em aberto, bloqueios e as cotações
 *  - GET  /users/:id                     extrato de uma pessoa
 *  - PUT  /users/:id/plan                { monthlyFee, percent, effective: 'current' | 'next', note } (valores em dólar e %)
 *  - POST /users/:id/payments            { amount, paidAt?, note? } registra um pagamento recebido
 *  - GET  /locks, POST /locks/:id/release   BCs/contas bloqueadas por débito
 *  - PUT  /rates/:currency               { usdPerUnit } cotação para converter outra moeda em dólar
 */
export function createAdminBillingRouter({ service, audit, now = () => new Date(), limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.billingAdminRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.billingAdminWrite ?? 120, windowMs: 60 * 60 * 1000 });
  const body = (req) => asObject(req.body);
  const record = (req, action, targetId, detail) => audit.record({ adminId: req.user.id, targetId, action, detail, ip: req.ip });

  router.get('/', throttle(readLimiter), async (_req, res) => {
    res.json(await service.overview());
  });

  router.get('/users/:id', throttle(readLimiter), async (req, res) => {
    res.json(await service.userDetail(parseId(req.params.id)));
  });

  router.put('/users/:id/plan', throttle(writeLimiter), async (req, res) => {
    const id = parseId(req.params.id);
    const { value, errors } = validatePlanInput(body(req));
    if (!value) throw validationError(errors);
    const { user, effectiveMonth } = await service.setPlan(req.user.id, id, value);
    await record(req, 'billing_plan', id, `${user.name}: US$ ${(value.monthlyFeeCents / 100).toFixed(2)}/mês + ${(value.percentBp / 100).toFixed(2)}% a partir de ${effectiveMonth.slice(0, 7)}`);
    res.json(await service.userDetail(id));
  });

  router.post('/users/:id/payments', throttle(writeLimiter), async (req, res) => {
    const id = parseId(req.params.id);
    const { value, errors } = validatePaymentInput(body(req), now());
    if (!value) throw validationError(errors);
    const { user, released } = await service.addPayment(req.user.id, id, value);
    await record(req, 'billing_payment', id, `${user.name}: US$ ${(value.amountCents / 100).toFixed(2)} recebido${released ? `, ${released} bloqueio(s) liberado(s)` : ''}`);
    res.status(201).json(await service.userDetail(id));
  });

  router.get('/locks', throttle(readLimiter), async (_req, res) => {
    res.json({ locks: await service.listLocks() });
  });

  router.post('/locks/:id/release', throttle(writeLimiter), async (req, res) => {
    const lock = await service.releaseLock(req.user.id, parseId(req.params.id));
    await record(req, 'billing_lock_release', lock.ownerId, `Liberou o bloqueio ${lock.kind === 'bc' ? 'da BC' : 'da conta'} ${lock.value}`);
    res.json({ ok: true });
  });

  router.put('/rates/:currency', throttle(writeLimiter), async (req, res) => {
    const currency = String(req.params.currency ?? '').toUpperCase();
    const { value, errors } = validateRateInput(currency, body(req));
    if (!value) throw validationError(errors);
    await service.setRate(value.currency, value.usdPerUnit, req.user.id);
    await record(req, 'billing_rate', null, `1 ${value.currency} = US$ ${value.usdPerUnit}`);
    res.json({ rates: await service.listRates() });
  });

  router.use((_req, _res, next) => next(notFound()));
  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
  };
  return router;
}
