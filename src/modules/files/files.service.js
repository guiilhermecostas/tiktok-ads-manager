import { decryptBuffer, encryptBuffer } from '../../lib/crypto.js';
import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { ATTACHMENT_EXTENSIONS, MAX_FILES_PER_ACCOUNT, MAX_FILE_BYTES, MAX_TOTAL_BYTES, detectAttachment, sanitizeFilename } from './file-types.js';

const TOO_LARGE = () => new HttpError(413, `O arquivo excede o limite de ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 'file_too_large');

/** Lê o corpo inteiro na memória, parando (e recusando) ao passar do limite. O limite é pequeno (5 MB), então é seguro. */
async function readBody(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw TOO_LARGE();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Anexos da conta (ex.: arquivos de logins para a equipe). O conteúdo é criptografado em repouso (AES-256-GCM, com o ID do dono
 * como dado autenticado). `owner` é o dono do espaço (req.actor); `user` é a PESSOA que enviou (req.user).
 * Sem TOKEN_ENCRYPTION_KEY o recurso fica desligado: nada é gravado sem criptografia.
 */
export function createFilesService({ repo, encryptionKey }) {
  const requireKey = () => {
    if (!encryptionKey) throw new HttpError(503, 'Os anexos estão desligados: o servidor ainda não tem a TOKEN_ENCRYPTION_KEY configurada.', 'files_disabled');
  };

  return {
    enabled: Boolean(encryptionKey),
    limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES_PER_ACCOUNT, maxTotalBytes: MAX_TOTAL_BYTES, extensions: ATTACHMENT_EXTENSIONS },

    async list(owner) {
      return { enabled: Boolean(encryptionKey), files: await repo.list(owner.id), usage: await repo.usage(owner.id), limits: this.limits };
    },

    async upload(owner, user, { stream, filename, contentLength }) {
      requireKey();
      const name = sanitizeFilename(filename);
      if (!name) throw badRequest('Nome de arquivo inválido.');
      if (contentLength !== null && contentLength > MAX_FILE_BYTES) throw TOO_LARGE();
      const usage = await repo.usage(owner.id);
      if (usage.count >= MAX_FILES_PER_ACCOUNT) throw new HttpError(413, `Limite de ${MAX_FILES_PER_ACCOUNT} arquivos atingido. Exclua algum para enviar outro.`, 'quota_exceeded');

      const buffer = await readBody(stream, MAX_FILE_BYTES);
      if (buffer.length === 0) throw badRequest('O arquivo está vazio.', 'empty_file');
      if (usage.bytes + buffer.length > MAX_TOTAL_BYTES) throw new HttpError(413, 'O espaço de anexos da conta está cheio. Exclua arquivos para liberar espaço.', 'quota_exceeded');
      // O que vale é o CONTEÚDO: a extensão precisa bater com o que o arquivo realmente é.
      const ext = detectAttachment(name, buffer);
      if (!ext) throw new HttpError(415, `Arquivo não aceito. Envie ${ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(', ')} com o conteúdo correspondente.`, 'unsupported_media_type');

      const id = await repo.create(owner.id, { uploadedBy: user.id, name, ext, size: buffer.length, data: encryptBuffer(buffer, encryptionKey, owner.id) });
      return (await repo.list(owner.id)).find((f) => f.id === id);
    },

    /** Conteúdo decifrado, só para quem é da conta. Qualquer recusa (outra conta, inexistente) vira 404. */
    async download(owner, id) {
      requireKey();
      const row = await repo.get(owner.id, id);
      if (!row) throw notFound('Arquivo não encontrado.');
      try {
        return { name: row.name, ext: row.ext, data: decryptBuffer(row.data, encryptionKey, owner.id) };
      } catch {
        throw new HttpError(409, 'Não foi possível abrir este arquivo (chave de criptografia diferente da usada no envio, ou dado corrompido). Envie-o de novo.', 'file_unreadable');
      }
    },

    async remove(owner, id) {
      if (!(await repo.remove(owner.id, id))) throw notFound('Arquivo não encontrado.');
    },
  };
}
