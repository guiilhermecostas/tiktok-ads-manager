import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { requireArea } from '../../middleware/workspace.js';

const MAX_SPAN_MS = 93 * 24 * 60 * 60 * 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Período pedido (`from` inclusive, `to` exclusivo), em ISO UTC (a tela manda a meia-noite local dela). Máximo de 93 dias. */
export function parsePeriod(query) {
  const from = typeof query.from === 'string' && ISO_RE.test(query.from) ? new Date(query.from) : null;
  const to = typeof query.to === 'string' && ISO_RE.test(query.to) ? new Date(query.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('Informe o período (from e to em formato ISO, ex.: 2026-11-25T03:00:00Z).');
  if (to <= from) throw badRequest('O fim do período precisa ser depois do começo.');
  if (to.getTime() - from.getTime() > MAX_SPAN_MS) throw badRequest('O período pode ter no máximo 93 dias.');
  return { from, to };
}

/**
 * Dados que o assistente do Início pede ao servidor (montado em /api/assistant, depois de sessão + conta aprovada; cada rota exige a sua área):
 *  - GET /accounts-down?from=&to=   contas cuja situação MUDOU no período (e as que não estão ativas agora). Área "Contas TikTok".
 *  - GET /creatives?from=&to=       quantos criativos foram enviados no período. Área "Criativos".
 * Sempre dos dados do dono do espaço (`req.actor`); só leitura.
 */
export function createAssistantRouter({ status, creatives, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.assistantRead ?? 60, windowMs: 60 * 1000 });
  const throttle = (req, _res, next) => {
    const result = readLimiter.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };

  router.get('/accounts-down', requireArea('accounts'), throttle, async (req, res) => {
    const { from, to } = parsePeriod(req.query);
    const [events, current, monitoredSince, monitored] = await Promise.all([
      status.eventsBetween(req.actor.id, from, to), status.currentlyNotEnabled(req.actor.id), status.monitoredSince(req.actor.id), status.totalMonitored(req.actor.id),
    ]);
    res.json({ events, current, monitoredSince, monitored });
  });

  router.get('/creatives', requireArea('creatives'), throttle, async (req, res) => {
    const { from, to } = parsePeriod(req.query);
    res.json(await creatives.countBetween(req.actor.id, from, to));
  });

  router.stop = () => readLimiter.stop();
  return router;
}
