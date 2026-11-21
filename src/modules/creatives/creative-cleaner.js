import { createHash, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HttpError } from '../../lib/http-error.js';

/**
 * Limpeza ("blindagem") do criativo antes de cada publicação em cada conta de anúncio.
 *
 * Gera um arquivo NOVO e único a partir do original (o original nunca é alterado):
 *  - descarta metadados (contêiner, EXIF/ICC, capítulos, faixas extras, informações do codificador) e, portanto, o hash;
 *  - reconstrói a mídia por completo: vídeo decodificado quadro a quadro e recodificado (H.264/AAC); imagem recodificada;
 *  - nos PRIMEIROS e nos ÚLTIMOS 0,1 s do vídeo, altera os pixels dos 4 cantos com cores muito próximas das originais
 *    (variação de 3 a 7 níveis em 255, quase imperceptível). Na imagem, os mesmos cantos.
 * O sorteio é novo a cada execução: duas versões do mesmo criativo nunca saem iguais.
 *
 * SEGURANÇA: o arquivo de entrada é de um usuário e o FFmpeg lê formatos complexos. Por isso o processo é chamado SEM shell
 * (argumentos em lista), com o formato de entrada FIXADO (sem detecção automática), só o protocolo `file` (nada de rede,
 * playlists ou `concat` apontando para outros arquivos), sem stdin, ambiente vazio, tempo máximo, tamanho máximo de
 * saída e no máximo N processos ao mesmo tempo (a CPU do servidor é compartilhada).
 */

/** Janela alterada no início e no fim do vídeo, em segundos. */
export const CLEAN_WINDOW_SECONDS = 0.1;

const LUMA = { min: 3, spread: 5 }; // variação de 3 a 7 níveis
const CHROMA = { min: 2, spread: 3 }; // variação de 2 a 4 níveis (cor)
const CORNER_FRACTION = 0.06; // lado de cada canto = 6% do menor lado (mínimo de 3 px na grade de cada plano)
const STDERR_LIMIT = 64 * 1024;
const MOV_DEMUXERS = 'mov,mp4,m4a,3gp,3g2,mj2';

/** Cantos de uma imagem/plano: 1 dentro de um dos 4 cantos, 0 fora (usa as dimensões W,H do plano atual no `geq`). */
const CORNER = `(lt(X,max(3,min(W,H)*${CORNER_FRACTION}))+gte(X,W-max(3,min(W,H)*${CORNER_FRACTION})))*(lt(Y,max(3,min(W,H)*${CORNER_FRACTION}))+gte(Y,H-max(3,min(W,H)*${CORNER_FRACTION})))`;

/** Número pseudoaleatório de 0 a 1 por pixel/quadro; o `salt` (novo a cada execução) muda o padrão inteiro. */
const hash01 = (a, b, salt) => `mod(abs(sin(X*${a}+Y*${b}+N*7.13+${salt})*43758.5453),1)`;

/**
 * Expressão do `geq` para um canal: soma, nos cantos, uma variação de `min` a `min+spread-1` níveis (de 0 a 255; sinal sorteado;
 * vira para o lado oposto quando passaria do limite, assim o pixel SEMPRE muda). A variação mínima é grande o bastante para
 * sobreviver à compressão com perdas, e pequena o bastante (cerca de 1% a 3% da escala) para ser praticamente invisível.
 */
function channelExpression(read, salt, { min, spread }) {
  const sign = `if(lt(${hash01('12.9898', '78.233', salt)},0.5),-1,1)`;
  const magnitude = `(${min}+floor(${hash01('39.346', '11.135', salt + 17.7)}*${spread}))`;
  return `st(1,${sign}*${magnitude});${read}+${CORNER}*if(gt(abs(${read}+ld(1)-127.5),127.5),-ld(1),ld(1))`;
}

/** Filtro de vídeo: só atua quando `enable` for verdadeiro (início e fim). */
function videoFilter({ durationSeconds, salt }) {
  const endStart = Math.max(0, durationSeconds - CLEAN_WINDOW_SECONDS).toFixed(3);
  const enable = `lt(t,${CLEAN_WINDOW_SECONDS})+gte(t,${endStart})`;
  const geq = `geq=lum='${channelExpression('lum(X,Y)', salt, LUMA)}':cb='${channelExpression('cb(X,Y)', salt + 101.3, CHROMA)}':cr='${channelExpression('cr(X,Y)', salt + 202.9, CHROMA)}':enable='${enable}'`;
  return `setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p,${geq}`;
}

