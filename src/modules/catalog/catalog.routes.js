import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId } from '../../lib/validation.js';
import { requireArea } from '../../middleware/workspace.js';

const text = (value) => (typeof value === 'string' ? value : undefined);
const intIn = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/**
 * Catálogo de produtos (montado em /api/tiktok/catalogs, depois de sessão + conta aprovada). Área "Campanhas".
 *  - GET    /                                                       catálogos de todas as BCs (?refresh=1 ignora o cache)
 *  - PUT    /hidden                    { items: [{ bcId, catalogId }], hidden: true|false }   oculta/mostra na lista DESTA pessoa (só visual)
 *  - GET    /meta?connectionId=&bcId=                               países e moedas aceitos para criar
 *  - POST   /                          { connectionId, bcId, name, regionCode, currency }
 *  - GET    /:catalogId/overview?connectionId=&bcId=                aprovados / reprovados / em análise
 *  - GET    /:catalogId/products?connectionId=&bcId=&page=&pageSize=&sku=&productSetId=&available=1
 *  - POST   /:catalogId/products       { connectionId, bcId, products: [...] }   envia um lote (até 500)
 *  - GET    /:catalogId/logs/:feedLogId?connectionId=&bcId=         resultado do processamento de um envio
 *  - GET/PUT/DELETE /:catalogId/defaults   anúncio padrão do catálogo (criativos, produtos, texto… que a campanha já puxa pronto)
 *  - GET/POST /:catalogId/sets         conjuntos de produtos
 *  - GET/POST /:catalogId/feeds, POST .../feeds/:feedId/status, DELETE .../feeds/:feedId, GET .../feeds/:feedId/log   sincronização automática (feed de dados)
 * A conexão e a Business Center vêm em TODO pedido: o serviço confere que a conexão é do usuário e que a BC é uma das dela.
 */
export function createCatalogRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.catalogRead ?? 240, windowMs: 60 * 1000 });
  const refreshLimiter = new RateLimiter({ max: limits.catalogRefresh ?? 12, windowMs: 5 * 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.catalogWrite ?? 60, windowMs: 5 * 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const canUse = requireArea('campaigns');
  const refreshGuard = (req, res, next) => (req.query.refresh === '1' ? throttle(refreshLimiter)(req, res, next) : next());

  /** { connectionId, bcId, catalogId } de um pedido (consulta ou corpo). */
  const refOf = (source, params = {}) => {
    const connectionId = parseId(source.connectionId);
    if (typeof source.bcId !== 'string') throw badRequest('Escolha a Business Center.');
    return { connectionId, bcId: source.bcId, ...(params.catalogId === undefined ? {} : { catalogId: params.catalogId }) };
  };

  router.get('/', canUse, throttle(readLimiter), refreshGuard, async (req, res) => {
    res.json(await service.list(req.actor, { fresh: req.query.refresh === '1', viewerId: req.user.id }));
  });

  // Ocultar é uma preferência da PESSOA que usa o sistema (req.user), não do espaço de trabalho: o colaborador não esconde catálogos do dono.
  router.put('/hidden', canUse, throttle(writeLimiter), async (req, res) => {
    res.json(await service.setHidden(req.actor, req.user.id, asObject(req.body)));
  });

  router.get('/meta', canUse, throttle(readLimiter), async (req, res) => {
    res.json(await service.meta(req.actor, refOf(req.query)));
  });

  router.post('/', canUse, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    const { connectionId, bcId } = refOf(body);
    res.status(201).json({ catalog: await service.create(req.actor, { connectionId, bcId, name: body.name, regionCode: body.regionCode, currency: body.currency }) });
  });

  router.get('/:catalogId/overview', canUse, throttle(readLimiter), async (req, res) => {
    res.json(await service.overview(req.actor, refOf(req.query, req.params)));
  });

  router.get('/:catalogId/products', canUse, throttle(readLimiter), async (req, res) => {
    const q = req.query;
    res.json(await service.products(req.actor, refOf(q, req.params), {
      page: intIn(q.page, 1, 1, 200), pageSize: intIn(q.pageSize, 50, 1, 100), sku: text(q.sku)?.trim().slice(0, 100) || null, productSetId: text(q.productSetId) || null, availableOnly: q.available === '1',
    }));
  });

  router.post('/:catalogId/products', canUse, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    res.status(202).json(await service.uploadProducts(req.actor, refOf(body, req.params), body.products));
  });

  router.get('/:catalogId/logs/:feedLogId', canUse, throttle(readLimiter), async (req, res) => {
    res.json(await service.productLog(req.actor, refOf(req.query, req.params), req.params.feedLogId));
  });

  // ---------- sincronização automática (feeds) ----------
  router.get('/:catalogId/feeds', canUse, throttle(readLimiter), async (req, res) => {
    res.json({ feeds: await service.feeds(req.actor, refOf(req.query, req.params)) });
  });

  router.post('/:catalogId/feeds', canUse, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    res.status(201).json({ feed: await service.createFeed(req.actor, refOf(body, req.params), body) });
  });

  router.post('/:catalogId/feeds/:feedId/status', canUse, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    res.json(await service.setFeedStatus(req.actor, refOf(body, req.params), req.params.feedId, body.status));
  });

  router.delete('/:catalogId/feeds/:feedId', canUse, throttle(writeLimiter), async (req, res) => {
    await service.deleteFeed(req.actor, refOf(req.query, req.params), req.params.feedId);
    res.status(204).end();
  });

  router.get('/:catalogId/feeds/:feedId/log', canUse, throttle(readLimiter), async (req, res) => {
    res.json({ runs: await service.feedLog(req.actor, refOf(req.query, req.params), req.params.feedId) });
  });

  // ---------- anúncio padrão do catálogo ----------
  router.get('/:catalogId/defaults', canUse, throttle(readLimiter), async (req, res) => {
    res.json(await service.getDefaults(req.actor, refOf(req.query, req.params)));
  });

  router.put('/:catalogId/defaults', canUse, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    res.json(await service.saveDefaults(req.actor, refOf(body, req.params), { adGroup: body.adGroup, ad: body.ad }));
  });

  router.delete('/:catalogId/defaults', canUse, throttle(writeLimiter), async (req, res) => {
    await service.removeDefaults(req.actor, refOf(req.query, req.params));
    res.status(204).end();
  });

  router.get('/:catalogId/sets', canUse, throttle(readLimiter), async (req, res) => {
    res.json({ sets: await service.productSets(req.actor, refOf(req.query, req.params)) });
  });

  router.post('/:catalogId/sets', canUse, throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    res.status(201).json({ set: await service.createProductSet(req.actor, refOf(body, req.params), { name: body.name, filters: body.filters }) });
  });

  router.stop = () => {
    readLimiter.stop();
    refreshLimiter.stop();
    writeLimiter.stop();
  };
  return router;
}
