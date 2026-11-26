import { Router } from 'express';
import { BELL_LIMIT, validateNotificationInput } from '../../../shared/notifications.js';
import { badRequest, notFound, tooMany, validationError } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId } from '../../lib/validation.js';

const throttle = (limiter) => (req, _res, next) => {
  const result = limiter.consume(String(req.user.id));
  return result.allowed ? next() : next(tooMany(result.retryAfterSec));
};
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sino da pessoa logada (montado em /api/notifications, depois de sessão + conta aprovada + CSRF). Sempre a PESSOA (`req.user`), também quando é
 * colaborador: as notificações são dela, não do espaço de trabalho.
 *  - GET  /          { notifications: [{ id, title, body, level, link, createdAt, read }], unread }
 *  - POST /read      { ids: [..] } marca algumas como lidas, ou { all: true } marca todas
 */
export function createNotificationsRouter({ repo, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.notificationsRead ?? 120, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.notificationsWrite ?? 60, windowMs: 60 * 1000 });

  router.get('/', throttle(readLimiter), async (req, res) => {
    const [notifications, unread] = await Promise.all([repo.listForUser(req.user.id, BELL_LIMIT), repo.unreadCount(req.user.id)]);
    res.json({ notifications, unread });
  });

  router.post('/read', throttle(writeLimiter), async (req, res) => {
    const body = asObject(req.body);
    const some = Array.isArray(body.ids) && body.ids.length >= 1 && body.ids.length <= 100;
    if (body.all !== true && !some) throw badRequest('Informe as notificações (de 1 a 100) ou "all".');
    await repo.markRead(req.user.id, body.all === true ? null : [...new Set(body.ids.map(parseId))]);
    res.json({ unread: await repo.unreadCount(req.user.id) });
  });

  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
  };
  return router;
}

/**
 * Notificações no painel do admin (montado em /api/admin/notifications, só admin dono do espaço).
 *  - GET    /            tudo o que foi enviado, com quantas pessoas já leram
 *  - POST   /            envia (todos os usuários ou uma pessoa)
 *  - PATCH  /:id         { active } desativa/reativa (some do sino de todo mundo)
 *  - DELETE /:id
 */
export function createAdminNotificationsRouter({ repo, users, audit, now = () => new Date(), limits = {} }) {
  const router = Router();
  const writeLimiter = new RateLimiter({ max: limits.notificationsSend ?? 60, windowMs: 60 * 60 * 1000 });

  router.get('/', async (_req, res) => {
    res.json({ notifications: await repo.adminList(100) });
  });

  router.post('/', throttle(writeLimiter), async (req, res) => {
    const { value, errors } = validateNotificationInput(asObject(req.body));
    if (!value) throw validationError(errors);
    if (value.audience === 'user') {
      const target = await users.findById(value.userId);
      if (!target) throw validationError([{ path: 'userId', message: 'Pessoa não encontrada.' }]);
      if (target.status !== 'approved') throw validationError([{ path: 'userId', message: 'Só dá para enviar para contas aprovadas.' }]);
    }
    const expiresAt = value.expiresInDays ? new Date(now().getTime() + value.expiresInDays * DAY_MS) : null;
    const id = await repo.create({ ...value, targetUserId: value.userId, expiresAt, createdBy: req.user.id });
    await audit.record({ adminId: req.user.id, targetId: value.userId, action: 'notification_send', detail: `${value.audience === 'all' ? 'Para todos' : 'Para uma pessoa'}: ${value.title}`, ip: req.ip });
    res.status(201).json({ id });
  });

  router.patch('/:id', throttle(writeLimiter), async (req, res) => {
    const id = parseId(req.params.id);
    const body = asObject(req.body);
    if (typeof body.active !== 'boolean') throw badRequest('Informe se a notificação fica ativa.');
    if (!(await repo.setActive(id, body.active))) throw notFound('Notificação não encontrada.');
    await audit.record({ adminId: req.user.id, action: 'notification_change', detail: `${body.active ? 'Reativou' : 'Desativou'} a notificação ${id}`, ip: req.ip });
    res.json({ ok: true });
  });

  router.delete('/:id', throttle(writeLimiter), async (req, res) => {
    const id = parseId(req.params.id);
    if (!(await repo.remove(id))) throw notFound('Notificação não encontrada.');
    await audit.record({ adminId: req.user.id, action: 'notification_change', detail: `Excluiu a notificação ${id}`, ip: req.ip });
    res.status(204).end();
  });

  router.stop = () => writeLimiter.stop();
  return router;
}
