import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { HOOK_STYLES, HOOK_STYLE_IDS, MAX_HOOK_IDEA_LENGTH } from '../shared/hook-styles.js';
import { loadKlingConfig } from '../src/config.js';
import { runFfmpeg } from '../src/modules/creatives/creative-cleaner.js';
import { parseProbe } from '../src/modules/hooks/hook-video.js';
import { buildHookPrompt, cleanIdea } from '../src/modules/hooks/hook-prompts.js';
import { createKlingClient, isSafeDownloadUrl } from '../src/modules/hooks/kling.client.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { KLING_TEST_KEY, createFakeKling, klingTestConfig, makeSampleVideo } from './fake-kling.js';
import { createUser, one, run, startTestServer } from './helpers.js';
import { uploadCreative } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, creativesRead: 1000, creativesWrite: 1000, hooksRead: 1000, hooksWrite: 1000, hooksCreate: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const CLEAN = { cleaning: { ffmpegPath, concurrency: 1, timeoutMs: 120_000, threads: 2 } };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
let counter = 0;
const emailOf = () => `hk${++counter}@example.com`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Duração e tamanho de um MP4 (FFmpeg). */
async function probeFile(file) {
  const info = await runFfmpeg(ffmpegPath, ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs: 60_000 });
  return parseProbe(info);
}

describe('Hook com IA: regras e textos', () => {
  it('todo estilo da tela tem texto para a IA, com as regras fixas (sem texto, marcas, pessoas reais, violência)', () => {
    assert.equal(HOOK_STYLES.length, HOOK_STYLE_IDS.length);
    for (const id of HOOK_STYLE_IDS) {
      const prompt = buildHookPrompt(id, '');
      assert.ok(prompt && prompt.length > 80 && prompt.length < 3000, id);
      assert.match(prompt, /9:16/);
      assert.match(prompt, /No text, no captions, no logos, no brand names, no real people, no celebrities, no violence, no nudity/);
    }
    assert.equal(buildHookPrompt('inexistente'), null);
    assert.equal(buildHookPrompt('__proto__'), null);
  });
  it('a ideia da pessoa é limpa (controle, espaços, tamanho) e entra antes das regras fixas', () => {
    assert.equal(cleanIdea('  uma\n\tbola\u0000  gigante  '), 'uma bola gigante');
    assert.equal(cleanIdea('x'.repeat(1000)).length, MAX_HOOK_IDEA_LENGTH);
    assert.equal(cleanIdea(null), '');
    const prompt = buildHookPrompt('color-burst', 'cores quentes');
    assert.ok(prompt.indexOf('cores quentes') < prompt.indexOf('No text'), 'as regras vêm por último');
    assert.ok(!buildHookPrompt('color-burst', '').includes('Extra creative direction'));
  });
  it('leitura do FFmpeg: duração, tamanho, áudio e rotação do celular', () => {
    const base = 'Input #0, mov,mp4\n  Duration: 00:00:12.40, start: 0.000000, bitrate: 900 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1080x1920 [SAR 1:1 DAR 9:16], 30 fps\n';
    assert.deepEqual(parseProbe(base), { durationSeconds: 12.4, width: 1080, height: 1920, hasAudio: false });
    assert.equal(parseProbe(`${base}  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo\n`).hasAudio, true);
    const rotated = parseProbe(`${base.replace('1080x1920', '1920x1080')}  Side data:\n    displaymatrix: rotation of -90.00 degrees\n`);
    assert.deepEqual([rotated.width, rotated.height], [1080, 1920], 'celular na vertical gravado como 1920×1080 + rotação');
    assert.equal(parseProbe('lixo'), null);
  });
});

