import { Router } from 'express';
import { normalizeAreas } from '../../../shared/permissions.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { asObject, parseEmail, parseId, parsePassword, parseText } from '../../lib/validation.js';
import { sessionCookieOptions } from '../../middleware/session.js';
import { presentSession } from '../auth/session-view.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes em base64url

function parseAreas(value) {
  const areas = normalizeAreas(value);
  if (!areas) throw badRequest('Escolha ao menos uma área de acesso válida.');
  return areas;
}

/**
 * Gerenciamento da equipe. Montado atrás de sessão + conta aprovada + "somente o dono do espaço" (veja app.js):
 * colaborador nenhum chega aqui, nem com "acesso total".
 */
export function createTeamRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.teamRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.teamWrite ?? 30, windowMs: 60 * 1000 });
  const inviteLimiter = new RateLimiter({ max: limits.teamInvite ?? 20, windowMs: 60 * 60 * 1000 }); // cada envio é um e-mail de verdade
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const read = throttle(readLimiter);
  const write = throttle(writeLimiter);
  const send = [write, throttle(inviteLimiter)];

  router.get('/', read, async (req, res) => {
    res.json(await service.overview(req.user));
  });

  router.post('/invites', ...send, async (req, res) => {
    const body = asObject(req.body);
    const input = { email: parseEmail(body.email), name: parseText(body.name, 'Nome'), areas: parseAreas(body.areas) };
    res.status(201).json(await service.invite(req.user, input));
  });

  router.post('/invites/:id/resend', ...send, async (req, res) => {
    res.json(await service.resend(req.user, parseId(req.params.id)));
  });

  router.delete('/invites/:id', write, async (req, res) => {
    await service.cancelInvite(req.user, parseId(req.params.id));
    res.status(204).end();
  });

  router.patch('/members/:id', write, async (req, res) => {
    const areas = parseAreas(asObject(req.body).areas);
    res.json({ member: await service.updateMember(req.user, parseId(req.params.id), areas) });
  });

  router.delete('/members/:id', write, async (req, res) => {
    await service.removeMember(req.user, parseId(req.params.id));
    res.status(204).end();
  });

  router.stop = () => [readLimiter, writeLimiter, inviteLimiter].forEach((l) => l.stop());
  return router;
}

/**
 * Aceite do convite (PÚBLICO: a pessoa ainda não tem conta). Quem vale é o token de 256 bits do e-mail, de uso único e com
 * validade. Limites por IP contra tentativa de adivinhar tokens.
 */
export function createInvitationsRouter({ service, sessions, config, limits = {} }) {
  const router = Router();
  const lookupLimiter = new RateLimiter({ max: limits.inviteLookup ?? 30, windowMs: 15 * 60 * 1000 });
  const acceptLimiter = new RateLimiter({ max: limits.inviteAccept ?? 10, windowMs: 15 * 60 * 1000 });
  const enforce = (limiter, key) => {
    const result = limiter.consume(key);
    if (!result.allowed) throw tooMany(result.retryAfterSec);
  };
  // O token vem no corpo (POST), nunca na URL: assim não aparece em logs de acesso nem no histórico.
  const parseToken = (value) => {
    if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw badRequest('Convite inválido ou expirado. Peça um novo convite a quem convidou você.');
    return value;
  };

  router.post('/lookup', async (req, res) => {
    enforce(lookupLimiter, req.ip);
    res.json({ invitation: await service.lookupInvite(parseToken(asObject(req.body).token)) });
  });

  router.post('/accept', async (req, res) => {
    enforce(acceptLimiter, req.ip);
    const body = asObject(req.body);
    const token = parseToken(body.token);
    const input = { name: body.name === undefined ? undefined : parseText(body.name, 'Nome'), password: parsePassword(body.password) };
    const { session } = await service.acceptInvite(token, input);
    if (req.sessionToken) await sessions.destroy(req.sessionToken); // anti session-fixation: descarta a sessão anterior (como no login)
    res.set('Cache-Control', 'no-store');
    res.cookie(config.cookieName, session.token, sessionCookieOptions(config, session.expiresAt));
    const found = await sessions.resolve(session.token); // a pessoa recém-criada e o espaço onde ela vai trabalhar
    res.status(201).json({ ...presentSession(found.user, found.member), csrfToken: session.csrfToken });
  });

  router.stop = () => [lookupLimiter, acceptLimiter].forEach((l) => l.stop());
  return router;
}
