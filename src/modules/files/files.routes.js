import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { parseId } from '../../lib/validation.js';

/** Cabeçalho de download seguro: nome ASCII de reserva + nome completo codificado (RFC 5987), sem aspas nem quebras de linha. */
function attachmentHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_'); // só ASCII imprimível, sem aspas, barra invertida nem ponto e vírgula
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * Anexos da conta (sessão, conta aprovada, CSRF e a área "Contas TikTok" já exigidos no app.js).
 *  - GET    /api/files                  lista (sem conteúdo)
 *  - POST   /api/files?filename=…       arquivo no corpo (binário)
 *  - GET    /api/files/:id/download     baixa (sempre como download)
 *  - DELETE /api/files/:id
 * Os dados são do espaço de trabalho (`req.actor`); quem enviou é a pessoa (`req.user`).
 */
export function createFilesRouter({ service, limits = {} }) {
  const router = Router();
  const read = new RateLimiter({ max: limits.filesRead ?? 120, windowMs: 60 * 1000 });
  const write = new RateLimiter({ max: limits.filesWrite ?? 30, windowMs: 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };

  router.get('/', throttle(read), async (req, res) => {
    res.json(await service.list(req.actor));
  });

  router.post('/', throttle(write), async (req, res) => {
    res.set('Connection', 'close'); // recusa antes de ler o corpo inteiro, sem deixar o navegador enviando
    const rawLength = req.headers['content-length'];
    const contentLength = rawLength === undefined ? null : Number(rawLength);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) throw badRequest('Tamanho do envio inválido.');
    if (typeof req.query.filename !== 'string') throw badRequest('Informe o nome do arquivo.');
    const file = await service.upload(req.actor, req.user, { stream: req, filename: req.query.filename, contentLength });
    res.set('Connection', 'keep-alive');
    res.status(201).json({ file });
  });

  router.get('/:id/download', throttle(read), async (req, res) => {
    const { name, data } = await service.download(req.actor, parseId(req.params.id));
    res.set({
      'Content-Type': 'application/octet-stream', // nunca o tipo do arquivo: o navegador não o abre nem interpreta
      'Content-Disposition': attachmentHeader(name),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store', // arquivo sensível: não fica em cache do navegador
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.send(data);
  });

  router.delete('/:id', throttle(write), async (req, res) => {
    await service.remove(req.actor, parseId(req.params.id));
    res.status(204).end();
  });

  router.stop = () => [read, write].forEach((l) => l.stop());
  return router;
}
