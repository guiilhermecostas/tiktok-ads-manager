import { collectCreativeRefs } from '../../../shared/campaign-spec.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { DECLARED_TYPES, MIME_BY_EXT, sniffCreativeType } from './creative-types.js';

/** ID de mídia do TikTok (ex.: "v10033g50000…", "ad-site-i18n/2020/abc"): sem "..", sem "//", começa/termina alfanumérico. */
const MEDIA_ID_RE = /^(?!.*(?:\.\.|\/\/))[A-Za-z0-9][\w\-./:]{2,198}[A-Za-z0-9]$/;

/**
 * Regras de negócio da biblioteca de criativos.
 * Todo acesso é escopado ao usuário autenticado (`actor`): criativo de outro usuário é sempre "não encontrado".
 */
export function createCreativesService({ repo, storage, tiktok, config, log = console }) {
  const limits = config.creatives;
  const maxBytesFor = (kind) => (kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes);

  async function requireOwned(actor, id) {
    const row = await repo.getInternal(actor.id, id);
    if (!row) throw notFound('Criativo não encontrado.');
    return row;
  }

  /** Remove o arquivo sem derrubar a requisição: sobra de disco não pode virar erro para o usuário. */
  const discardFile = (key) => storage.remove(key).catch((err) => log.error('[criativos] não foi possível apagar o arquivo:', err.code ?? err.message));

  return {
    limits,

    async list(actor, filters) {
      const [page, usedBytes] = await Promise.all([repo.list(actor.id, filters), repo.usedBytes(actor.id)]);
      return { ...page, usedBytes, quotaBytes: limits.quotaBytes, limits: { maxImageBytes: limits.maxImageBytes, maxVideoBytes: limits.maxVideoBytes } };
    },

    async get(actor, id) {
      const creative = await repo.get(actor.id, id);
      if (!creative) throw notFound('Criativo não encontrado.');
      return creative;
    },

    /**
     * Recebe o arquivo (fluxo bruto), valida pelo CONTEÚDO, aplica limites/cota/duplicidade e grava.
     * @param {{ stream: import('node:stream').Readable, contentType: string, contentLength: number|null, name: string, filename: string }} upload
     */
    async upload(actor, { stream, contentType, contentLength, name, filename }) {
      const declaredKind = DECLARED_TYPES[contentType];
      if (!declaredKind) throw new HttpError(415, 'Tipo de arquivo não suportado. Use JPG, PNG, MP4 ou MOV.', 'unsupported_media_type');
      const maxBytes = maxBytesFor(declaredKind);
      const limitText = `${Math.round(maxBytes / 1024 / 1024)} MB`;
      if (contentLength !== null && contentLength > maxBytes) throw new HttpError(413, `O arquivo excede o limite de ${limitText} para este tipo.`, 'file_too_large');

      const used = await repo.usedBytes(actor.id);
      if (used + (contentLength ?? 0) > limits.quotaBytes) throw new HttpError(413, 'Sua biblioteca atingiu o limite de armazenamento. Exclua criativos para liberar espaço.', 'quota_exceeded');

      const tempFile = storage.tempPath();
      try {
        let received;
        try {
          received = await storage.receive(stream, tempFile, { maxBytes });
        } catch (err) {
          if (err instanceof HttpError) throw new HttpError(413, `O arquivo excede o limite de ${limitText} para este tipo.`, 'file_too_large');
          throw err;
        }
        if (received.size === 0) throw badRequest('O arquivo está vazio.', 'empty_file');
        if (used + received.size > limits.quotaBytes) throw new HttpError(413, 'Sua biblioteca atingiu o limite de armazenamento. Exclua criativos para liberar espaço.', 'quota_exceeded');

        // O que vale é o conteúdo real, não o Content-Type informado.
        const actual = sniffCreativeType(received.head);
        if (!actual || actual.kind !== declaredKind) {
          throw new HttpError(415, 'O conteúdo do arquivo não corresponde a uma imagem JPG/PNG ou a um vídeo MP4/MOV válido.', 'content_mismatch');
        }

        const duplicate = await repo.findByHash(actor.id, received.sha256);
        if (duplicate) {
          const err = new HttpError(409, `Este arquivo já está na sua biblioteca como "${duplicate.name}".`, 'duplicate_creative');
          err.details = [{ path: 'file', message: String(duplicate.id) }];
          throw err;
        }

        const committedKey = await storage.commit(tempFile, actor.id, actual.ext);
        let id;
        try {
          id = await repo.createUpload(actor.id, {
            name, kind: actual.kind, originalFilename: filename, mimeType: actual.mime, sizeBytes: received.size,
            sha256: received.sha256, md5: received.md5, storageKey: committedKey,
          });
        } catch (err) {
          await discardFile(committedKey);
          if (isUniqueViolation(err)) throw new HttpError(409, 'Este arquivo já está na sua biblioteca.', 'duplicate_creative'); // dois envios iguais ao mesmo tempo
          throw err;
        }
        return repo.get(actor.id, id);
      } finally {
        await storage.removeTemp(tempFile).catch(() => {});
      }
    },

    /** Registra um criativo que já existe na conta do TikTok (só o ID, sem arquivo). */
    async registerTikTok(actor, { name, kind, advertiserId, tiktokId }) {
      if (!MEDIA_ID_RE.test(tiktokId)) throw badRequest('ID do TikTok inválido.', 'invalid_tiktok_id');
      await tiktok.assertAdvertiserAccess(actor, advertiserId); // 404 se a conta não for do usuário
      const id = await repo.createTikTokReference(actor.id, { name, kind, advertiserId, tiktokId });
      return repo.get(actor.id, id);
    },

    async rename(actor, id, name) {
      if (!(await repo.rename(actor.id, id, name))) throw notFound('Criativo não encontrado.');
      return repo.get(actor.id, id);
    },

    /** Exclui da biblioteca. Bloqueia se um rascunho de campanha ainda depende dele. */
    async remove(actor, id) {
      await requireOwned(actor, id);
      const using = await repo.findDraftCampaignsUsing(actor.id, id);
      if (using.length) {
        const err = new HttpError(409, `Este criativo é usado em rascunho(s) de campanha: ${using.map((c) => `"${c.name}"`).join(', ')}. Troque o criativo nelas antes de excluir.`, 'creative_in_use');
        err.details = using.map((c) => ({ path: 'campaign', message: String(c.id) }));
        throw err;
      }
      const removed = await repo.remove(actor.id, id);
      if (removed?.storage_key) await discardFile(removed.storage_key);
    },

    /** Caminho e tipo para servir o arquivo ao dono. */
    async openFile(actor, id) {
      const row = await requireOwned(actor, id);
      if (!row.storage_key) throw notFound('Este criativo não tem arquivo guardado aqui (é uma referência ao TikTok).');
      const ext = row.storage_key.split('.').pop();
      return { filePath: storage.pathFor(row.storage_key), mime: MIME_BY_EXT[ext], ext, id: row.id };
    },

    /**
     * Confere os criativos referenciados por uma campanha: precisam existir, ser do usuário e do tipo certo
     * (vídeo onde se espera vídeo, imagem onde se espera imagem). Retorna erros no formato { path, message }.
     */
    async verifyReferences(actor, campaignConfig) {
      const refs = collectCreativeRefs(campaignConfig);
      if (!refs.length) return [];
      const rows = new Map((await repo.getManyInternal(actor.id, [...new Set(refs.map((r) => r.id))])).map((r) => [r.id, r]));
      const errors = [];
      for (const ref of refs) {
        const row = rows.get(ref.id);
        if (!row) errors.push({ path: ref.path, message: 'Criativo não encontrado na sua biblioteca.' });
        else if (row.kind !== ref.kind) errors.push({ path: ref.path, message: `Escolha ${ref.kind === 'video' ? 'um vídeo' : 'uma imagem'}.` });
      }
      return errors;
    },

    /**
     * Antes de criar qualquer coisa no TikTok: garante que cada criativo usado esteja na conta de anúncio.
     * Reaproveita o ID de um envio anterior para a MESMA conta; senão envia o arquivo agora.
     * Retorna { videoId, coverImageId, imageIds } com os IDs do TikTok.
     */
    async resolveForPublish({ actor, advertiserId, config: campaignConfig }) {
      const refs = collectCreativeRefs(campaignConfig);
      const rows = new Map((await repo.getManyInternal(actor.id, [...new Set(refs.map((r) => r.id))])).map((r) => [r.id, r]));
      const tiktokIdOf = new Map();

      for (const ref of refs) {
        if (tiktokIdOf.has(ref.id)) continue;
        const row = rows.get(ref.id);
        if (!row) throw badRequest('Um dos criativos escolhidos não existe mais na sua biblioteca.', 'creative_missing');
        let tiktokId = await repo.findAsset(row.id, advertiserId);
        if (!tiktokId) {
          if (!row.storage_key) {
            throw badRequest(`O criativo "${row.name}" pertence a outra conta de anúncio do TikTok. Escolha outro ou envie o arquivo para a biblioteca.`, 'creative_wrong_account');
          }
          tiktokId = await tiktok.uploadCreative({
            actor, advertiserId, kind: row.kind, filePath: storage.pathFor(row.storage_key), fileName: `${row.id}.${row.storage_key.split('.').pop()}`, md5: row.md5,
          });
          await repo.saveAsset(row.id, advertiserId, tiktokId);
        }
        tiktokIdOf.set(row.id, tiktokId);
      }

      const ad = campaignConfig.ad;
      return {
        videoId: ad.videoCreativeId ? tiktokIdOf.get(ad.videoCreativeId) : undefined,
        coverImageId: ad.coverCreativeId ? tiktokIdOf.get(ad.coverCreativeId) : undefined,
        imageIds: (ad.imageCreativeIds ?? []).map((id) => tiktokIdOf.get(id)),
      };
    },
  };
}
