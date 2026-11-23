import { HttpError, badRequest, notFound } from '../../lib/http-error.js';
import { sniffCreativeType } from '../creatives/creative-types.js';
import { MAX_AVATAR_UPLOAD_BYTES } from './avatar-processor.js';

const ACCEPTED = { 'image/jpeg': 'jpg', 'image/png': 'png' }; // o navegador converte qualquer outro formato antes de enviar
const TOO_LARGE = () => new HttpError(413, 'A foto é grande demais. Use uma imagem de até 1 MB (o editor já reduz sozinho).', 'file_too_large');

/**
 * Perfil da PESSOA logada (não do espaço de trabalho): nome e foto. `user` é sempre quem fez a requisição, inclusive colaborador.
 * Quem pode VER a foto de quem: a própria pessoa, o dono do espaço e os colegas de equipe (e o admin, na supervisão).
 */
export function createProfileService({ avatars, users, storage, processor }) {
  return {
    avatarsAvailable: () => processor.available,

    async updateName(user, name) {
      await users.updateName(user.id, name);
      return name;
    },

    /**
     * Recebe a foto, confirma pelo CONTEÚDO que é JPG/PNG, recodifica no servidor (256x256, sem metadados) e guarda.
     * O Content-Type informado é só uma dica; o que vale são os bytes.
     */
    async setAvatar(user, { stream, contentType, contentLength }) {
      const declared = ACCEPTED[contentType];
      if (!declared) throw new HttpError(415, 'Formato não suportado. Envie uma foto JPG ou PNG.', 'unsupported_media_type');
      if (!processor.available) throw new HttpError(503, 'O processamento de fotos não está disponível neste servidor.', 'avatar_unavailable');
      if (contentLength !== null && contentLength > MAX_AVATAR_UPLOAD_BYTES) throw TOO_LARGE();

      const tempFile = storage.tempPath();
      try {
        let received;
        try {
          received = await storage.receive(stream, tempFile, { maxBytes: MAX_AVATAR_UPLOAD_BYTES });
        } catch (err) {
          if (err instanceof HttpError) throw TOO_LARGE();
          throw err;
        }
        if (received.size === 0) throw badRequest('O arquivo está vazio.', 'empty_file');
        const actual = sniffCreativeType(received.head);
        if (!actual || actual.kind !== 'image' || actual.ext !== declared) {
          throw new HttpError(415, 'O conteúdo do arquivo não é uma foto JPG ou PNG válida.', 'content_mismatch');
        }
        const data = await processor.process(tempFile, actual.ext);
        return { avatarVersion: Date.parse(await avatars.save(user.id, data)) };
      } finally {
        await storage.removeTemp(tempFile).catch(() => {});
      }
    },

    async removeAvatar(user) {
      await avatars.remove(user.id);
    },

    /** Foto de `targetId` para quem está logado; qualquer recusa vira 404 (não revela que a pessoa existe). */
    async viewAvatar({ viewer, workspaceOwnerId, isSupervisor }, targetId) {
      const allowed = viewer.id === targetId || isSupervisor || (await avatars.sharesWorkspace(workspaceOwnerId, targetId));
      const avatar = allowed ? await avatars.get(targetId) : null;
      if (!avatar) throw notFound('Foto não encontrada.');
      return avatar;
    },
  };
}
