import { Router } from 'express';
import { USER_STATUSES } from '../../db/constants.js';
import { badRequest, forbidden, notFound } from '../../lib/http-error.js';
import { asObject, parseEnum, parseId } from '../../lib/validation.js';
import { toPublicUser } from '../users/users.repository.js';

export function createAdminRouter({ users, sessions }) {
  const router = Router();

  router.get('/stats', async (_req, res) => {
    res.json({ counts: await users.counts() });
  });

  router.get('/users', async (req, res) => {
    const status = req.query.status === undefined ? undefined : parseEnum(req.query.status, USER_STATUSES, 'Status');
    res.json({ users: await users.list(status) });
  });

  router.patch('/users/:id/status', async (req, res) => {
    const id = parseId(req.params.id);
    const status = parseEnum(asObject(req.body).status, USER_STATUSES, 'Status');
    const target = await users.findById(id);
    if (!target) throw notFound('Usuário não encontrado.');
    if (target.role === 'admin') throw forbidden('Contas de administrador não podem ser alteradas.');
    if (target.id === req.user.id) throw badRequest('Você não pode alterar a própria conta.');

    await users.updateStatus(id, status, req.user.id);
    // Qualquer status diferente de "approved" derruba as sessões imediatamente.
    if (status !== 'approved' && status !== 'pending') await sessions.destroyAllForUser(id);
    res.json({ user: toPublicUser(await users.findById(id)) });
  });

  return router;
}
