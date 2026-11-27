import { Router } from 'express';
import { formatBrl, formatPercentBp, validateInvoicePayInput, validatePaymentInput, validatePlanInput, validateRateInput } from '../../../shared/billing.js';
import { notFound, tooMany, validationError } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId } from '../../lib/validation.js';

const throttle = (limiter) => (req, _res, next) => {
  const result = limiter.consume(String(req.user.id));
  return result.allowed ? next() : next(tooMany(result.retryAfterSec));
};

/**
 * "Plano e cobrança" da própria conta (montado em /api/billing, só o dono do espaço, depois de sessão + conta aprovada):
 *  - GET /me   o plano, o mês em andamento, os meses fechados, as faturas, os pagamentos e o saldo (tudo em REAL, centavos inteiros). Só leitura.
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
 *  - PUT  /users/:id/plan                { monthlyFee, percent, effective: 'current' | 'next', note } (valores em reais e %)
 *  - POST /users/:id/payments            { amount, paidAt?, note? } registra um pagamento avulso recebido (em reais)
 *  - POST /users/:id/invoices/:invoiceId/pay   { paidAt?, note? } marca a fatura como paga (o cliente pagou por fora)
 *  - GET  /locks, POST /locks/:id/release   BCs/contas bloqueadas por débito
 *  - PUT  /rates/:currency               { brlPerUnit } FIXA a cotação (quantos reais vale 1 unidade); DELETE volta para a automática
 *  - POST /rates/refresh                 busca as cotações automáticas agora
 */
export function createAdminBillingRouter({ service, audit, now = () => new Date(), limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.billingAdminRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.billingAdminWrite ?? 120, windowMs: 60 * 60 * 1000 });
  const fxLimiter = new RateLimiter({ max: limits.billingFxRefresh ?? 12, windowMs: 60 * 60 * 1000 }); // cada pedido consulta uma fonte externa
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
    await record(req, 'billing_plan', id, `${user.name}: ${formatBrl(value.monthlyFeeCents)}/mês + ${formatPercentBp(value.percentBp)} a partir de ${effectiveMonth.slice(0, 7)}`);
    res.json(await service.userDetail(id));
  });

  router.post('/users/:id/payments', throttle(writeLimiter), async (req, res) => {
    const id = parseId(req.params.id);
    const { value, errors } = validatePaymentInput(body(req), now());
    if (!value) throw validationError(errors);
    const { user, released } = await service.addPayment(req.user.id, id, value);
    await record(req, 'billing_payment', id, `${user.name}: ${formatBrl(value.amountCents)} recebido${released ? `, ${released} bloqueio(s) liberado(s)` : ''}`);
    res.status(201).json(await service.userDetail(id));
  });

  router.post('/users/:id/invoices/:invoiceId/pay', throttle(writeLimiter), async (req, res) => {
    const id = parseId(req.params.id);
    const invoiceId = parseId(req.params.invoiceId);
    const { value, errors } = validateInvoicePayInput(body(req), now());
    if (!value) throw validationError(errors);
    const { user, invoice, amountCents, released } = await service.payInvoice(req.user.id, id, invoiceId, value);
    await record(req, 'billing_invoice_paid', id, `${user.name}: fatura nº ${invoice.id} marcada como paga (${formatBrl(amountCents)})${released ? `, ${released} bloqueio(s) liberado(s)` : ''}`);
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

  const currencyOf = (req) => String(req.params.currency ?? '').toUpperCase();

  router.put('/rates/:currency', throttle(writeLimiter), async (req, res) => {
    const currency = currencyOf(req);
    const { value, errors } = validateRateInput(currency, body(req));
    if (!value) throw validationError(errors);
    await service.setRate(value.currency, value.brlPerUnit, req.user.id);
    await record(req, 'billing_rate', null, `1 ${value.currency} = ${formatBrl(Math.round(value.brlPerUnit * 100))} (fixada à mão; com mais casas: ${value.brlPerUnit})`);
    res.json({ rates: await service.listRates(), fx: service.fxStatus() });
  });

  router.delete('/rates/:currency', throttle(writeLimiter), async (req, res) => {
    const currency = currencyOf(req);
    const { errors } = validateRateInput(currency, { brlPerUnit: 1 });
    if (errors.length) throw validationError(errors);
    await service.clearRate(currency);
    await record(req, 'billing_rate_clear', null, `Removeu a cotação de ${currency} (volta para a automática)`);
    res.json({ rates: await service.listRates(), fx: service.fxStatus() });
  });

  router.post('/rates/refresh', throttle(fxLimiter), async (_req, res) => {
    const result = await service.refreshRates();
    res.json({ result, rates: await service.listRates(), fx: service.fxStatus() });
  });

  router.use((_req, _res, next) => next(notFound()));
  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
    fxLimiter.stop();
  };
  return router;
}
