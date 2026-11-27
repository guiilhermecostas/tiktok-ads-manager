import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { loadConfig } from '../src/config.js';
import { createCreativeCleaner } from '../src/modules/creatives/creative-cleaner.js';
import { createAvatarProcessor } from '../src/modules/profile/avatar-processor.js';import { createFakeMailer } from './fake-mailer.js';
import { createStubCleaner } from './stub-cleaner.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';

export const ADMIN_EMAIL = 'contato.guilhermecostas@gmail.com';
export const ADMIN_PASSWORD = 'SenhaAdmin-Forte-123';
export const USER_PASSWORD = 'SenhaUsuario-Forte-1';

const silentLog = { info() {}, error() {}, warn() {} };
const TEST_DATABASE = { url: null, sslCaPath: null, schema: null, poolMax: 1, devDataDir: null, requireRls: true };

// ---- Acesso direto ao banco nos testes (parâmetros $1, $2…) ----
/** Primeira linha (ou undefined). */
export const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
export const all = async (db, sql, params = []) => (await db.query(sql, params)).rows;
export const run = async (db, sql, params = []) => (await db.query(sql, params)).rowCount;

// ---- Banco dos testes: Postgres de verdade (PGlite) ----
// Iniciar o PGlite é lento (segundos) e as consultas são rápidas (~1 ms): cada processo de teste cria UMA instância
// e as tabelas são esvaziadas entre servidores. Use `isolated: true` quando dois servidores coexistirem.
let shared = null;
async function sharedDatabase() {
  if (!shared) {
    shared = await openDatabase(TEST_DATABASE, { log: silentLog });
    process.once('beforeExit', () => shared.close());
  }
  return shared;
}
async function truncateAll(db) {
  const tables = await all(db, "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations'");
  await db.exec(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/** Sobe a aplicação em porta efêmera com um banco Postgres (PGlite) limpo. */
/**
 * `cleaner`: por padrão um limpador FALSO (os testes usam mídia de mentira); `'real'` usa o FFmpeg de verdade;
 * também aceita um objeto com o mesmo contrato.
 */
export async function startTestServer({ limits, config: overrides, fetchFn, isolated = false, creatives, cleaner, mailer, avatarProcessor, clock, klingFetch, fxFetch, monitorStatuses = false } = {}) {
  const MB = 1024 * 1024;
  const creativesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatives-test-'));
  const config = loadConfig({
    env: 'test',
    database: TEST_DATABASE,
    creatives: { dir: creativesDir, maxImageBytes: MB, maxVideoBytes: 5 * MB, quotaBytes: 20 * MB, ...creatives },
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    ...overrides,
  });
  let db;
  if (isolated) {
    db = await openDatabase(TEST_DATABASE, { log: silentLog });
  } else {
    db = await sharedDatabase();
    await truncateAll(db);
  }
  const tmpDir = path.join(creativesDir, '.tmp');
  const chosenCleaner = cleaner === 'real' ? createCreativeCleaner({ ffmpegPath, tmpDir, concurrency: 2, log: silentLog }) : (cleaner ?? createStubCleaner());
  // Fotos de perfil: FFmpeg de verdade (rápido com imagens pequenas), a menos que o teste injete outro processador.
  const chosenAvatars = avatarProcessor ?? createAvatarProcessor({ ffmpegPath, tmpDir });
  // E-mail falso por padrão: o cadastro envia um código por e-mail e os testes leem o código aqui. Os limites do cadastro ficam frouxos (os testes criam muitas contas).
  const chosenMailer = mailer ?? createFakeMailer();
  const testLimits = { registerEmail: 1_000_000, registerVerify: 1_000_000, registerResend: 1_000_000, ...limits };
  const built = createApp({ config, db, log: silentLog, limits: testLimits, fetchFn, cleaner: chosenCleaner, mailer: chosenMailer, avatarProcessor: chosenAvatars, clock, hourlyPauseMs: 0, hourlyReconcileDays: 0, hourlyMonitorStatuses: monitorStatuses, klingFetch, fxFetch: fxFetch ?? (async () => { throw new Error('sem rede nos testes'); }) }); // câmbio: nunca acessa a internet de verdade nos testes
  await built.authService.ensureAdmin(silentLog);
  await built.creativeStorage.init();

  const server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    db,
    config,
    creativesDir,
    cleaner: chosenCleaner,
    ...built,
    mailer: chosenMailer,
    client: () => createClient(baseUrl),
    async stop() {
      built.close();
      await new Promise((resolve) => server.close(resolve));
      if (isolated) await db.close();
      fs.rmSync(creativesDir, { recursive: true, force: true });
    },
  };
}

/** Cliente HTTP com cookie jar e suporte ao token CSRF. */
export function createClient(baseUrl) {
  let cookie = '';
  let csrf = '';
  const api = {
    get cookie() {
      return cookie;
    },
    set csrf(value) {
      csrf = value;
    },
    get csrfToken() {
      return csrf;
    },
    async request(method, urlPath, { body, headers = {}, raw, withCsrf = true } = {}) {
      const finalHeaders = { ...headers };
      if (cookie) finalHeaders.cookie = cookie;
      if (body !== undefined && raw === undefined) finalHeaders['content-type'] = 'application/json';
      if (raw !== undefined) finalHeaders['content-type'] ??= 'application/json';
      if (withCsrf && csrf && method !== 'GET') finalHeaders['x-csrf-token'] = csrf;
      const res = await fetch(baseUrl + urlPath, {
        method,
        headers: finalHeaders,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        redirect: 'manual',
      });
      const setCookies = res.headers.getSetCookie();
      for (const line of setCookies) {
        const pair = line.split(';')[0];
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        cookie = value ? `${name}=${value}` : '';
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* não-JSON */
      }
      return { status: res.status, headers: res.headers, setCookies, json, text };
    },
    get: (urlPath, opts) => api.request('GET', urlPath, opts),
    post: (urlPath, body, opts) => api.request('POST', urlPath, { body, ...opts }),
    put: (urlPath, body, opts) => api.request('PUT', urlPath, { body, ...opts }),
    patch: (urlPath, body, opts) => api.request('PATCH', urlPath, { body, ...opts }),
    delete: (urlPath, opts) => api.request('DELETE', urlPath, opts),
    async login(email, password) {
      const res = await api.post('/api/auth/login', { email, password });
      if (res.status === 200) csrf = res.json.csrfToken;
      return res;
    },
  };
  return api;
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++counter}@example.com`;

/** Cadastra e (opcionalmente) aprova um usuário, retornando um cliente logado. */
export async function createUser(ctx, { approve = false, name = 'Usuário Teste', email = uniqueEmail() } = {}) {
  const anon = ctx.client();
  const reg = await anon.post('/api/auth/register', { name, email, password: USER_PASSWORD });
  if (reg.status !== 200) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`);
  const verified = await anon.post('/api/auth/register/verify', { ticket: reg.json.ticket, code: ctx.mailer.codeFrom(ctx.mailer.lastTo(email)) });
  if (verified.status !== 201) throw new Error(`verificação do e-mail falhou: ${verified.status} ${verified.text}`);
  const id = (await one(ctx.db, 'SELECT id FROM users WHERE email = $1', [email])).id;
  if (approve) (await run(ctx.db, "UPDATE users SET status = 'approved' WHERE id = $1", [id]));
  const client = ctx.client();
  const login = await client.login(email, USER_PASSWORD);
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`);
  return { client, email, id };
}

export async function loginAdmin(ctx) {
  const client = ctx.client();
  const res = await client.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (res.status !== 200) throw new Error(`login admin falhou: ${res.status}`);
  return client;
}
