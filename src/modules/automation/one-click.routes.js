import { Router } from 'express';
import { tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { parseId } from '../../lib/validation.js';

/**
 * Campanha one-click (montado atrás de sessão + conta aprovada + a área "Campanhas", veja app.js). Tudo usa `req.actor` (o dono do espaço).
 *  - GET    /api/automation/one-click            lista as configurações salvas
 *  - POST   /api/automation/one-click            { name, config } salva uma configuração completa
 *  - GET    /api/automation/one-click/:id        uma configuração
 *  - PUT    /api/automation/one-click/:id        { name, config } altera
 *  - DELETE /api/automation/one-click/:id        apaga a configuração (campanhas já publicadas a partir dela continuam)
 *  - POST   /api/automation/one-click/:id/launch cria a campanha (rascunho) a partir da configuração; a tela a publica conta por conta em /api/campaigns/:id/publish
 */
export function createOneClickRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.oneClickRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.oneClickWrite ?? 40, windowMs: 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const read = throttle(readLimiter);
  const write = throttle(writeLimiter);

  router.get('/', read, async (req, res) => {
    res.json({ templates: await service.list(req.actor) });
  });

  router.post('/', write, async (req, res) => {
    res.status(201).json({ template: await service.create(req.actor, req.body) });
  });

  router.get('/:id', read, async (req, res) => {
    res.json({ template: await service.get(req.actor, parseId(req.params.id)) });
  });

  router.put('/:id', write, async (req, res) => {
    res.json({ template: await service.update(req.actor, parseId(req.params.id), req.body) });
  });

  router.delete('/:id', write, async (req, res) => {
    await service.remove(req.actor, parseId(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/launch', write, async (req, res) => {
    res.status(201).json({ campaign: await service.launch(req.actor, parseId(req.params.id)) });
  });

  router.stop = () => [readLimiter, writeLimiter].forEach((l) => l.stop());
  return router;
}