describe('Hook com IA: configuração da Kling', () => {
  const withEnv = (env, fn) => {
    const old = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith('KLING_')) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return fn();
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith('KLING_')) delete process.env[k];
      Object.assign(process.env, old);
    }
  };
  it('sem chave: desligado, com padrões seguros', () => {
    const c = withEnv({}, () => loadKlingConfig());
    assert.equal(c.enabled, false);
    assert.deepEqual([c.baseUrl, c.model, c.dailyLimit, c.globalDailyLimit, c.concurrency], ['https://api-singapore.klingai.com', 'kling-3.0', 20, 100, 3]);
    assert.ok(c.downloadHosts.includes('klingai.com'));
  });
  it('com chave válida liga; valores estranhos são recusados na subida', () => {
    assert.equal(withEnv({ KLING_API_KEY: KLING_TEST_KEY }, () => loadKlingConfig()).enabled, true);
    for (const env of [
      { KLING_API_KEY: 'curta' }, { KLING_API_KEY: 'chave com espaço aaaaaaaaaaaaaaaa' },
      { KLING_BASE_URL: 'http://api-singapore.klingai.com' }, { KLING_BASE_URL: 'https://evil.example.com' }, { KLING_BASE_URL: 'https://klingai.com.evil.com' },
      { KLING_BASE_URL: 'https://user:pass@api-singapore.klingai.com' }, { KLING_BASE_URL: 'https://api-singapore.klingai.com/v1' },
      { KLING_MODEL: 'gpt-4' }, { KLING_MODEL: 'kling-3.0; rm' }, { KLING_DAILY_LIMIT: '0' }, { KLING_DAILY_LIMIT: 'abc' }, { KLING_CONCURRENCY: '99' },
      { KLING_DOWNLOAD_HOSTS: 'http://x.com' }, { KLING_DOWNLOAD_HOSTS: 'localhost' },
    ]) assert.throws(() => withEnv({ KLING_API_KEY: KLING_TEST_KEY, ...env }, () => loadKlingConfig()), /KLING_|inválid/, JSON.stringify(env));
    assert.deepEqual(withEnv({ KLING_DOWNLOAD_HOSTS: 'cdn.exemplo.com, OUTRO.com' }, () => loadKlingConfig()).downloadHosts, ['cdn.exemplo.com', 'outro.com']);
  });
});

