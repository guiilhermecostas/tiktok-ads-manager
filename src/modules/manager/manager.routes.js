import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId } from '../../lib/validation.js';
import { requireArea } from '../../middleware/workspace.js';

const NUMERIC_ID_RE = /^\d{1,24}$/;

/**
 * Gerenciador de anúncios (montado em /api/tiktok/manager, depois de sessão + conta aprovada).
 *  - GET   /ads?preset=today|yesterday|last7|last14|last30|thisMonth|lastMonth|custom&from=&to=&refresh=1   todos os anúncios + desempenho
 *  - POST  /ads/status   { advertiserId, adIds: [...], status: 'ENABLE' | 'DISABLE' }                       ativar/pausar (nunca exclui)
 *  - GET/POST/PATCH/DELETE /views                                                                         visualizações salvas DA PESSOA
 * Ver exige "Campanhas" ou "Relatórios"; ativar/pausar e as visualizações exigem só a área já usada ("Campanhas" para mudar status).
 */
export function createManagerRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.managerRead ?? 120, windowMs: 60 * 1000 });
  const refreshLimiter = new RateLimiter({ max: limits.managerRefresh ?? 20, windowMs: 5 * 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.managerWrite ?? 60, windowMs: 60 * 1000 });
  const throttle = (limiter, key = (req) => String(req.actor.id)) => (req, _res, next) => {
    const result = limiter.consume(key(req));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const canRead = requireArea('campaigns', 'reports');
  const canChange = requireArea('campaigns');
  const refreshGuard = (req, res, next) => (req.query.refresh === '1' ? throttle(refreshLimiter)(req, res, next) : next());
  const personKey = (req) => String(req.user.id); // visualizações são da pessoa (não do espaço de trabalho)

  router.get('/ads', canRead, throttle(readLimiter), refreshGuard, async (req, res) => {
    const text = (v) => (typeof v === 'string' ? v : undefined);
    res.json(await service.ads(req.actor, { preset: text(req.query.preset), from: text(req.query.from), to: text(req.query.to) }, { fresh: req.query.refresh === '1' }));
  });

  router.post('/ads/status', canChange, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    if (typeof body.advertiserId !== 'string' || !NUMERIC_ID_RE.test(body.advertiserId)) throw badRequest('Conta de anúncio inválida.');
    if (!Array.isArray(body.adIds) || !body.adIds.length || body.adIds.length > 200 || !body.adIds.every((id) => typeof id === 'string' && NUMERIC_ID_RE.test(id))) throw badRequest('Escolha de 1 a 200 anúncios.');
    res.json(await service.setStatus(req.actor, { advertiserId: body.advertiserId, adIds: body.adIds, status: body.status }));
  });

  router.get('/views', canRead, throttle(readLimiter, personKey), async (req, res) => {
    res.json({ views: await service.listViews(req.user), defaultConfig: service.defaultViewConfig() });
  });
  router.post('/views', canRead, throttle(writeLimiter, personKey), async (req, res) => {
    const body = asObject(req.body);
    res.status(201).json({ view: await service.createView(req.user, { name: body.name, config: body.config, isDefault: body.isDefault === true }) });
  });
  router.patch('/views/:id', canRead, throttle(writeLimiter, personKey), async (req, res) => {
    const body = asObject(req.body);
    res.json({ view: await service.updateView(req.user, parseId(req.params.id), { name: body.name, config: body.config, isDefault: body.isDefault }) });
  });
  router.delete('/views/:id', canRead, throttle(writeLimiter, personKey), async (req, res) => {
    await service.deleteView(req.user, parseId(req.params.id));
    res.status(204).end();
  });

  router.stop = () => {
    readLimiter.stop();
    refreshLimiter.stop();
    writeLimiter.stop();
  };
  return router;
}
