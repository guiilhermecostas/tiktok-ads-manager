import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../../lib/http-error.js';

const TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024; // um hook de poucos segundos tem alguns MB; acima disso algo está errado
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Códigos de erro da Kling (campo `code` da resposta) agrupados pelo que o sistema faz com eles. Nada da mensagem original é
 * mostrado ao usuário: cada grupo tem um texto próprio (a chave e detalhes internos nunca saem do servidor).
 */
const AUTH_CODES = new Set([1000, 1001, 1002, 1003, 1004, 1103]);
const CREDIT_CODES = new Set([1100, 1101, 1102]);
const POLICY_CODES = new Set([1300, 1301]);
const BUSY_CODES = new Set([1302, 1303, 5001, 5002]);

function klingError(httpStatus, code) {
  if (AUTH_CODES.has(code) || httpStatus === 401) return new HttpError(502, 'A chave da Kling foi recusada. Avise o administrador do sistema.', 'kling_auth');
  if (CREDIT_CODES.has(code)) return new HttpError(503, 'O saldo (créditos) da Kling acabou ou a conta está com restrição. Avise o administrador do sistema.', 'kling_credits');
  if (POLICY_CODES.has(code)) return new HttpError(422, 'A Kling recusou esta ideia pela política de conteúdo. Tente uma ideia diferente.', 'kling_policy');
  if (BUSY_CODES.has(code) || httpStatus === 429 || httpStatus === 503 || httpStatus === 504) return new HttpError(429, 'A Kling está ocupada agora. O sistema tenta de novo sozinho.', 'kling_busy');
  return new HttpError(502, 'A Kling não conseguiu atender o pedido agora.', 'kling_error');
}

/** Só baixamos de https, de um endereço com nome (nunca IP, localhost ou rede interna) e sem credenciais na URL. */
export function isSafeDownloadUrl(value, allowedSuffixes) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return false; // IP ou nome inválido
  if (['localhost', 'local', 'internal', 'lan'].includes(host.split('.').at(-1))) return false;
  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Cliente mínimo da API da Kling (vídeo a partir de texto). Isolado do resto do sistema: `fetchFn` por injeção (testável sem
 * rede) e a chave só viaja no cabeçalho Authorization, nunca em URL, log ou resposta ao navegador.
 */
export function createKlingClient({ config, fetchFn = fetch, log = console }) {
  const { apiKey, baseUrl, model } = config.kling;

  async function call(path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
    let response;
    try {
      response = await fetchFn(new URL(path, baseUrl), {
        method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // a API não redireciona; se redirecionar, algo está errado (e a chave não deve seguir para outro lugar)
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(502, 'Não foi possível falar com a Kling agora. O sistema tenta de novo sozinho.', 'kling_unreachable');
    }
    let json;
    try {
      json = await response.json();
    } catch {
      throw klingError(response.status, null);
    }
    const code = typeof json?.code === 'number' ? json.code : null;
    if (!response.ok || (code !== null && code !== 0)) throw klingError(response.status, code);
    return json?.data;
  }

  return {
    /**
     * Cria a tarefa de um hook (texto -> vídeo vertical, sem áudio, sem marca d'água). `seconds`: duração gerada (a Kling aceita de 3 a 15).
     * Devolve { taskId }.
     */
    async createHook({ prompt, seconds = 3, externalId }) {
      const data = await call(`/text-to-video/${model}`, {
        method: 'POST',
        body: {
          prompt,
          settings: { duration: seconds, aspect_ratio: '9:16', resolution: '720p', audio: 'off', multi_shot: false },
          options: { watermark_info: { enabled: false }, ...(externalId ? { external_task_id: String(externalId).slice(0, 64) } : {}) },
        },
      });
      const taskId = String(data?.id ?? '');
      if (!TASK_ID_RE.test(taskId)) throw new HttpError(502, 'A Kling não retornou o código da tarefa.', 'kling_bad_response');
      return { taskId };
    },

    /** Situação da tarefa: { status: 'submitted'|'processing'|'succeeded'|'failed', videoUrl, durationSeconds }. */
    async getTask(taskId) {
      if (!TASK_ID_RE.test(String(taskId))) throw new HttpError(502, 'Código de tarefa inválido.', 'kling_bad_response');
      const data = await call(`/tasks?task_ids=${encodeURIComponent(taskId)}`);
      const task = Array.isArray(data) ? data.find((t) => String(t?.id) === String(taskId)) : null;
      if (!task) return { status: 'failed', videoUrl: null, durationSeconds: null, notFound: true };
      const status = ['submitted', 'processing', 'succeeded', 'failed'].includes(task.status) ? task.status : 'processing';
      const video = Array.isArray(task.outputs) ? task.outputs.find((o) => o?.type === 'video' && typeof o.url === 'string') : null;
      return { status, videoUrl: video?.url ?? null, durationSeconds: Number(video?.duration) || null };
    },

    /**
     * Baixa o vídeo pronto (o endereço é protegido contra uso em outros sites, sem cabeçalho de autorização) para `destPath`.
     * Só https, só endereços permitidos, sem redirecionar, com tempo e tamanho máximos.
     */
    async download(url, destPath, { maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
      if (!isSafeDownloadUrl(url, config.kling.downloadHosts ?? [])) {
        let host = 'inválido';
        try {
          host = new URL(url).hostname;
        } catch { /* endereço malformado */ }
        log.error(`[hook] endereço de download recusado (domínio ${host}). Se for da Kling, acrescente-o em KLING_DOWNLOAD_HOSTS.`);
        throw new HttpError(502, 'A Kling devolveu um endereço de vídeo não permitido. Avise o administrador do sistema.', 'kling_bad_response');
      }
      let response;
      try {
        response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      } catch {
        throw new HttpError(502, 'Não foi possível baixar o vídeo gerado.', 'kling_download_failed');
      }
      if (!response.ok || !response.body) throw new HttpError(502, 'Não foi possível baixar o vídeo gerado.', 'kling_download_failed');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(502, 'O vídeo gerado é maior que o permitido.', 'kling_download_failed');
      let size = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) return callback(new HttpError(502, 'O vídeo gerado é maior que o permitido.', 'kling_download_failed'));
          return callback(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 }));
      } catch (err) {
        throw err instanceof HttpError ? err : new HttpError(502, 'Não foi possível baixar o vídeo gerado.', 'kling_download_failed');
      }
      return { size };
    },
  };
}