/** Filtro de imagem: sempre atua (é um único quadro). */
function imageFilter({ salt }) {
  const channel = (name, offset) => `${name}='${channelExpression(`${name}(X,Y)`, salt + offset, LUMA)}'`;
  return `format=rgb24,geq=${channel('r', 0)}:${channel('g', 59.1)}:${channel('b', 118.7)}`;
}

/** Roda o FFmpeg e devolve o texto de erro/informação (limitado). Rejeita em falha, tempo esgotado ou binário ausente. */
function runFfmpeg(ffmpegPath, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: {}, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      if (stdout.length < STDERR_LIMIT) stdout += chunk.toString('utf8'); // só `-version` escreve aqui
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`ffmpeg: ${err.code ?? err.message}`), { code: err.code === 'ENOENT' ? 'ffmpeg_missing' : 'ffmpeg_failed' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error('ffmpeg: tempo esgotado'), { code: 'ffmpeg_timeout' }));
      if (code !== 0) return reject(Object.assign(new Error(`ffmpeg: saída ${code}: ${stderr.slice(-400)}`), { code: 'ffmpeg_failed' }));
      return resolve(`${stderr}\n${stdout}`);
    });
  });
}

/** "Duration: 00:00:12.40" -> segundos (ou null). */
function parseDuration(info) {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(info);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function digest(filePath) {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    sha256.update(chunk);
    md5.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}

const unprocessable = (name) => new HttpError(422, `Não foi possível preparar o criativo${name ? ` "${name}"` : ''}: o arquivo parece corrompido ou em um formato que não consegui processar. Envie outro arquivo.`, 'creative_clean_failed');

/**
 * @param {object} options
 * @param {string|null} options.ffmpegPath  caminho do binário (null = indisponível)
 * @param {string} options.tmpDir           pasta (privada) para os arquivos gerados
 * @param {number} [options.concurrency=1]  processos simultâneos
 * @param {number} [options.timeoutMs]      tempo máximo por arquivo
 * @param {number} [options.threads=2]      threads do codificador (limita CPU e memória)
 * @param {object} [options.log]
 */
export function createCreativeCleaner({ ffmpegPath, tmpDir, concurrency = 1, timeoutMs = 20 * 60 * 1000, threads = 2, log = console }) {
  let active = 0;
  const waiting = [];

  /** Fila simples: no máximo `concurrency` limpezas ao mesmo tempo. */
  const acquire = () =>
    new Promise((resolve) => {
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

  async function produce({ inputPath, kind, ext, maxOutputBytes }) {
    const outputExt = kind === 'video' ? 'mp4' : ext;
    const id = randomBytes(12).toString('hex');
    const outputPath = path.join(tmpDir, `clean-${id}.${outputExt}`);
    const stagePath = path.join(tmpDir, `stage-${id}.mp4`); // só vídeo: saída da recodificação, antes da cópia final
    const salt = randomInt(1, 1_000_000) / 7; // novo a cada execução
    const base = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error', '-protocol_whitelist', 'file'];
    const bitexact = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'];
    const limit = ['-fs', String(maxOutputBytes + 1)];

    try {
      let args;
      if (kind === 'video') {
        // 1) Lê a duração (e confirma que o arquivo é decodificável) decodificando o primeiro quadro.
        const info = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-nostats', '-protocol_whitelist', 'file', '-f', MOV_DEMUXERS, '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { timeoutMs });
        const durationSeconds = parseDuration(info);
        if (!durationSeconds || durationSeconds <= 0) throw Object.assign(new Error('duração desconhecida'), { code: 'ffmpeg_failed' });
        const crf = 16 + randomInt(0, 3);
        const keyint = randomInt(48, 121);
        // 2) Recodifica tudo: um vídeo e (se houver) um áudio; sem metadados, capítulos, legendas, anexos ou dados extras.
        args = [
          ...base, '-f', MOV_DEMUXERS, '-i', inputPath,
          '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
          '-vf', videoFilter({ durationSeconds, salt }),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-threads', String(threads),
          '-x264-params', `keyint=${keyint}:min-keyint=${Math.min(keyint, 24)}:rc-lookahead=10`,
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', ...bitexact, ...limit, '-f', 'mp4', stagePath,
        ];
      } else {
        args = [
          ...base, '-f', 'image2', '-c:v', ext === 'png' ? 'png' : 'mjpeg', '-i', inputPath,
          '-map_metadata', '-1', '-frames:v', '1', '-vf', imageFilter({ salt }),
          ...(ext === 'png' ? ['-c:v', 'png', '-compression_level', '9'] : ['-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-q:v', '2']),
          ...bitexact, ...limit, '-f', 'image2', '-update', '1', outputPath,
        ];
      }
      await runFfmpeg(ffmpegPath, args, { timeoutMs });
      if (kind === 'video') {
        // 3) Cópia SEM recodificar (rápida) para o arquivo final: o codificador grava a própria marca ("Lavc libx264") nos
        //    fluxos e um bloco SEI com a versão e as opções do x264; só uma passada de cópia remove os dois (SEI = NAL tipo 6).
        await runFfmpeg(ffmpegPath, [
          ...base, '-f', 'mp4', '-i', stagePath, '-map', '0', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1',
          '-bsf:v', 'filter_units=remove_types=6', '-metadata:s:v:0', 'encoder=', '-metadata:s:a:0', 'encoder=', '-movflags', '+faststart', ...bitexact, ...limit, '-f', 'mp4', outputPath,
        ], { timeoutMs });
      }
      const result = await digest(outputPath);
      if (result.size === 0 || result.size > maxOutputBytes) throw Object.assign(new Error('saída inválida'), { code: 'ffmpeg_failed' });
      return { filePath: outputPath, ext: outputExt, ...result };
    } catch (err) {
      await fsp.rm(outputPath, { force: true });
      throw err;
    } finally {
      await fsp.rm(stagePath, { force: true });
    }
  }

  return {
    available: Boolean(ffmpegPath),

    /**
     * Gera a versão limpa e única. Retorna { filePath, ext, size, md5, sha256, discard() }: quem chama envia o arquivo e
     * DEVE chamar `discard()` (apaga o arquivo gerado).
     * `originalSha256` é conferido: a saída nunca pode ter o mesmo hash do original.
     */
    async clean({ inputPath, kind, ext, originalSha256 = null, maxOutputBytes, name = '' }) {
      if (!ffmpegPath) throw new HttpError(503, 'A limpeza de criativos não está disponível neste servidor (FFmpeg ausente).', 'creative_cleaner_unavailable');
      await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
      await acquire();
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const output = await produce({ inputPath, kind, ext, maxOutputBytes }).catch((err) => {
            log.error('[criativos] falha na limpeza:', err.code ?? 'erro', String(err.message).slice(0, 300));
            throw err.code === 'ffmpeg_missing' ? new HttpError(503, 'A limpeza de criativos não está disponível neste servidor (FFmpeg ausente).', 'creative_cleaner_unavailable') : unprocessable(name);
          });
          if (output.sha256 !== originalSha256) {
            return { ...output, discard: () => fsp.rm(output.filePath, { force: true }) };
          }
          await fsp.rm(output.filePath, { force: true }); // idêntico ao original (praticamente impossível): sorteia de novo
        }
        throw unprocessable(name);
      } finally {
        release();
      }
    },

    /**
     * Autoverificação (na subida do servidor): confere se o FFmpeg executa E se consegue fazer a limpeza completa, rodando o
     * mesmo processo em um vídeo (com áudio) e uma imagem minúsculos gerados na hora. Cobre diferenças entre binários/plataformas
     * (codificador, filtros e filtro de bitstream). Retorna { ok, version } ou { ok: false, error }. Nunca lança.
     */
    async selfCheck() {
      if (!ffmpegPath) return { ok: false, error: 'FFmpeg não encontrado (instale as dependências ou defina FFMPEG_PATH).' };
      const files = [];
      const results = [];
      try {
        const info = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-version'], { timeoutMs: 15_000 });
        const version = /ffmpeg version (\S+)/.exec(info)?.[1] ?? 'desconhecida';
        await fsp.mkdir(tmpDir, { recursive: true, mode: 0o700 });
        const id = randomBytes(6).toString('hex');
        const sample = async (name, kind, ext, source) => {
          const file = path.join(tmpDir, `selfcheck-${id}-${name}`);
          files.push(file);
          await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...source, file], { timeoutMs: 30_000 });
          const result = await this.clean({ inputPath: file, kind, ext, maxOutputBytes: 5 * 1024 * 1024, name: 'autoverificação' });
          results.push(result);
        };
        await sample('v.mp4', 'video', 'mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=0.5:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mp4']);
        await sample('i.png', 'image', 'png', ['-f', 'lavfi', '-i', 'color=c=gray:s=64x64:d=1', '-frames:v', '1', '-f', 'image2']);
        return { ok: true, version };
      } catch (err) {
        return { ok: false, error: `FFmpeg não conseguiu fazer a limpeza de teste (${err.code ?? err.status ?? 'erro'}: ${String(err.message).slice(0, 160)}).` };
      } finally {
        await Promise.all([...results.map((r) => r.discard()), ...files.map((f) => fsp.rm(f, { force: true }))]).catch(() => {});
      }
    },

    /** Para os testes: quantas limpezas estão rodando/esperando. */
    stats: () => ({ active, waiting: waiting.length }),
  };
}
