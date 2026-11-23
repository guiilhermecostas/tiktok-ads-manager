import fs from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { runFfmpeg } from '../src/modules/creatives/creative-cleaner.js';

export const KLING_TEST_KEY = 'api-key-kling-TESTKEYtestkeyTESTKEY-0123456789_abc';
export const klingTestConfig = (extra = {}) => ({
  apiKey: KLING_TEST_KEY,
  enabled: true,
  baseUrl: 'https://api-singapore.klingai.com',
  model: 'kling-3.0',
  downloadHosts: ['klingai.com'],
  dailyLimit: 20,
  globalDailyLimit: 100,
  concurrency: 3,
  ...extra,
});

/** Vídeo MP4 pequeno de verdade (FFmpeg): `kind` 'hook' = 720×1280, 3 s, sem áudio (como a Kling devolve). */
export async function makeSampleVideo(file, { width = 720, height = 1280, seconds = 3, audio = false, rotate = false } = {}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:d=${seconds}:r=30`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), ...(rotate ? ['-metadata:s:v:0', 'rotate=90'] : []), '-f', 'mp4', file);
  await runFfmpeg(ffmpegPath, args, { timeoutMs: 60_000 });
  return fs.readFileSync(file);
}

/**
 * Simula a Kling (formato da documentação oficial: /text-to-video/{modelo}, GET /tasks?task_ids=…, envelope { code, message, data })
 * e o CDN que serve o vídeo pronto. Tudo sem rede.
 */
export function createFakeKling({ videoBytes }) {
  const state = {
    calls: [], // { method, path, headers, body }
    tasks: new Map(), // id -> { status, polls, prompt }
    nextId: 1000,
    pollsToSucceed: 1, // quantas consultas até a tarefa terminar
    createError: null, // { http, code } -> próximas criações respondem esse erro (until: n criações)
    createErrorTimes: 0,
    failTasks: new Set(), // IDs de tarefa que terminam com status "failed"
    failAllTasks: false, // true: toda tarefa nova termina com status "failed"
    taskQueryError: null, // { http, code } nas consultas
    resultUrl: (id) => `https://cdn.klingai.com/hooks/${id}.mp4`,
    downloads: [], // URLs baixadas
    downloadBytes: null, // sobrescreve o conteúdo do vídeo (ex.: lixo)
    downloadStatus: 200,
    omitVideo: false, // tarefa "succeeded" sem outputs
    videoBytes,
  };
  const envelope = (data, code = 0, message = 'SUCCEED', http = 200) => new Response(JSON.stringify({ code, message, request_id: 'req-x', ...(data === undefined ? {} : { data }) }), { status: http, headers: { 'content-type': 'application/json' } });

  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const isCdn = u.hostname === 'cdn.klingai.com' || (u.hostname.endsWith('.klingai.com') && !u.hostname.startsWith('api-'));
    if (isCdn) {
      state.downloads.push(String(url));
      if (state.downloadStatus !== 200) return new Response('x', { status: state.downloadStatus });
      const bytes = state.downloadBytes ?? state.videoBytes;
      return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
    }
    if (u.hostname !== 'api-singapore.klingai.com') {
      state.downloads.push(String(url)); // qualquer outro destino: o teste confere que NUNCA é chamado
      return new Response(state.videoBytes, { status: 200 });
    }
    const headers = init.headers ?? {};
    state.calls.push({ method, path: u.pathname + u.search, headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (headers.Authorization !== `Bearer ${KLING_TEST_KEY}`) return envelope(undefined, 1002, 'Authorization is invalid', 401);

    if (method === 'POST' && u.pathname === '/text-to-video/kling-3.0') {
      if (state.createError && state.createErrorTimes > 0) {
        state.createErrorTimes -= 1;
        const e = state.createError;
        if (state.createErrorTimes === 0) state.createError = null;
        return envelope(undefined, e.code, e.message ?? 'error', e.http);
      }
      const body = JSON.parse(init.body);
      const s = body.settings ?? {};
      if (typeof body.prompt !== 'string' || !body.prompt || !Number.isInteger(s.duration) || s.duration < 3 || s.duration > 15) return envelope(undefined, 1201, 'invalid parameter', 400);
      const id = `task_${++state.nextId}`;
      state.tasks.set(id, { status: 'submitted', polls: 0, prompt: body.prompt });
      return envelope({ id, status: 'submitted', create_time: Date.now(), update_time: Date.now(), external_id: body.options?.external_task_id ?? '' });
    }
    if (method === 'GET' && u.pathname === '/tasks') {
      if (state.taskQueryError) return envelope(undefined, state.taskQueryError.code, 'error', state.taskQueryError.http);
      const ids = (u.searchParams.get('task_ids') ?? '').split(',').filter(Boolean);
      return envelope(ids.filter((id) => state.tasks.has(id)).map((id) => {
        const task = state.tasks.get(id);
        task.polls += 1;
        if (state.failTasks.has(id) || state.failAllTasks) task.status = 'failed';
        else task.status = task.polls >= state.pollsToSucceed ? 'succeeded' : 'processing';
        return {
          id, status: task.status, message: task.status === 'failed' ? 'generation failed' : '', create_time: 1, update_time: 2, external_id: '',
          outputs: task.status === 'succeeded' && !state.omitVideo ? [{ type: 'video', id: 'v1', url: state.resultUrl(id), watermark_url: '', duration: '3' }] : [],
        };
      }));
    }
    return envelope(undefined, 1203, 'resource does not exist', 404);
  };

  return { state, fetchFn, postCalls: () => state.calls.filter((c) => c.method === 'POST') };
}
