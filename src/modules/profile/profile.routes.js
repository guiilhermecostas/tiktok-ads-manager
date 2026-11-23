import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseId, parseText } from '../../lib/validation.js';

function limiter(max, windowMs) {
  const instance = new RateLimiter({ max, windowMs });
  const middleware = (req, _res, next) => {
    const result = instance.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  return { instance, middleware };
}

/**
 * Perfil da pessoa logada (sessão + conta aprovada + CSRF já garantidos pelo roteador pai). Usa `req.user` (a PESSOA, também
 * quando é colaborador), nunca `req.actor`: o nome e a foto são dela, não do espaço de trabalho.
 *  - PATCH /api/profile         { name }
 *  - POST  /api/profile/avatar  foto no corpo (binário, image/jpeg ou image/png)
 *  - DELETE /api/profile/avatar
 */
export function createProfileRouter({ service, limits = {} }) {
  const router = Router();
  const write = limiter(limits.profileWrite ?? 20, 60 * 1000);

  router.patch('/', write.middleware, async (req, res) => {
    const name = parseText(asObject(req.body).name, 'Nome');
    res.json({ name: await service.updateName(req.user, name) }); // só o nome: e-mail, função e status nunca vêm do cliente
  });

  router.post('/avatar', write.middleware, async (req, res) => {
    res.set('Connection', 'close'); // recusa antes de ler o corpo: não deixa o navegador enviando o que será descartado
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const rawLength = req.headers['content-length'];
    const contentLength = rawLength === undefined ? null : Number(rawLength);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) throw badRequest('Tamanho do envio inválido.');
    const result = await service.setAvatar(req.user, { stream: req, contentType, contentLength });
    res.set('Connection', 'keep-alive');
    res.status(201).json(result);
  });

  router.delete('/avatar', write.middleware, async (req, res) => {
    await service.removeAvatar(req.user);
    res.status(204).end();
  });

  router.stop = () => write.instance.stop();
  return router;
}

/**
 * GET /api/avatars/:userId : a imagem (sempre o JPEG gerado pelo servidor). Só a própria pessoa, o dono do espaço, os colegas de
 * equipe e o admin; qualquer outra tentativa recebe 404. A tela usa `?v=<versão>` para buscar de novo só quando a foto muda.
 */
export function createAvatarsRouter({ service, limits = {} }) {
  const router = Router();
  const read = limiter(limits.avatarRead ?? 600, 60 * 1000);

  router.get('/:userId', read.middleware, async (req, res) => {
    const avatar = await service.viewAvatar(
      { viewer: req.user, workspaceOwnerId: req.workspace.ownerId, isSupervisor: req.user.role === 'admin' && req.workspace.isOwner },
      parseId(req.params.userId),
    );
    res.set({
      'Content-Type': avatar.mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600', // só o navegador de quem pediu; a URL traz a versão, então a troca aparece na hora
      'Content-Disposition': 'inline; filename="avatar.jpg"',
    });
    res.send(avatar.data);
  });

  router.stop = () => read.instance.stop();
  return router;
}
