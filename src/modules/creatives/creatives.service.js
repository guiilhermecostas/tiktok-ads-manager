import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { collectCreativeRefs } from '../../../shared/campaign-spec.js';
import { MAX_FOLDER_DEPTH } from '../../../shared/creative-folders.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { DECLARED_TYPES, MIME_BY_EXT, sniffCreativeType } from './creative-types.js';

/** ID de mídia do TikTok (ex.: "v10033g50000…", "ad-site-i18n/2020/abc"): sem "..", sem "//", começa/termina alfanumérico. */
const MEDIA_ID_RE = /^(?!.*(?:\.\.|\/\/))[A-Za-z0-9][\w\-./:]{2,198}[A-Za-z0-9]$/;

/** Teto do arquivo LIMPO enviado ao TikTok (limites do próprio TikTok; a recodificação pode aumentar o arquivo). */
const CLEAN_OUTPUT_MAX_BYTES = { video: 500 * 1024 * 1024, image: 10 * 1024 * 1024 };

/** Pastas por usuário (todas, em qualquer nível). */
export const MAX_FOLDERS = 100;
/** Criativos movidos de uma vez. */
export const MAX_MOVE_BATCH = 100;

/**
 * Regras de negócio da biblioteca de criativos.
 * Todo acesso é escopado ao usuário autenticado (`actor`): criativo de outro usuário é sempre "não encontrado".
 */