describe('Hook com IA: cliente da Kling', () => {
  const config = { kling: klingTestConfig() };
  it('o endereço de download só pode ser https, com nome, sem credenciais, em domínio permitido', () => {
    const ok = (u) => isSafeDownloadUrl(u, ['klingai.com']);
    assert.equal(ok('https://cdn.klingai.com/a/b.mp4?x-sig=1'), true);
    assert.equal(ok('https://klingai.com/a.mp4'), true);
    for (const bad of [
      'http://cdn.klingai.com/a.mp4', 'https://evil.com/a.mp4', 'https://klingai.com.evil.com/a.mp4', 'https://notklingai.com/a.mp4',
      'https://127.0.0.1/a.mp4', 'https://10.0.0.5/a.mp4', 'https://localhost/a.mp4', 'https://[::1]/a.mp4', 'https://user:pw@cdn.klingai.com/a.mp4',
      'https://cdn.klingai.com:8443/a.mp4', 'file:///etc/passwd', 'ftp://cdn.klingai.com/a', 'não é url', '', 'https://169.254.169.254/latest/meta-data',
    ]) assert.equal(ok(bad), false, bad);
  });

  it('cria a tarefa no formato da documentação, só com a chave no cabeçalho', async () => {
    const fake = createFakeKling({ videoBytes: Buffer.from('x') });
    const client = createKlingClient({ config, fetchFn: fake.fetchFn });
    const { taskId } = await client.createHook({ prompt: 'uma cena', seconds: 3, externalId: 'hook-7' });
    assert.match(taskId, /^task_\d+$/);
    const call = fake.postCalls()[0];
    assert.equal(call.path, '/text-to-video/kling-3.0');
    assert.equal(call.headers.Authorization, `Bearer ${KLING_TEST_KEY}`);
    assert.deepEqual(call.body, {
      prompt: 'uma cena',
      settings: { duration: 3, aspect_ratio: '9:16', resolution: '720p', audio: 'off', multi_shot: false },
      options: { watermark_info: { enabled: false }, external_task_id: 'hook-7' },
    });
    assert.ok(!JSON.stringify(call.path).includes(KLING_TEST_KEY), 'a chave nunca vai na URL');
  });

  it('traduz os erros da Kling em mensagens próprias, sem vazar a chave nem o texto original', async () => {
    const cases = [
      [{ http: 429, code: 1102, message: 'Account balance not enough' }, 'kling_credits', 503],
      [{ http: 429, code: 1101, message: 'arrears' }, 'kling_credits', 503],
      [{ http: 400, code: 1301, message: 'content security' }, 'kling_policy', 422],
      [{ http: 429, code: 1303, message: 'parallel task over resource pack limit' }, 'kling_busy', 429],
      [{ http: 429, code: 1302, message: 'rate limit' }, 'kling_busy', 429],
      [{ http: 401, code: 1002, message: `Authorization is invalid ${KLING_TEST_KEY}` }, 'kling_auth', 502],
      [{ http: 500, code: 5000, message: 'internal' }, 'kling_error', 502],
    ];
    for (const [error, code, status] of cases) {
      const fake = createFakeKling({ videoBytes: Buffer.from('x') });
      fake.state.createError = error;
      fake.state.createErrorTimes = 1;
      const client = createKlingClient({ config, fetchFn: fake.fetchFn });
      await assert.rejects(client.createHook({ prompt: 'x' }), (err) => {
        assert.equal(err.code, code);
        assert.equal(err.status, status);
        assert.ok(!err.message.includes(KLING_TEST_KEY) && !err.message.includes(error.message), 'sem vazar');
        return true;
      });
    }
    const down = createKlingClient({ config, fetchFn: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(down.createHook({ prompt: 'x' }), (e) => e.code === 'kling_unreachable');
    const html = createKlingClient({ config, fetchFn: async () => new Response('<html>', { status: 502 }) });
    await assert.rejects(html.createHook({ prompt: 'x' }), (e) => e.code === 'kling_error');
  });

  it('consulta a tarefa e lê o vídeo; recusa código de tarefa estranho; nunca segue redirecionamento', async () => {
    const fake = createFakeKling({ videoBytes: Buffer.from('x') });
    const client = createKlingClient({ config, fetchFn: fake.fetchFn });
    const { taskId } = await client.createHook({ prompt: 'x' });
    assert.equal((await client.getTask(taskId)).status, 'succeeded');
    const done = await client.getTask(taskId);
    assert.deepEqual([done.videoUrl, done.durationSeconds], [`https://cdn.klingai.com/hooks/${taskId}.mp4`, 3]);
    assert.equal((await client.getTask('task_inexistente')).notFound, true);
    await assert.rejects(client.getTask('../../etc'), (e) => e.code === 'kling_bad_response');
    let seen;
    await client.createHook({ prompt: 'y' }).catch(() => {});
    const spy = createKlingClient({ config, fetchFn: async (url, init) => { seen = init; return new Response(JSON.stringify({ code: 0, data: { id: 'a1' } }), { status: 200 }); } });
    await spy.createHook({ prompt: 'x' });
    assert.equal(seen.redirect, 'error', 'a chave não pode seguir um redirecionamento');
  });

  it('o download respeita o limite de tamanho e recusa endereços fora da lista, sem chamar a rede', async () => {
    const fake = createFakeKling({ videoBytes: Buffer.alloc(5000, 1) });
    const client = createKlingClient({ config, fetchFn: fake.fetchFn });
    const dest = path.join(WORK, `dl-${counter++}.mp4`);
    assert.deepEqual(await client.download('https://cdn.klingai.com/hooks/x.mp4', dest), { size: 5000 });
    await assert.rejects(client.download('https://cdn.klingai.com/hooks/x.mp4', path.join(WORK, `dl-${counter++}.mp4`), { maxBytes: 1000 }), (e) => e.code === 'kling_download_failed');
    const beforeCount = fake.state.downloads.length;
    await assert.rejects(client.download('https://evil.example.com/x.mp4', path.join(WORK, 'nao.mp4')), (e) => e.code === 'kling_bad_response');
    await assert.rejects(client.download('http://127.0.0.1/x.mp4', path.join(WORK, 'nao2.mp4')), (e) => e.code === 'kling_bad_response');
    assert.equal(fake.state.downloads.length, beforeCount, 'nenhuma chamada saiu para endereços recusados');
    assert.ok(!fs.existsSync(path.join(WORK, 'nao.mp4')));
  });
});

describe('Hook com IA: criar, gerar, aplicar', () => {
  let ctx;
  let fake;
  let mailer;
  let nowMs;
  let hookBytes;
  before(async () => {
    hookBytes = await makeSampleVideo(path.join(WORK, 'kling-hook.mp4'), { width: 720, height: 1280, seconds: 3 });
    fake = createFakeKling({ videoBytes: hookBytes });
    mailer = createFakeMailer();
    nowMs = Date.now();
    ctx = await startTestServer({ limits: LIMITS, config: { mail: MAIL_CONFIG, kling: klingTestConfig() }, creatives: CLEAN, mailer, klingFetch: fake.fetchFn, clock: () => new Date(nowMs) });
  });
  after(async () => {
    await ctx.stop();
    fs.rmSync(WORK, { recursive: true, force: true });
  });

  const body = (extra = {}) => ({ style: 'color-burst', durationMs: 2500, ...extra });
  async function owner() {
    await run(ctx.db, 'DELETE FROM creative_hooks');
    fake.state.calls.length = 0;
    fake.state.downloads.length = 0;
    fake.state.tasks.clear();
    fake.state.failTasks.clear();
    fake.state.createError = null;
    fake.state.createErrorTimes = 0;
    fake.state.taskQueryError = null;
    fake.state.pollsToSucceed = 1;
    fake.state.downloadBytes = null;
    fake.state.downloadStatus = 200;
    fake.state.omitVideo = false;
    fake.state.resultUrl = (id) => `https://cdn.klingai.com/hooks/${id}.mp4`;
    nowMs = Date.now();
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const create = (user, extra) => user.client.post('/api/hooks', body(extra));
  const get = async (user, id) => (await user.client.get('/api/hooks')).json.hooks.find((h) => h.id === id);
  /** Roda o processador até o hook chegar a um destes estados (ou estourar o tempo). */
  async function until(user, id, states, { max = 15_000 } = {}) {
    const started = Date.now();
    for (;;) {
      await ctx.hooks.tick();
      const hook = await get(user, id);
      if (!hook || states.includes(hook.status)) return hook;
      if (Date.now() - started > max) throw new Error(`hook ${id} ficou em "${hook.status}"`);
      await sleep(40);
    }
  }
  const ready = async (user, extra) => {
    const res = await create(user, extra);
    assert.equal(res.status, 201, res.text);
    return until(user, res.json.hooks[0].id, ['ready', 'failed']);
  };
  async function uploadVideo(user, { audio = true, width = 540, height = 960, seconds = 2, name = 'Meu vídeo', rotate = false } = {}) {
    const file = path.join(WORK, `main-${++counter}.mp4`);
    const bytes = await makeSampleVideo(file, { width, height, seconds, audio, rotate });
    const res = await uploadCreative(user.client, { bytes, type: 'mp4', name, filename: 'meu-video.mp4' });
    assert.equal(res.status, 201, res.text);
    return res.json.creative;
  }
  async function download(user, urlPath) {
    const res = await fetch(ctx.baseUrl + urlPath, { headers: { cookie: user.client.cookie } });
    const file = path.join(WORK, `dl-${++counter}.mp4`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return { res, file };
  }

  it('estado do recurso: ligado, limites e opções', async () => {
    const user = await owner();
    const res = await user.client.get('/api/hooks');
    assert.equal(res.status, 200);
    assert.deepEqual({ enabled: res.json.enabled, dailyLimit: res.json.dailyLimit, used: res.json.usedLast24h, active: res.json.active, max: res.json.maxPerRequest, durations: res.json.durationsMs, hooks: res.json.hooks }, { enabled: true, dailyLimit: 20, used: 0, active: 0, max: 3, durations: [2000, 2500, 3000], hooks: [] });
    assert.ok(!res.text.includes(KLING_TEST_KEY), 'a chave nunca aparece');
  });

  it('valida o pedido antes de falar com a Kling', async () => {
    const user = await owner();
    const bad = [
      { style: 'nao-existe' }, { style: undefined }, { style: 5 }, { style: '__proto__' }, { durationMs: 1000 }, { durationMs: 4000 }, { durationMs: '2000' }, { durationMs: undefined },
      { count: 0 }, { count: 4 }, { count: 1.5 }, { count: '2' }, { idea: 5 }, { idea: 'ab' }, { idea: 'x'.repeat(301) }, { idea: { a: 1 } },
    ];
    for (const patch of bad) assert.equal((await create(user, patch)).status, 400, JSON.stringify(patch));
    assert.equal((await user.client.post('/api/hooks', [])).status, 400);
    assert.equal(fake.state.calls.length, 0, 'nada foi enviado à Kling');
    assert.equal((await ctx.client().post('/api/hooks', body())).status, 401);
  });

  it('gera um hook de ponta a ponta: fila → gerando → ajustando → pronto, cortado na duração escolhida (vertical, com áudio mudo)', async () => {
    const user = await owner();
    const res = await create(user, { idea: 'cores quentes' });
    assert.equal(res.status, 201);
    const created = res.json.hooks[0];
    assert.ok(['queued', 'generating'].includes(created.status));
    assert.deepEqual(Object.keys(created).sort(), ['applyError', 'applying', 'createdAt', 'creativeId', 'durationMs', 'errorMessage', 'hasFile', 'id', 'idea', 'readyAt', 'sizeBytes', 'status', 'style', 'submittedAt']);
    assert.ok(!res.text.includes('storage') && !res.text.includes('task_'), 'nada interno vaza');

    const hook = await until(user, created.id, ['ready', 'failed']);
    assert.equal(hook.status, 'ready', hook.errorMessage);
    assert.equal(hook.hasFile, true);

    const post = fake.postCalls()[0];
    assert.match(post.body.prompt, /colored powder/);
    assert.match(post.body.prompt, /cores quentes/);
    assert.deepEqual(post.body.settings, { duration: 3, aspect_ratio: '9:16', resolution: '720p', audio: 'off', multi_shot: false });
    assert.equal(fake.state.downloads.length, 1);

    const { res: file, file: local } = await download(user, `/api/hooks/${created.id}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('content-security-policy'), /sandbox/);
    const info = await probeFile(local);
    assert.deepEqual([info.width, info.height, info.hasAudio], [720, 1280, true]);
    assert.ok(Math.abs(info.durationSeconds - 2.5) < 0.2, `duração ${info.durationSeconds}`);
  });

  it('cada duração escolhida (2, 2,5 e 3 s) é respeitada; pedir 3 opções cria 3 hooks', async () => {
    const user = await owner();
    for (const ms of [2000, 3000]) {
      const hook = await ready(user, { durationMs: ms });
      const { file } = await download(user, `/api/hooks/${hook.id}/file`);
      assert.ok(Math.abs((await probeFile(file)).durationSeconds - ms / 1000) < 0.2, `${ms} ms`);
    }
    const trio = await create(user, { count: 3, style: 'liquid-splash' });
    assert.equal(trio.json.hooks.length, 3);
    for (const h of trio.json.hooks) assert.equal((await until(user, h.id, ['ready', 'failed'])).status, 'ready');
    assert.equal(new Set(fake.postCalls().map((c) => c.body.options.external_task_id)).size, fake.postCalls().length, 'um pedido por hook');
  });

  it('aplica a um vídeo da biblioteca: cria um vídeo NOVO (hook + vídeo), marcado como IA; o original não muda', async () => {
    const user = await owner();
    const main = await uploadVideo(user, { audio: true, name: 'Meu anúncio' });
    const hook = await ready(user);
    const original = (await user.client.get(`/api/creatives/${main.id}`)).json.creative;

    const res = await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: main.id });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.hook.applying, true);
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: main.id })).status, 409, 'clique duplo: só uma aplicação por vez');
    await ctx.hooks.idle();

    const done = await get(user, hook.id);
    assert.equal(done.applying, false);
    assert.equal(done.applyError, null);
    assert.ok(done.creativeId);
    const made = (await user.client.get(`/api/creatives/${done.creativeId}`)).json.creative;
    assert.deepEqual({ name: made.name, kind: made.kind, ai: made.aiGenerated, hasFile: made.hasFile }, { name: 'Meu anúncio + Hook IA', kind: 'video', ai: true, hasFile: true });
    assert.notEqual(made.id, main.id);

    const { file } = await download(user, `/api/creatives/${made.id}/file`);
    const info = await probeFile(file);
    assert.deepEqual([info.width, info.height, info.hasAudio], [540, 960, true], 'no tamanho do vídeo original e com áudio');
    assert.ok(Math.abs(info.durationSeconds - (2.5 + 2)) < 0.5, `hook 2,5 s + vídeo 2 s = ${info.durationSeconds}`);
    const untouched = (await user.client.get(`/api/creatives/${main.id}`)).json.creative;
    assert.deepEqual([untouched.sizeBytes, untouched.name, untouched.aiGenerated], [original.sizeBytes, original.name, false], 'o vídeo original continua intacto');
    const listed = (await user.client.get('/api/creatives')).json.creatives;
    assert.deepEqual(listed.map((c) => [c.name, c.aiGenerated]).sort((a, b) => a[0].length - b[0].length), [['Meu anúncio', false], ['Meu anúncio + Hook IA', true]]);
  });

  it('vídeo sem áudio e vídeo horizontal também funcionam (som mudo no hook; hook cobre o quadro)', async () => {
    const user = await owner();
    const silent = await uploadVideo(user, { audio: false, width: 960, height: 540, name: 'Horizontal mudo' });
    const hook = await ready(user, { durationMs: 2000 });
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: silent.id, name: 'Meu nome' })).status, 202);
    await ctx.hooks.idle();
    const done = await get(user, hook.id);
    assert.equal(done.applyError, null);
    const { file } = await download(user, `/api/creatives/${done.creativeId}/file`);
    const info = await probeFile(file);
    assert.deepEqual([info.width, info.height], [960, 540]);
    assert.equal(info.hasAudio, true, 'o resultado sempre tem faixa de áudio (mudo onde não havia)');
    assert.equal((await user.client.get(`/api/creatives/${done.creativeId}`)).json.creative.name, 'Meu nome');
  });

  it('sem escolher vídeo: guarda só o hook como criativo (marcado como IA)', async () => {
    const user = await owner();
    const hook = await ready(user, { style: 'giant-object' });
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, {})).status, 202);
    await ctx.hooks.idle();
    const done = await get(user, hook.id);
    const made = (await user.client.get(`/api/creatives/${done.creativeId}`)).json.creative;
    assert.deepEqual([made.name, made.kind, made.aiGenerated], ['Hook IA – Objeto gigante', 'video', true]);
  });

  it('recusa aplicar em imagem, em criativo inexistente ou de outro usuário, e hook que não está pronto', async () => {
    const user = await owner();
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    const hook = await ready(user);
    const image = (await uploadCreative(user.client, { type: 'png', name: 'Foto' })).json.creative;
    const strangers = await uploadVideo(other, { name: 'Do outro' });
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: image.id })).status, 400);
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: 999999 })).status, 404);
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: strangers.id })).status, 404, 'vídeo de outra pessoa: 404');
    assert.equal((await user.client.post(`/api/hooks/${hook.id}/apply`, { creativeId: 'abc' })).status, 400);
    const queued = (await create(user)).json.hooks[0];
    assert.equal((await user.client.post(`/api/hooks/${queued.id}/apply`, {})).status, 409);
  });

  it('isolamento: outro usuário não vê, não assiste, não aplica e não apaga o hook', async () => {
    const user = await owner();
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    const hook = await ready(user);
    assert.deepEqual((await other.client.get('/api/hooks')).json.hooks, []);
    assert.equal((await other.client.get(`/api/hooks/${hook.id}/file`)).status, 404);
    assert.equal((await other.client.post(`/api/hooks/${hook.id}/apply`, {})).status, 404);
    assert.equal((await other.client.delete(`/api/hooks/${hook.id}`)).status, 404);
    assert.equal((await user.client.get(`/api/hooks/${hook.id}/file`)).status, 200);
  });

  it('descartar apaga o pedido e o arquivo do disco', async () => {
    const user = await owner();
    const hook = await ready(user);
    const row = await one(ctx.db, 'SELECT storage_key FROM creative_hooks WHERE id = $1', [hook.id]);
    const onDisk = path.join(ctx.config.creatives.dir, row.storage_key);
    assert.ok(fs.existsSync(onDisk));
    assert.equal((await user.client.delete(`/api/hooks/${hook.id}`)).status, 204);
    assert.equal(fs.existsSync(onDisk), false);
    assert.equal((await user.client.delete(`/api/hooks/${hook.id}`)).status, 404);
  });

  describe('falhas da Kling', () => {
    it('a Kling não conseguiu gerar: o hook falha com mensagem clara (sem texto interno)', async () => {
      const user = await owner();
      fake.state.failAllTasks = true;
      const res = await create(user);
      const hook = await until(user, res.json.hooks[0].id, ['failed', 'ready']);
      fake.state.failAllTasks = false;
      assert.equal(hook.status, 'failed');
      assert.match(hook.errorMessage, /não conseguiu gerar/);
      assert.ok(!JSON.stringify(hook).includes('generation failed'));
    });

    it('sem saldo na Kling: falha com aviso ao administrador e os demais da fila nem são tentados', async () => {
      const user = await owner();
      fake.state.createError = { http: 429, code: 1102, message: 'Account balance not enough' };
      fake.state.createErrorTimes = 99;
      const res = await create(user, { count: 3 });
      const hooks = await Promise.all(res.json.hooks.map((h) => until(user, h.id, ['failed', 'ready'])));
      assert.deepEqual(hooks.map((h) => h.status), ['failed', 'failed', 'failed']);
      for (const h of hooks) assert.match(h.errorMessage, /saldo|créditos/i);
      assert.equal(fake.postCalls().length, 1, 'só a primeira chamada chegou à Kling');
    });

    it('conteúdo recusado pela política da Kling: pede outra ideia', async () => {
      const user = await owner();
      fake.state.createError = { http: 400, code: 1301, message: 'content security' };
      fake.state.createErrorTimes = 1;
      const hook = await ready(user, { idea: 'qualquer coisa' });
      assert.equal(hook.status, 'failed');
      assert.match(hook.errorMessage, /política de conteúdo/);
    });

    it('Kling ocupada: o pedido fica na fila e é reenviado no ciclo seguinte', async () => {
      const user = await owner();
      fake.state.createError = { http: 429, code: 1303, message: 'parallel task over resource pack limit' };
      fake.state.createErrorTimes = 2;
      const hook = await ready(user);
      assert.equal(hook.status, 'ready', hook.errorMessage);
      assert.equal(fake.postCalls().length, 3, '2 tentativas ocupadas + 1 que funcionou');
    });

    it('a Kling nunca responde: depois do prazo o hook falha', async () => {
      const user = await owner();
      fake.state.pollsToSucceed = 9999;
      const id = (await create(user)).json.hooks[0].id;
      await until(user, id, ['generating']);
      nowMs += 16 * 60 * 1000;
      assert.equal((await until(user, id, ['failed'])).status, 'failed');
      assert.match((await get(user, id)).errorMessage, /demorou demais/);
    });

    it('erro momentâneo ao consultar não derruba a tarefa (já foi paga); chave recusada derruba', async () => {
      const user = await owner();
      fake.state.pollsToSucceed = 3; // dá tempo de interferir no meio
      const id = (await create(user)).json.hooks[0].id;
      await until(user, id, ['generating']);
      fake.state.taskQueryError = { http: 500, code: 5000 };
      await ctx.hooks.tick();
      assert.equal((await get(user, id)).status, 'generating');
      fake.state.taskQueryError = null;
      assert.equal((await until(user, id, ['ready', 'failed'])).status, 'ready');
    });

    it('endereço de vídeo suspeito (fora da lista, IP interno) é recusado SEM baixar nada', async () => {
      const user = await owner();
      for (const url of ['https://evil.example.com/x.mp4', 'http://169.254.169.254/latest/meta-data', 'https://127.0.0.1/x.mp4']) {
        fake.state.resultUrl = () => url;
        const hook = await ready(user);
        assert.equal(hook.status, 'failed', url);
        assert.match(hook.errorMessage, /endereço de vídeo não permitido/);
      }
      assert.equal(fake.state.downloads.length, 0, 'nenhum download foi feito');
    });

    it('arquivo que não é vídeo, vídeo quebrado e download com erro viram falha com mensagem clara', async () => {
      const user = await owner();
      fake.state.downloadBytes = Buffer.from('<html><script>alert(1)</script></html>');
      assert.match((await ready(user)).errorMessage, /não é um vídeo/);
      fake.state.downloadBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 7)]); // cabeçalho de MP4 com lixo
      const broken = await ready(user);
      assert.equal(broken.status, 'failed');
      assert.match(broken.errorMessage, /processar o vídeo do hook/);
      fake.state.downloadBytes = null;
      fake.state.downloadStatus = 403;
      assert.match((await ready(user)).errorMessage, /baixar o vídeo/);
      fake.state.downloadStatus = 200;
      fake.state.omitVideo = true;
      assert.match((await ready(user)).errorMessage, /não devolveu o vídeo/);
      await sleep(300);
      const left = fs.readdirSync(path.join(ctx.config.creatives.dir, '.tmp')).filter((f) => f.startsWith('hook-') || f.endsWith('.part'));
      assert.deepEqual(left, [], 'nenhum arquivo temporário sobra');
    });
  });

  describe('limites de custo', () => {
    it('limite diário por usuário, pedidos ativos e limite geral', async () => {
      const lim = await startTestServer({ limits: LIMITS, config: { kling: klingTestConfig({ dailyLimit: 4, globalDailyLimit: 5 }) }, creatives: CLEAN, klingFetch: fake.fetchFn, isolated: true });
      try {
        const a = await createUser(lim, { approve: true, email: emailOf() });
        const b = await createUser(lim, { approve: true, email: emailOf() });
        assert.equal((await a.client.post('/api/hooks', body({ count: 3 }))).status, 201);
        const over = await a.client.post('/api/hooks', body({ count: 2 }));
        assert.equal(over.status, 429);
        assert.equal(over.json.error.code, 'hooks_daily_limit');
        assert.equal((await a.client.post('/api/hooks', body({ count: 1 }))).status, 201, 'o 4º cabe');
        assert.equal((await a.client.post('/api/hooks', body())).status, 429);
        const globalHit = await b.client.post('/api/hooks', body({ count: 2 }));
        assert.equal(globalHit.json.error.code, 'hooks_global_limit', 'sobraria 1 no sistema todo');
        assert.equal((await b.client.post('/api/hooks', body({ count: 1 }))).status, 201);
        const usage = (await a.client.get('/api/hooks')).json;
        assert.deepEqual([usage.usedLast24h, usage.dailyLimit], [4, 4]);
      } finally {
        await lim.stop();
      }
    });

    it('no máximo 6 pedidos ativos por usuário', async () => {
      const lim = await startTestServer({ limits: LIMITS, config: { kling: klingTestConfig({ dailyLimit: 50, concurrency: 1 }) }, creatives: CLEAN, klingFetch: fake.fetchFn, isolated: true });
      fake.state.pollsToSucceed = 9999; // nada termina durante o teste: os pedidos continuam "ativos"
      try {
        const a = await createUser(lim, { approve: true, email: emailOf() });
        assert.equal((await a.client.post('/api/hooks', body({ count: 3 }))).status, 201);
        assert.equal((await a.client.post('/api/hooks', body({ count: 3 }))).status, 201);
        const seventh = await a.client.post('/api/hooks', body({ count: 1 }));
        assert.equal(seventh.status, 429);
        assert.equal(seventh.json.error.code, 'hooks_too_many_active');
      } finally {
        fake.state.pollsToSucceed = 1;
        await lim.stop();
      }
    });

    it('o limite de pedidos por minuto (rota) também vale', async () => {
      const lim = await startTestServer({ limits: { ...LIMITS, hooksCreate: 2 }, config: { kling: klingTestConfig() }, creatives: CLEAN, klingFetch: fake.fetchFn, isolated: true });
      try {
        const a = await createUser(lim, { approve: true, email: emailOf() });
        const statuses = [];
        for (let i = 0; i < 3; i += 1) statuses.push((await a.client.post('/api/hooks', body())).status);
        assert.deepEqual(statuses, [201, 201, 429]);
      } finally {
        await lim.stop();
      }
    });
  });

  it('colaborador: só com a área "Criativos" (e age em nome do dono); sem ela, 403', async () => {
    const user = await owner();
    async function collaborator(areas) {
      const email = emailOf();
      assert.equal((await user.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    const reports = await collaborator(['reports']);
    assert.equal((await reports.get('/api/hooks')).status, 403);
    assert.equal((await reports.post('/api/hooks', body())).status, 403);
    const creatives = await collaborator(['creatives']);
    const made = await creatives.post('/api/hooks', body());
    assert.equal(made.status, 201, made.text);
    assert.equal((await get(user, made.json.hooks[0].id)).id, made.json.hooks[0].id, 'o hook é do espaço do dono');
  });

  it('desligado (sem chave da Kling): a tela é avisada e nada é criado', async () => {
    const off = await startTestServer({ limits: LIMITS, config: { kling: klingTestConfig({ apiKey: '', enabled: false }) }, creatives: CLEAN, klingFetch: fake.fetchFn, isolated: true });
    try {
      const a = await createUser(off, { approve: true, email: emailOf() });
      const info = await a.client.get('/api/hooks');
      assert.equal(info.json.enabled, false);
      const res = await a.client.post('/api/hooks', body());
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'hooks_not_configured');
      await off.hooks.start();
      await off.hooks.tick();
    } finally {
      await off.stop();
    }
  });

  it('depois de uma queda do servidor, o que estava "ajustando" volta a ser acompanhado e aplicações interrompidas falham', async () => {
    const user = await owner();
    fake.state.pollsToSucceed = 3;
    const hook = (await create(user)).json.hooks[0];
    await until(user, hook.id, ['generating']);
    await run(ctx.db, "UPDATE creative_hooks SET status = 'processing' WHERE id = $1", [hook.id]);
    const ready1 = await ready(user);
    await run(ctx.db, "UPDATE creative_hooks SET apply_status = 'running' WHERE id = $1", [ready1.id]);
    await ctx.hooks.start();
    ctx.hooks.stop();
    assert.equal((await get(user, hook.id)).status, 'generating');
    const interrupted = await get(user, ready1.id);
    assert.equal(interrupted.applying, false);
    assert.match(interrupted.applyError, /interrompida/);
    assert.equal((await until(user, hook.id, ['ready', 'failed'])).status, 'ready');
  });

  it('hooks antigos e não usados são apagados (e o arquivo também)', async () => {
    const user = await owner();
    const hook = await ready(user);
    const old = await ready(user, { style: 'paper-tear' });
    const key = (await one(ctx.db, 'SELECT storage_key FROM creative_hooks WHERE id = $1', [old.id])).storage_key;
    await run(ctx.db, "UPDATE creative_hooks SET created_at = now() - interval '20 days' WHERE id = $1", [old.id]);
    await ctx.hooks.start();
    await sleep(300);
    ctx.hooks.stop();
    assert.equal(await get(user, old.id), undefined);
    assert.equal(fs.existsSync(path.join(ctx.config.creatives.dir, key)), false);
    assert.ok(await get(user, hook.id), 'o recente fica');
  });

  it('o banco recusa estados e valores inválidos', async () => {
    const user = await owner();
    const hook = await ready(user);
    const bad = [
      ["UPDATE creative_hooks SET status = 'qualquer' WHERE id = $1"], ["UPDATE creative_hooks SET duration_ms = 5000 WHERE id = $1"],
      ["UPDATE creative_hooks SET kling_task_id = 'a b;c' WHERE id = $1"], ["UPDATE creative_hooks SET storage_key = NULL WHERE id = $1"],
      ["UPDATE creative_hooks SET apply_status = 'x' WHERE id = $1"],
    ];
    for (const [sql] of bad) await assert.rejects(run(ctx.db, sql, [hook.id]), (e) => e.code === '23514', sql);
  });
});
