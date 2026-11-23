import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../../lib/http-error.js';
import { runFfmpeg } from '../creatives/creative-cleaner.js';

/**
 * Processamento do hook com FFmpeg (mesmas regras de segurança da limpeza de criativos: sem shell, formato de entrada fixado,
 * só o protocolo `file`, sem stdin, ambiente vazio, tempo e tamanho máximos, poucos processos ao mesmo tempo).
 *  - prepareHook: corta o vídeo da IA na duração escolhida (2 a 3 s), padroniza (720×1280, 30 fps) e acrescenta áudio mudo.
 *  - combine: coloca o hook NO INÍCIO de um vídeo da biblioteca, no tamanho dele, e junta tudo em um MP4 novo (H.264 + AAC).
 */
const MOV_DEMUXERS = 'mov,mp4,m4a,3gp,3g2,mj2';
const HOOK_W = 720;
const HOOK_H = 1280;
const FPS = 30;
const MAX_LONG_SIDE = 1920;
const MAX_SHORT_SIDE = 1080;
const BASE = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-protocol_whitelist', 'file'];
const BITEXACT = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'];

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/** Lado maior até 1920 e lado menor até 1080, mantendo a proporção; sempre números pares (exigência do H.264). */
function fitSize(width, height) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, MAX_LONG_SIDE / long, MAX_SHORT_SIDE / short);
  return { width: even(width * scale), height: even(height * scale) };
}

/** Lê duração, tamanho (já considerando a rotação do celular) e se há áudio, a partir da saída informativa do FFmpeg. */
export function parseProbe(info) {
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(info);
  const size = /Video:[^\n]*?[ ,](\d{2,5})x(\d{2,5})[ ,[]/.exec(info);
  if (!duration || !size) return null;
  const rotation = Math.abs(Number(/rotation of (-?\d+(?:\.\d+)?) degrees/.exec(info)?.[1] ?? 0)) % 180;
  const [w, h] = [Number(size[1]), Number(size[2])];
  return {
    durationSeconds: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: rotation === 90 ? h : w,
    height: rotation === 90 ? w : h,
    hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(info),
  };
}

export function createHookVideo({ ffmpegPath, tmpDir, timeoutMs = 10 * 60 * 1000, threads = 2, concurrency = 1 }) {
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((resolve) => {
    if (active < concurrency) {
      active += 1;
      resolve();
    } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  const guarded = async (fn) => {
    if (!ffmpegPath) throw new HttpError(503, 'O processamento de vídeo não está disponível neste servidor (FFmpeg ausente).', 'ffmpeg_unavailable');
    await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const tempFile = (ext) => path.join(tmpDir, `hook-${randomBytes(12).toString('hex')}.${ext}`);
  const failed = (err) => new HttpError(err?.code === 'ffmpeg_timeout' ? 504 : 422, 'Não foi possível processar o vídeo do hook. Tente de novo ou escolha outro vídeo.', 'hook_video_failed');

  async function probe(filePath) {
    const info = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-nostats', '-protocol_whitelist', 'file', '-f', MOV_DEMUXERS, '-i', filePath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { timeoutMs });
    return parseProbe(info);
  }

  return {
    available: Boolean(ffmpegPath),
    tempFile,
    probe: (filePath) => guarded(() => probe(filePath).catch((err) => { throw failed(err); })),

    /** Corta o vídeo da IA na duração escolhida e o padroniza (com áudio mudo, para poder ser emendado a vídeos com som). */
    prepareHook: ({ inputPath, outputPath, durationMs, maxBytes }) => guarded(async () => {
      try {
        const info = await probe(inputPath);
        if (!info || info.durationSeconds < 1) throw Object.assign(new Error('vídeo da IA inválido'), { code: 'ffmpeg_failed' });
        const seconds = Math.min(durationMs / 1000, info.durationSeconds);
        await runFfmpeg(ffmpegPath, [
          ...BASE, '-f', MOV_DEMUXERS, '-i', inputPath, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
          '-t', seconds.toFixed(3), '-map', '0:v:0', '-map', '1:a:0', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
          '-vf', `scale=${HOOK_W}:${HOOK_H}:force_original_aspect_ratio=increase,crop=${HOOK_W}:${HOOK_H},setsar=1,fps=${FPS},format=yuv420p`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', String(threads),
          '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', ...BITEXACT, '-fs', String(maxBytes + 1), '-f', 'mp4', outputPath,
        ], { timeoutMs });
        const { size } = await fsp.stat(outputPath);
        if (size === 0 || size > maxBytes) throw Object.assign(new Error('saída inválida'), { code: 'ffmpeg_failed' });
        return { durationSeconds: seconds, size };
      } catch (err) {
        await fsp.rm(outputPath, { force: true });
        throw failed(err);
      }
    }),

    /** Hook + vídeo da biblioteca em um MP4 novo (no tamanho do vídeo da biblioteca). Devolve { size }. */
    combine: ({ hookPath, mainPath, outputPath, maxBytes }) => guarded(async () => {
      try {
        const main = await probe(mainPath);
        if (!main) throw Object.assign(new Error('vídeo ilegível'), { code: 'ffmpeg_failed' });
        const { width, height } = fitSize(main.width, main.height);
        const inputs = ['-f', MOV_DEMUXERS, '-i', hookPath, '-f', MOV_DEMUXERS, '-i', mainPath];
        let mainAudio = '[1:a]';
        if (!main.hasAudio) {
          inputs.push('-f', 'lavfi', '-t', main.durationSeconds.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
          mainAudio = '[2:a]';
        }
        const filter = [
          `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${FPS},format=yuv420p[hv]`,
          `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[mv]`,
          '[0:a]aresample=44100,aformat=channel_layouts=stereo[ha]',
          `${mainAudio}aresample=44100,aformat=channel_layouts=stereo[ma]`,
          '[hv][ha][mv][ma]concat=n=2:v=1:a=1[v][a]',
        ].join(';');
        await runFfmpeg(ffmpegPath, [
          ...BASE, ...inputs, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-map_metadata', '-1', '-map_chapters', '-1',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', String(threads),
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ...BITEXACT, '-fs', String(maxBytes + 1), '-f', 'mp4', outputPath,
        ], { timeoutMs });
        const { size } = await fsp.stat(outputPath);
        if (size === 0 || size > maxBytes) throw Object.assign(new Error('saída inválida'), { code: 'ffmpeg_failed' });
        return { size, width, height };
      } catch (err) {
        await fsp.rm(outputPath, { force: true });
        throw err instanceof HttpError ? err : failed(err);
      }
    }),
  };
}
