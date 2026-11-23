import { Router } from 'express';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { asObject, parseEnum, parseId, parseText } from '../../lib/validation.js';

import { MAX_MOVE_BATCH } from './creatives.service.js';

const NUMERIC_ID_RE = /^\d{1,24}$/;
const KINDS = ['image', 'video'];
const MAX_FOLDER_NAME = 60;

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
    const result = limiter.consume(String(req.actor.id));
    return result.allowed ? next() : next(tooMany(result.retryAfterSec));
  };
  const read = throttle(readLimiter);
  const write = throttle(writeLimiter);

  /** Pasta no filtro/envio: ID numérico (ou, só no filtro, "none" = sem pasta). */
  const parseFolderQuery = (value, { allowNone }) => {
    if (value === undefined || value === '') return undefined;
    if (allowNone && value === 'none') return 'none';
    if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) throw badRequest('Pasta inválida.');
    return parseId(value);
  };

  // ---------- pastas (declaradas ANTES de "/:id") ----------
  router.get('/folders', read, async (req, res) => {
    res.json(await service.listFolders(req.actor));
  });

  router.post('/folders', write, async (req, res) => {
    res.status(201).json({ folder: await service.createFolder(req.actor, parseText(asObject(req.body).name, 'Nome da pasta', { min: 1, max: MAX_FOLDER_NAME })) });
  });

  router.patch('/folders/:id', write, async (req, res) => {
    res.json({ folder: await service.renameFolder(req.actor, parseId(req.params.id), parseText(asObject(req.body).name, 'Nome da pasta', { min: 1, max: MAX_FOLDER_NAME })) });
  });

  // Apagar a pasta NÃO apaga os criativos: eles voltam para "sem pasta".
  router.delete('/folders/:id', write, async (req, res) => {
    res.json(await service.deleteFolder(req.actor, parseId(req.params.id)));
  });

  // Mover vários criativos de uma vez: { ids: [1, 2, …], folderId: 3 | null } (tudo ou nada).
  router.post('/move', write, async (req, res) => {
    const { ids, folderId } = asObject(req.body);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_MOVE_BATCH) throw badRequest(`Escolha de 1 a ${MAX_MOVE_BATCH} criativos.`);
    if (folderId !== null && !Number.isInteger(folderId)) throw badRequest('Pasta inválida.');
    res.json(await service.move(req.actor, ids.map((id) => parseId(id)), folderId === null ? null : parseId(folderId)));
  });

  router.get('/', read, async (req, res) => {
    const { kind, q } = req.query;
    const limit = req.query.limit === undefined ? 60 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('Limite inválido (1 a 100).');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw badRequest('Deslocamento inválido.');
    res.json(
      await service.list(req.actor, {
        kind: kind === undefined ? undefined : parseEnum(kind, KINDS, 'Tipo'),
        q: q === undefined || q === '' ? undefined : parseText(q, 'Busca', { min: 1, max: 100 }),
        folderId: parseFolderQuery(req.query.folderId, { allowNone: true }),
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

    const folderId = parseFolderQuery(req.query.folderId, { allowNone: false }) ?? null;
    const creative = await service.upload(req.actor, { stream: req, contentType, contentLength, name, filename, folderId });
    res.set('Connection', 'keep-alive');
    res.status(201).json({ creative });
  });

  // Criativo que já existe na conta do TikTok: guarda só a referência (ID) para usar nas campanhas.
  router.post('/tiktok', write, async (req, res) => {
    const body = asObject(req.body);
    const advertiserId = typeof body.advertiserId === 'string' ? body.advertiserId.trim() : '';
    if (!NUMERIC_ID_RE.test(advertiserId)) throw badRequest('Conta de anúncio inválida.');
    const tiktokId = typeof body.tiktokId === 'string' ? body.tiktokId.trim() : '';
    const creative = await service.registerTikTok(req.actor, {
      name: parseText(body.name, 'Nome', { min: 1, max: 100 }),
      kind: parseEnum(body.kind, KINDS, 'Tipo'),
      advertiserId,
      tiktokId,
    });
    res.status(201).json({ creative });
  });

  router.get('/:id', read, async (req, res) => {
    res.json({ creative: await service.get(req.actor, parseId(req.params.id)) });
  });

  // Renomear e/ou mudar de pasta: { name?, folderId? } (folderId nulo = sem pasta). Pelo menos um dos dois.
  router.patch('/:id', write, async (req, res) => {
    const body = asObject(req.body);
    const id = parseId(req.params.id);
    const hasName = body.name !== undefined;
    const hasFolder = body.folderId !== undefined;
    if (!hasName && !hasFolder) throw badRequest('Nada para atualizar.');
    if (hasFolder && body.folderId !== null && !Number.isInteger(body.folderId)) throw badRequest('Pasta inválida.');
    const name = hasName ? parseText(body.name, 'Nome', { min: 1, max: 100 }) : null;
    if (hasFolder) await service.move(req.actor, [id], body.folderId === null ? null : parseId(body.folderId)); // antes do nome: se a pasta falhar, nada muda
    res.json({ creative: hasName ? await service.rename(req.actor, id, name) : await service.get(req.actor, id) });
  });

  router.delete('/:id', write, async (req, res) => {
    await service.remove(req.actor, parseId(req.params.id));
    res.status(204).end();
  });

  /**
   * Entrega o arquivo ao DONO (pré-visualização). Só os tipos que o próprio sistema gravou, com `nosniff` e uma CSP
   * `sandbox` que neutraliza qualquer conteúdo ativo mesmo que algo estranho passasse pela validação. Suporta Range (vídeo).
   */
  router.get('/:id/file', read, async (req, res, next) => {
    try {
      const { filePath, mime, ext, id } = await service.openFile(req.actor, parseId(req.params.id));
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
