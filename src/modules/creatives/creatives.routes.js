import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseEnum, parseId, parseText } from '../../lib/validation.js';

const NUMERIC_ID_RE = /^\d{1,24}$/;
const KINDS = ['image', 'video'];

/** Nome sugerido a partir do nome do arquivo (sem a extensão). */
const nameFromFilename = (filename) => filename.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim().slice(0, 100) || 'Criativo';

/**
 * Biblioteca de criativos (sessão + conta aprovada + CSRF já garantidos pelo roteador pai).
 * O ENVIO é binário puro (`POST /api/creatives?name=…&filename=…` com o arquivo no corpo e o Content-Type do arquivo):
 * sem multipart, sem carregar o arquivo na memória, com limite de tamanho aplicado durante a leitura.
 */
export function createCreativesRouter({ service, limits = {} }) {
  const router = Router();
  const readLimiter = new RateLimiter({ max: limits.creativesRead ?? 600, windowMs: 60 * 1000 });
  const writeLimiter = new RateLimiter({ max: limits.creativesWrite ?? 60, windowMs: 60 * 1000 });
  const throttle = (limiter) => (req, _res, next) => {
    const result = limiter.consume(String(req.user.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const read = throttle(readLimiter);
  const write = throttle(writeLimiter);

  router.get('/', read, async (req, res) => {
    const { kind, q } = req.query;
    const limit = req.query.limit === undefined ? 60 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('Limite inválido (1 a 100).');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw badRequest('Deslocamento inválido.');
    res.json(
      await service.list(req.user, {
        kind: kind === undefined ? undefined : parseEnum(kind, KINDS, 'Tipo'),
        q: q === undefined || q === '' ? undefined : parseText(q, 'Busca', { min: 1, max: 100 }),
        limit,
        offset,
      }),
    );
  });

  router.post('/', write, async (req, res) => {
    // Qualquer falha antes de ler o corpo: fecha a conexão em vez de deixar o navegador enviando um arquivo recusado.
    res.set('Connection', 'close');
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const rawLength = req.headers['content-length'];
    const contentLength = rawLength === undefined ? null : Number(rawLength);
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) throw badRequest('Tamanho do envio inválido.');

    const filename = parseText(req.query.filename ?? 'arquivo', 'Nome do arquivo', { min: 1, max: 200 });
    const name = req.query.name === undefined || req.query.name === '' ? nameFromFilename(filename) : parseText(req.query.name, 'Nome', { min: 1, max: 100 });

    const creative = await service.upload(req.user, { stream: req, contentType, contentLength, name, filename });
    res.set('Connection', 'keep-alive');
    res.status(201).json({ creative });
  });

  // Criativo que já existe na conta do TikTok: guarda só a referência (ID) para usar nas campanhas.
  router.post('/tiktok', write, async (req, res) => {
    const body = asObject(req.body);
    const advertiserId = typeof body.advertiserId === 'string' ? body.advertiserId.trim() : '';
    if (!NUMERIC_ID_RE.test(advertiserId)) throw badRequest('Conta de anúncio inválida.');
    const tiktokId = typeof body.tiktokId === 'string' ? body.tiktokId.trim() : '';
    const creative = await service.registerTikTok(req.user, {
      name: parseText(body.name, 'Nome', { min: 1, max: 100 }),
      kind: parseEnum(body.kind, KINDS, 'Tipo'),
      advertiserId,
      tiktokId,
    });
    res.status(201).json({ creative });
  });

  router.get('/:id', read, async (req, res) => {
    res.json({ creative: await service.get(req.user, parseId(req.params.id)) });
  });

  router.patch('/:id', write, async (req, res) => {
    const name = parseText(asObject(req.body).name, 'Nome', { min: 1, max: 100 });
    res.json({ creative: await service.rename(req.user, parseId(req.params.id), name) });
  });

  router.delete('/:id', write, async (req, res) => {
    await service.remove(req.user, parseId(req.params.id));
    res.status(204).end();
  });

  /**
   * Entrega o arquivo ao DONO (pré-visualização). Só os tipos que o próprio sistema gravou, com `nosniff` e uma CSP
   * `sandbox` que neutraliza qualquer conteúdo ativo mesmo que algo estranho passasse pela validação. Suporta Range (vídeo).
   */
  router.get('/:id/file', read, async (req, res, next) => {
    try {
      const { filePath, mime, ext, id } = await service.openFile(req.user, parseId(req.params.id));
      res.set({
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': `inline; filename="criativo-${id}.${ext}"`,
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.sendFile(filePath, { cacheControl: false, dotfiles: 'deny', acceptRanges: true }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (err) {
      next(err);
    }
  });

  router.stop = () => {
    readLimiter.stop();
    writeLimiter.stop();
  };
  return router;
}
