import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

/**
 * Mídia REAL (gerada pelo próprio FFmpeg) e medições de pixel para os testes da limpeza de criativos.
 * Fundo de cor lisa: depois da recodificação o que NÃO foi alterado de propósito continua igual, então qualquer
 * diferença medida fora dos cantos seria um defeito.
 */
export { ffmpegPath };
export const WIDTH = 320;
export const HEIGHT = 240;
export const FPS = 25;

export const tempDir = (prefix = 'media-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const md5Of = (file) => createHash('md5').update(fs.readFileSync(file)).digest('hex');

const run = (args) => execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });

/** Vídeo de cor lisa com título/comentário nos metadados (e áudio, se pedido). */
export function makeVideo(dir, { name = 'video.mp4', seconds = 2, audio = true, container = 'mp4', color = '0x336699' } = {}) {
  const file = path.join(dir, name);
  const inputs = ['-f', 'lavfi', '-i', `color=c=${color}:s=${WIDTH}x${HEIGHT}:d=${seconds}:r=${FPS}`];
  if (audio) inputs.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  run([...inputs, '-metadata', 'title=SEGREDO', '-metadata', 'comment=privado', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), '-f', container, file]);
  return file;
}

/** Insere, logo depois do início do JPEG, um bloco XMP e um comentário com texto secreto (como uma câmera/editor faria). */
function addJpegMetadata(file) {
  const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>SEGREDO</dc:creator></x:xmpmeta>', 'latin1'));
  const comment = segment(0xfe, Buffer.from('SEGREDO camera privada', 'latin1'));
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([original.subarray(0, 2), xmp, comment, original.subarray(2)]));
}

/** Imagem de cor lisa; o JPEG recebe metadados reais (XMP e comentário) e o PNG, um comentário. */
export function makeImage(dir, { name = 'imagem.png', color = '0x336699', width = 200, height = 120 } = {}) {
  const file = path.join(dir, name);
  const isPng = name.endsWith('.png');
  run(['-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=1`, '-frames:v', '1', ...(isPng ? ['-metadata', 'comment=SEGREDO'] : ['-q:v', '2']), file]);
  if (!isPng) addJpegMetadata(file);
  return file;
}

/** Texto informativo do FFmpeg sobre o arquivo (streams, duração, metadados). */
export function probe(file) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return result.stderr;
}

/** Um quadro em bruto (cinza para vídeo; RGB para imagem). */
export function rawFrame(file, { index = 0, pixelFormat = 'gray', width = WIDTH, height = HEIGHT } = {}) {
  const buffer = execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-'], { maxBuffer: 50 * 1024 * 1024 });
  const channels = pixelFormat === 'rgb24' ? 3 : 1;
  if (buffer.length !== width * height * channels) throw new Error(`quadro ${index} com tamanho inesperado (${buffer.length})`);
  return { buffer, channels, width, height };
}

/** Lado do canto usado pela limpeza (6% do menor lado, no mínimo 3 px; comparação exata, como no filtro: x < lado). */
export const cornerSide = (width, height) => Math.max(3, Math.min(width, height) * 0.06);

/**
 * Compara dois quadros: diferença média e % de pixels alterados DENTRO dos cantos; fora deles, a diferença média/máxima e a
 * máxima na região LONGE dos cantos (`farMax`).
 */
export function compareFrames(a, b) {
  const { width, height, channels } = a;
  const side = cornerSide(width, height);
  const stats = { cornerSum: 0, cornerCount: 0, cornerChanged: 0, restSum: 0, restCount: 0, restMax: 0, cornerMax: 0, farMax: 0 };
  // "Longe dos cantos": a mais de 32 px (2 blocos da compressão) de qualquer canto; ali NADA pode mudar.
  const margin = side + 32;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inCorner = (x < side || x >= width - side) && (y < side || y >= height - side);
      for (let c = 0; c < channels; c += 1) {
        const i = (y * width + x) * channels + c;
        const d = Math.abs(a.buffer[i] - b.buffer[i]);
        if (inCorner) {
          stats.cornerSum += d;
          stats.cornerCount += 1;
          if (d > 0) stats.cornerChanged += 1;
          stats.cornerMax = Math.max(stats.cornerMax, d);
        } else {
          if (!((x < margin || x >= width - margin) && (y < margin || y >= height - margin))) stats.farMax = Math.max(stats.farMax, d);
          stats.restSum += d;
          stats.restCount += 1;
          stats.restMax = Math.max(stats.restMax, d);
        }
      }
    }
  }
  return {
    cornerMean: stats.cornerSum / stats.cornerCount,
    cornerChangedShare: stats.cornerChanged / stats.cornerCount,
    cornerMax: stats.cornerMax,
    restMean: stats.restSum / stats.restCount,
    restMax: stats.restMax,
    farMax: stats.farMax,
  };
}
