import { Router } from 'express';
import { MAX_HOOK_IDEA_LENGTH } from '../../../shared/hook-styles.js';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId, parseText } from '../../lib/validation.js';

/**
 * Hook com IA (sessão, conta aprovada e área "Criativos" já garantidas pelo roteador pai).
 *  - GET    /               estado do recurso + últimos pedidos (a tela consulta enquanto algo está sendo gerado)
 *  - POST   /               cria de 1 a 3 hooks   { style, idea?, durationMs, count? }
 *  - GET    /:id/file       pré-visualização do hook pronto (só o dono)
 *  - POST   /:id/apply      aplica a um vídeo da biblioteca { creativeId?, name? } (202: roda em segundo plano)
 *  - DELETE /:id            descarta
 */
export function createHooksRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.hooksRead ?? 300, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.hooksWrite ?? 30, windowMs: 60 * 1000 });
  const createLimiter = new RateLimiter({ max: limits.hooksCreate ?? 8, windowMs: 10 * 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };

  router.get('/', throttle(readLimiter), async (req, res) => {
    res.json({ ...(await service.info(req.actor)), hooks: await service.list(req.actor) });
  });

  router.post('/', throttle(writeLimiter), throttle(createLimiter), async (req, res) => {
    const body = asObject(req.body);
    if (typeof body.style !== 'string') throw badRequest('Escolha um estilo de hook.');
    if (body.idea !== undefined && body.idea !== null && typeof body.idea !== 'string') throw badRequest('Ideia inválida.');
    const idea = typeof body.idea === 'string' && body.idea.trim() ? parseText(body.idea, 'Ideia', { min: 3, max: MAX_HOOK_IDEA_LENGTH }) : '';
    const hooks = await service.create(req.actor, { style: body.style, idea, durationMs: body.durationMs, count: body.count === undefined ? 1 : body.count });
    res.status(201).json({ hooks });
  });

  router.get('/:id/file', throttle(readLimiter), async (req, res, next) => {
    try {
      const { filePath, id } = await service.openFile(req.actor, parseId(req.params.id));
      res.set({
        'Content-Type': 'video/mp4',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="hook-${id}.mp4"`,
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.sendFile(filePath, { cacheControl: false, dotfiles: 'deny', acceptRanges: true }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/apply', throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    const hook = await service.apply(req.actor, parseId(req.params.id), {
      creativeId: body.creativeId === undefined || body.creativeId === null ? null : parseId(body.creativeId),
      name: body.name === undefined || body.name === null || body.name === '' ? null : parseText(body.name, 'Nome', { min: 1, max: 100 }),
    });
    res.status(202).json({ hook });
  });

  router.delete('/:id', throttle(writeLimiter), async (req, res) => {
    await service.remove(req.actor, parseId(req.params.id));
    res.status(204).end();
  });

  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
    createLimiter.stop();
  };
  return router;
}
