import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../../lib/http-error.js';
import { SNIFF_BYTES } from './creative-types.js';

/**
 * Armazenamento local dos arquivos da biblioteca.
 *  - Nome no disco é SEMPRE aleatório (`<userId>/<32 hex>.<ext>`): nada que o usuário envia vira caminho.
 *  - Pastas 0700 e arquivos 0600 (somente o usuário do servidor).
 *  - Gravação em arquivo temporário e `rename` ao final (nunca há arquivo parcial visível).
 * A interface (tempPath/receive/commit/pathFor/remove) é a que outro provedor (ex.: S3/Supabase Storage) implementaria.
 */
const KEY_RE = /^\d{1,10}\/[a-f0-9]{32}\.(jpg|png|mp4|mov)$/;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

export function createLocalCreativeStorage({ dir }) {
  const base = path.resolve(dir);
  const tmpDir = path.join(base, '.tmp');

  /** Resolve a chave para um caminho absoluto, recusando qualquer coisa fora do formato esperado. */
  function pathFor(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('Chave de armazenamento inválida.');
    const absolute = path.join(base, key);
    if (!absolute.startsWith(base + path.sep)) throw new Error('Caminho fora da pasta de criativos.');
    return absolute;
  }

  return {
    base,

    /** Cria as pastas e apaga temporários abandonados (ex.: queda do servidor no meio de um envio). */
    async init() {
      await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(base, 0o700);
      await fsp.chmod(tmpDir, 0o700);
      for (const name of await fsp.readdir(tmpDir)) {
        const file = path.join(tmpDir, name);
        const stat = await fsp.stat(file).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > TEMP_MAX_AGE_MS) await fsp.rm(file, { force: true });
      }
    },

    tempPath: () => path.join(tmpDir, `${randomBytes(16).toString('hex')}.part`),

    /**
     * Grava o fluxo no arquivo temporário calculando tamanho, SHA-256 e MD5 (o TikTok pede o MD5 como assinatura)
     * e guardando os primeiros bytes para identificar o tipo. Interrompe ao passar de `maxBytes`.
     */
    async receive(stream, tempFile, { maxBytes }) {
      await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const sha256 = createHash('sha256');
      const md5 = createHash('md5');
      let size = 0;
      let head = Buffer.alloc(0);
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) return callback(new HttpError(413, 'Arquivo maior que o limite permitido.', 'file_too_large'));
          if (head.length < SNIFF_BYTES) head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
          sha256.update(chunk);
          md5.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(stream, meter, fs.createWriteStream(tempFile, { flags: 'wx', mode: 0o600 }));
      return { size, head, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
    },

    /** Move o temporário para o destino final e devolve a chave. */
    async commit(tempFile, userId, ext) {
      const key = `${Number(userId)}/${randomBytes(16).toString('hex')}.${ext}`;
      const destination = pathFor(key);
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fsp.rename(tempFile, destination);
      await fsp.chmod(destination, 0o600);
      return key;
    },

    pathFor,

    async remove(key) {
      await fsp.rm(pathFor(key), { force: true });
    },
    async removeTemp(tempFile) {
      await fsp.rm(tempFile, { force: true });
    },
  };
}
