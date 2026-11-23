import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../../lib/http-error.js';
import { runFfmpeg } from '../creatives/creative-cleaner.js';

/**
 * Foto de perfil: o arquivo enviado NUNCA é guardado como veio. O servidor o decodifica e gera um JPEG novo, quadrado
 * (recorte central), de AVATAR_SIZE x AVATAR_SIZE, sem nenhum metadado. Isso elimina EXIF/GPS, conteúdo escondido no arquivo
 * (polyglots) e qualquer surpresa de formato: o que é guardado e servido é sempre um JPEG gerado aqui.
 *
 * SEGURANÇA: mesmo cuidado do limpador de criativos: FFmpeg chamado sem shell, formato de entrada FIXADO pelo conteúdo real
 * (nada de detecção automática), só o protocolo `file`, sem stdin, ambiente vazio, tempo máximo e tamanho máximo de saída.
 * Antes de decodificar, as DIMENSÕES são lidas do cabeçalho e imagens enormes são recusadas (uma "bomba de descompressão":
 * arquivo pequeno que vira gigabytes de pixels na memória).
 */
export const AVATAR_SIZE = 256;
export const MAX_AVATAR_UPLOAD_BYTES = 1024 * 1024; // o navegador envia ~50 KB (já recortado); 1 MB dá folga a outros clientes
export const MAX_AVATAR_OUTPUT_BYTES = 200 * 1024; // igual ao CHECK da tabela
export const MAX_SOURCE_PIXELS_SIDE = 4096; // maior lado aceito do arquivo enviado
const HEADER_SCAN_BYTES = 1024 * 1024; // onde procurar o tamanho de um JPEG (EXIF grande pode empurrá-lo para longe do início)

const invalid = (message) => new HttpError(422, message, 'invalid_image');

/**
 * Largura e altura lidas do CABEÇALHO (sem decodificar): PNG (bloco IHDR) e JPEG (primeiro marcador SOFn).
 * Devolve null se não achar ou se o arquivo estiver truncado.
 */
export function readImageSize(buffer) {
  if (buffer.length >= 24 && buffer.toString('latin1', 1, 4) === 'PNG' && buffer.toString('latin1', 12, 16) === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return null;
      let marker = buffer[offset + 1];
      while (marker === 0xff && offset + 2 < buffer.length) { // bytes de preenchimento
        offset += 1;
        marker = buffer[offset + 1];
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { // marcadores sem tamanho
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        if (offset + 9 > buffer.length) return null;
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {string|null} options.ffmpegPath  binário do FFmpeg (null = indisponível)
 * @param {string} options.tmpDir           pasta privada para os arquivos temporários
 * @param {number} [options.timeoutMs]
 * @param {number} [options.concurrency]    conversões simultâneas
 */
export function createAvatarProcessor({ ffmpegPath, tmpDir, timeoutMs = 30_000, concurrency = 2 }) {
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((resolve) => {
    if (active < concurrency) {
      active += 1;
      resolve();
    } else {
      waiting.push(resolve);
    }
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    available: Boolean(ffmpegPath),

    /**
     * @param {string} inputPath arquivo enviado (já recebido em disco, com o tipo confirmado pelo conteúdo)
     * @param {'jpg'|'png'} ext   formato real do arquivo (detectado pelos bytes)
     * @returns {Promise<Buffer>} JPEG novo
     */
    async process(inputPath, ext) {
      if (!ffmpegPath) throw new HttpError(503, 'O processamento de fotos não está disponível neste servidor.', 'avatar_unavailable');
      const handle = await fsp.open(inputPath, 'r');
      let head;
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEADER_SCAN_BYTES), 0, HEADER_SCAN_BYTES, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      const size = readImageSize(head);
      if (!size || !size.width || !size.height) throw invalid('Não consegui ler esta imagem. Use um arquivo JPG ou PNG válido.');
      if (size.width > MAX_SOURCE_PIXELS_SIDE || size.height > MAX_SOURCE_PIXELS_SIDE) throw invalid(`A imagem é grande demais (máximo de ${MAX_SOURCE_PIXELS_SIDE} pixels de lado).`);

      const outputPath = path.join(tmpDir, `avatar-${randomBytes(12).toString('hex')}.jpg`);
      const args = [
        '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-protocol_whitelist', 'file',
        '-f', 'image2', '-c:v', ext === 'png' ? 'png' : 'mjpeg', '-i', inputPath,
        '-map_metadata', '-1', '-frames:v', '1',
        // recorte central quadrado e redução; "format" garante JPEG comum (yuvj420p) mesmo com PNG transparente/16 bits
        '-vf', `scale=${AVATAR_SIZE}:${AVATAR_SIZE}:force_original_aspect_ratio=increase,crop=${AVATAR_SIZE}:${AVATAR_SIZE},format=yuvj420p`,
        '-c:v', 'mjpeg', '-q:v', '4', '-fflags', '+bitexact', '-flags:v', '+bitexact',
        '-fs', String(MAX_AVATAR_OUTPUT_BYTES + 1), '-f', 'image2', '-update', '1', outputPath,
      ];
      await acquire();
      try {
        await runFfmpeg(ffmpegPath, args, { timeoutMs });
        const data = await fsp.readFile(outputPath);
        if (data.length === 0 || data.length > MAX_AVATAR_OUTPUT_BYTES) throw new Error('saída inválida');
        return data;
      } catch {
        throw invalid('Não foi possível processar esta imagem. O arquivo parece corrompido; tente outro.');
      } finally {
        release();
        await fsp.rm(outputPath, { force: true });
      }
    },
  };
}
