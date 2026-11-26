import { Router } from 'express';
import { USER_STATUSES } from '../../db/constants.js';
import { badRequest, forbidden, notFound, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseEnum, parseId } from '../../lib/validation.js';
import { sessionCookieOptions } from '../../middleware/session.js';
import { presentSession } from '../auth/session-view.js';
import { toPublicUser } from '../users/users.repository.js';

/**
 * Administração (montada em /api/admin, só admin dono do espaço):
 *  - GET   /stats, GET /users?status=              contagens e lista de contas
 *  - PATCH /users/:id/status { status }            aprovar, rejeitar, bloquear, reativar (derruba as sessões quando não é aprovada)
 *  - POST  /users/:id/impersonate                  abre a conta da pessoa em SOMENTE LEITURA, por 1 hora (a sessão do admin é trocada)
 *  - GET   /audit                                  últimas ações do admin (registro de auditoria)
 * A saída do acesso à conta de outra pessoa é POST /api/auth/impersonation/exit (quem está na conta dela já não é admin na sessão).
 */
export function createAdminRouter({ users, sessions, impersonation, audit, config, limits = {} }) {
  const router = Router();
  const impersonateLimiter = new RateLimiter({ max: limits.adminImpersonate ?? 30, windowMs: 60 * 60 * 1000 });

  router.get('/stats', async (_req, res) => {
    res.json({ counts: await users.counts() });
  });

  router.get('/users', async (req, res) => {
    const status = req.query.status === undefined ? undefined : parseEnum(req.query.status, USER_STATUSES, 'Status');
    res.json({ users: await users.list(status) });
  });

  router.get('/audit', async (_req, res) => {
    res.json({ entries: await audit.listRecent(50) });
  });

  router.patch('/users/:id/status', async (req, res) => {
    const id = parseId(req.params.id);
    const status = parseEnum(asObject(req.body).status, USER_STATUSES, 'Status');
    const target = await users.findById(id);
    if (!target) throw notFound('Usuário não encontrado.');
    if (target.role === 'admin') throw forbidden('Contas de administrador não podem ser alteradas.');
    if (target.id === req.user.id) throw badRequest('Você não pode alterar a própria conta.');

    await users.updateStatus(id, status, req.user.id);
    await audit.record({ adminId: req.user.id, targetId: id, action: 'status_change', detail: `${target.name}: ${target.status} → ${status}`, ip: req.ip });
    // Qualquer status diferente de "approved" derruba as sessões imediatamente (inclusive as abertas por admin nessa conta).
    if (status !== 'approved' && status !== 'pending') await sessions.destroyAllForUser(id);
    res.json({ user: toPublicUser(await users.findById(id)) });
  });

  router.post('/users/:id/impersonate', async (req, res) => {
    const id = parseId(req.params.id);
    const result = impersonateLimiter.consume(String(req.user.id));
    if (!result.allowed) throw tooMany(result.retryAfterSec);

    const { session } = await impersonation.start(req.user, id, { ip: req.ip });
    // Troca a sessão do navegador pela da pessoa (o admin volta pelo botão "Voltar ao admin": nada fica guardado no navegador).
    await sessions.destroy(req.sessionToken);
    res.cookie(config.cookieName, session.token, sessionCookieOptions(config, session.expiresAt));
    const found = await sessions.resolve(session.token);
    res.json({ ...presentSession(found.user, found.member), impersonation: { adminName: req.user.name }, csrfToken: session.csrfToken });
  });

  router.stop = () => impersonateLimiter.stop();
  return router;
}