export function createCreativesService({ repo, storage, cleaner, tiktok, config, log = console }) {
  const limits = config.creatives;
  const maxBytesFor = (kind) => (kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes);

  async function requireOwned(actor, id) {
    const row = await repo.getInternal(actor.id, id);
    if (!row) throw notFound('Criativo não encontrado.');
    return row;
  }

  async function requireFolder(actor, id) {
    const folder = await repo.getFolder(actor.id, id);
    if (!folder) throw notFound('Pasta não encontrada.');
    return folder;
  }

  /** Remove o arquivo sem derrubar a requisição: sobra de disco não pode virar erro para o usuário. */
  const discardFile = (key) => storage.remove(key).catch((err) => log.error('[criativos] não foi possível apagar o arquivo:', err.code ?? err.message));

  async function removeOne(actor, id) {
    await requireOwned(actor, id);
    const using = await repo.findDraftCampaignsUsing(actor.id, id);
    if (using.length) {
      const err = new HttpError(409, `Este criativo é usado em rascunho(s) de campanha: ${using.map((c) => `"${c.name}"`).join(', ')}. Troque o criativo nelas antes de excluir.`, 'creative_in_use');
      err.details = using.map((c) => ({ path: 'campaign', message: String(c.id) }));
      throw err;
    }
    const removed = await repo.remove(actor.id, id);
    if (removed?.storage_key) await discardFile(removed.storage_key);
  }

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

    // ---------- pastas (uma por oferta; cada pasta pode ter subpastas, até MAX_FOLDER_DEPTH níveis) ----------
    listFolders: (actor) => repo.folders(actor.id),

    /** Cria a pasta; com `parentId`, ela fica DENTRO dessa pasta (que precisa ser do usuário e ter espaço para mais um nível). */
    async createFolder(actor, name, parentId = null) {
      if ((await repo.countFolders(actor.id)) >= MAX_FOLDERS) throw new HttpError(409, `Você já tem ${MAX_FOLDERS} pastas (o máximo). Apague alguma para criar outra.`, 'too_many_folders');
      let parent = null;
      if (parentId !== null) {
        parent = await requireFolder(actor, parentId);
        if ((await repo.folderDepth(actor.id, parentId)) >= MAX_FOLDER_DEPTH) throw new HttpError(409, `As pastas podem ter até ${MAX_FOLDER_DEPTH} níveis. Crie esta pasta em outro lugar.`, 'folder_too_deep');
      }
      try {
        const id = await repo.createFolder(actor.id, name, parentId);
        if (id === null) throw notFound('Pasta não encontrada.'); // o pai sumiu entre a conferência e a criação
        return { id, name, parentId, count: 0 };
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, parent ? `Já existe uma pasta chamada "${name}" dentro de "${parent.name}".` : `Já existe uma pasta chamada "${name}".`, 'folder_exists');
        throw err;
      }
    },

    async renameFolder(actor, id, name) {
      try {
        if (!(await repo.renameFolder(actor.id, id, name))) throw notFound('Pasta não encontrada.');
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, `Já existe uma pasta chamada "${name}" neste lugar.`, 'folder_exists');
        throw err;
      }
      return { id, name };
    },

    /** Apaga a pasta e as subpastas dela: os criativos NÃO são apagados, voltam para "sem pasta". Devolve quantos voltaram e quantas subpastas foram apagadas. */
    async deleteFolder(actor, id) {
      const result = await repo.deleteFolder(actor.id, id);
      if (result === null) throw notFound('Pasta não encontrada.');
      return { moved: result.files, subfolders: result.folders };
    },

    /** Move 1 a 100 criativos para uma pasta (ou `null` = sem pasta). Tudo ou nada: ID de outra pessoa ou pasta inexistente = 404, nada muda. */
    async move(actor, ids, folderId) {
      const unique = [...new Set(ids)];
      if (folderId !== null) await requireFolder(actor, folderId);
      const changed = await repo.moveToFolder(actor.id, unique, folderId);
      if (changed !== unique.length) throw notFound('Algum criativo não foi encontrado na sua biblioteca.');
      return { moved: changed };
    },

    /**
     * Recebe o arquivo (fluxo bruto), valida pelo CONTEÚDO, aplica limites/cota/duplicidade e grava.
     * @param {{ stream: import('node:stream').Readable, contentType: string, contentLength: number|null, name: string, filename: string }} upload
     */
    async upload(actor, { stream, contentType, contentLength, name, filename, folderId = null }) {
      if (folderId !== null) await requireFolder(actor, folderId); // 404 se a pasta não for do usuário (antes de gastar banda)
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
            sha256: received.sha256, md5: received.md5, storageKey: committedKey, folderId,
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

    /**
     * Guarda na biblioteca um VÍDEO gerado pelo próprio sistema (ex.: hook + vídeo), vindo de um arquivo local. Mesmas regras do
     * envio: confere o conteúdo, a cota e a duplicidade, e grava com nome aleatório. Fica marcado como "gerado por IA".
     */
    async adoptGenerated(actor, { name, sourcePath, filename, folderId = null }) {
      const used = await repo.usedBytes(actor.id);
      const tempFile = storage.tempPath();
      try {
        const received = await storage.receive(fs.createReadStream(sourcePath), tempFile, { maxBytes: limits.maxVideoBytes }).catch((err) => {
          if (err instanceof HttpError) throw new HttpError(413, `O vídeo gerado excede o limite de ${Math.round(limits.maxVideoBytes / 1024 / 1024)} MB.`, 'file_too_large');
          throw err;
        });
        if (received.size === 0) throw badRequest('O vídeo gerado está vazio.', 'empty_file');
        if (used + received.size > limits.quotaBytes) throw new HttpError(413, 'Sua biblioteca atingiu o limite de armazenamento. Exclua criativos para liberar espaço.', 'quota_exceeded');
        const actual = sniffCreativeType(received.head);
        if (!actual || actual.kind !== 'video') throw new HttpError(415, 'O arquivo gerado não é um vídeo válido.', 'content_mismatch');
        const duplicate = await repo.findByHash(actor.id, received.sha256);
        if (duplicate) throw new HttpError(409, `Este vídeo já está na sua biblioteca como "${duplicate.name}".`, 'duplicate_creative');
        const committedKey = await storage.commit(tempFile, actor.id, actual.ext);
        let id;
        try {
          id = await repo.createUpload(actor.id, {
            name, kind: 'video', originalFilename: filename, mimeType: actual.mime, sizeBytes: received.size,
            sha256: received.sha256, md5: received.md5, storageKey: committedKey, aiGenerated: true, folderId,
          });
        } catch (err) {
          await discardFile(committedKey);
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
    remove: removeOne,

    /**
     * Exclui vários (1 a 100), um por vez e cada um com as MESMAS regras de `remove` (dono, rascunho de campanha que usa o criativo).
     * Quem não puder sair fica e vem em `failed` com o motivo; os demais são excluídos mesmo assim.
     */
    async removeMany(actor, ids) {
      const failed = [];
      let removed = 0;
      for (const id of new Set(ids)) {
        try {
          await removeOne(actor, id);
          removed += 1;
        } catch (err) {
          if (!(err instanceof HttpError)) throw err; // falha inesperada (banco fora do ar…) não vira "motivo": a requisição inteira falha
          failed.push({ id, message: err.message });
        }
      }
      return { removed, failed };
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
     *  - Arquivo da biblioteca: é LIMPO e refeito (sem metadados e hash original, cantos do início e do fim alterados) e a
     *    versão única é enviada. Isso acontece para CADA campanha e CADA conta de anúncio: a mesma campanha em 3 contas envia
     *    3 versões diferentes. Uma nova tentativa da mesma campanha na mesma conta reaproveita o envio já feito.
     *  - Criativo que já existia no TikTok (referência por ID): usa o ID guardado, só na conta a que ele pertence.
     * Retorna { videoId, coverImageId, imageIds } com os IDs do TikTok.
     */
    async resolveForPublish({ actor, campaignId, advertiserId, config: campaignConfig }) {
      const refs = collectCreativeRefs(campaignConfig);
      const rows = new Map((await repo.getManyInternal(actor.id, [...new Set(refs.map((r) => r.id))])).map((r) => [r.id, r]));
      const tiktokIdOf = new Map();

      for (const ref of refs) {
        if (tiktokIdOf.has(ref.id)) continue;
        const row = rows.get(ref.id);
        if (!row) throw badRequest('Um dos criativos escolhidos não existe mais na sua biblioteca.', 'creative_missing');

        if (!row.storage_key) {
          const referenced = await repo.findAsset(row.id, advertiserId);
          if (!referenced) {
            throw badRequest(`O criativo "${row.name}" pertence a outra conta de anúncio do TikTok. Escolha outro ou envie o arquivo para a biblioteca.`, 'creative_wrong_account');
          }
          tiktokIdOf.set(row.id, referenced);
          continue;
        }

        let tiktokId = await repo.findCampaignAsset(campaignId, row.id, advertiserId);
        if (!tiktokId) {
          const cleaned = await cleaner.clean({
            inputPath: storage.pathFor(row.storage_key),
            kind: row.kind,
            ext: row.storage_key.split('.').pop(),
            originalSha256: row.sha256,
            maxOutputBytes: CLEAN_OUTPUT_MAX_BYTES[row.kind],
            name: row.name,
          });
          try {
            tiktokId = await tiktok.uploadCreative({
              actor, advertiserId, kind: row.kind, filePath: cleaned.filePath, fileName: `${randomBytes(8).toString('hex')}.${cleaned.ext}`, md5: cleaned.md5,
            });
            await repo.saveCampaignAsset({ campaignId, creativeId: row.id, advertiserId, tiktokId, variantSha256: cleaned.sha256 });
          } finally {
            await cleaned.discard().catch((err) => log.error('[criativos] não foi possível apagar a versão limpa:', err.code ?? err.message));
          }
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
