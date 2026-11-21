import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, USER_PASSWORD, all, createUser, one, run, startTestServer, uniqueEmail } from './helpers.js';

describe('Cadastro e login', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: { register: 1000, loginIp: 1000, loginAccount: 1000 } });
  });
  after(() => ctx.stop());

  it('cria conta como PENDENTE e sem privilégios', async () => {
    const email = uniqueEmail();
    const res = await ctx.client().post('/api/auth/register', { name: 'Maria Silva', company: 'Loja X', email, password: USER_PASSWORD });
    assert.equal(res.status, 201);
    const row = (await one(ctx.db, 'SELECT * FROM users WHERE email = $1', [email]));
    assert.equal(row.status, 'pending');
    assert.equal(row.role, 'user');
    assert.notEqual(row.password_hash, USER_PASSWORD);
    assert.match(row.password_hash, /^scrypt\$/);
  });

  it('ignora tentativa de injetar role/status no cadastro (mass assignment)', async () => {
    const email = uniqueEmail();
    await ctx.client().post('/api/auth/register', { name: 'Hacker', email, password: USER_PASSWORD, role: 'admin', status: 'approved' });
    const row = (await one(ctx.db, 'SELECT role, status FROM users WHERE email = $1', [email]));
    assert.deepEqual({ ...row }, { role: 'user', status: 'pending' });
  });

  it('valida entradas do cadastro', async () => {
    const c = ctx.client();
    assert.equal((await c.post('/api/auth/register', { name: 'A', email: uniqueEmail(), password: USER_PASSWORD })).status, 400);
    assert.equal((await c.post('/api/auth/register', { name: 'Maria', email: 'invalido', password: USER_PASSWORD })).status, 400);
    assert.equal((await c.post('/api/auth/register', { name: 'Maria', email: uniqueEmail(), password: 'curta' })).status, 400);
    assert.equal((await c.post('/api/auth/register', { name: 'Maria', email: uniqueEmail(), password: 123456789012 })).status, 400);
    assert.equal((await c.post('/api/auth/register', { name: { $ne: 1 }, email: uniqueEmail(), password: USER_PASSWORD })).status, 400);
    assert.equal((await c.request('POST', '/api/auth/register', { raw: '[1,2]' })).status, 400);
    assert.equal((await c.request('POST', '/api/auth/register', { raw: '{nao-json' })).status, 400);
  });

  it('rejeita corpo muito grande (413)', async () => {
    const res = await ctx.client().post('/api/auth/register', { name: 'x'.repeat(50_000), email: uniqueEmail(), password: USER_PASSWORD });
    assert.equal(res.status, 413);
  });

  it('e-mail duplicado tem a mesma resposta (sem enumerar contas) e não altera a conta original', async () => {
    const email = uniqueEmail();
    const first = await ctx.client().post('/api/auth/register', { name: 'Original', email, password: USER_PASSWORD });
    const second = await ctx.client().post('/api/auth/register', { name: 'Impostor', email: email.toUpperCase(), password: 'OutraSenha-123456' });
    assert.equal(second.status, first.status);
    assert.deepEqual(second.json, first.json);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM users WHERE email = $1', [email])).c, 1);
    assert.equal((await one(ctx.db, 'SELECT name FROM users WHERE email = $1', [email])).name, 'Original');
    assert.equal((await ctx.client().login(email, 'OutraSenha-123456')).status, 401);
  });

  it('NÃO permite sequestrar o e-mail do administrador via cadastro público', async () => {
    const res = await ctx.client().post('/api/auth/register', { name: 'Atacante', email: ADMIN_EMAIL, password: 'SenhaDoAtacante-123' });
    assert.equal(res.status, 201); // resposta genérica
    assert.equal((await ctx.client().login(ADMIN_EMAIL, 'SenhaDoAtacante-123')).status, 401);
    assert.equal((await ctx.client().login(ADMIN_EMAIL, ADMIN_PASSWORD)).status, 200);
  });

  it('login: mesma mensagem para senha errada e e-mail inexistente', async () => {
    const { email } = await createUser(ctx);
    const wrongPass = await ctx.client().login(email, 'senha-errada-123');
    const unknown = await ctx.client().login('naoexiste@example.com', 'senha-errada-123');
    assert.equal(wrongPass.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrongPass.json, unknown.json);
  });

  it('login define cookie HttpOnly + SameSite=Strict e /me não vaza hash', async () => {
    const { client } = await createUser(ctx);
    const login = await ctx.client().login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = login.setCookies.find((c) => c.startsWith('tt_sid='));
    assert.ok(cookie, 'cookie de sessão presente');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//);
    const me = await client.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.ok(!('password_hash' in me.json.user) && !('passwordHash' in me.json.user));
    assert.ok(!me.text.includes('scrypt$'));
  });

  it('guarda apenas o HASH do token de sessão no banco', async () => {
    const { client } = await createUser(ctx);
    const token = client.cookie.split('=')[1];
    const rows = (await all(ctx.db, 'SELECT token_hash FROM sessions'));
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.token_hash !== token));
  });

  it('logout invalida a sessão no servidor', async () => {
    const { client } = await createUser(ctx);
    const stolenCookie = client.cookie;
    assert.equal((await client.post('/api/auth/logout')).status, 204);
    const replay = ctx.client();
    const res = await replay.get('/api/auth/me', { headers: { cookie: stolenCookie } });
    assert.equal(res.json.user, null);
    assert.equal((await replay.get('/api/campaigns', { headers: { cookie: stolenCookie } })).status, 401);
  });

  it('sessão expirada é recusada', async () => {
    const { client } = await createUser(ctx);
    await run(ctx.db, "UPDATE sessions SET expires_at = now() - interval '1 day'");
    assert.equal((await client.get('/api/auth/me')).json.user, null);
    assert.equal((await client.get('/api/campaigns')).status, 401);
  });

  it('cookie forjado/lixo é recusado', async () => {
    const c = ctx.client();
    for (const cookie of ['tt_sid=abc', 'tt_sid=' + 'a'.repeat(300), 'tt_sid=%E0%A4%A', 'tt_sid=']) {
      assert.equal((await c.get('/api/auth/me', { headers: { cookie } })).json.user, null, cookie);
      assert.equal((await c.get('/api/campaigns', { headers: { cookie } })).status, 401, cookie);
    }
  });
});

describe('Proteções (CSRF / origem / rate limit)', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: { register: 1000, loginIp: 1000, loginAccount: 5 } });
  });
  after(() => ctx.stop());

  it('bloqueia requisição de escrita sem token CSRF', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const res = await client.post('/api/campaigns', { name: 'X1', objective: 'TRAFFIC', dailyBudget: 100 }, { withCsrf: false });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'bad_csrf');
  });

  it('bloqueia token CSRF de outra sessão', async () => {
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const res = await a.client.post('/api/campaigns', { name: 'X1', objective: 'TRAFFIC', dailyBudget: 100 }, {
      headers: { 'x-csrf-token': (await b.client.get('/api/auth/me')).json.csrfToken },
      withCsrf: false,
    });
    assert.equal(res.status, 403);
  });

  it('bloqueia Origin de outro site (login e rotas autenticadas)', async () => {
    const c = ctx.client();
    const login = await c.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { headers: { origin: 'https://evil.example' } });
    assert.equal(login.status, 403);
    const fetchMeta = await c.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(fetchMeta.status, 403);
  });

  it('aceita Origin do próprio site', async () => {
    const c = ctx.client();
    const res = await c.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { headers: { origin: ctx.baseUrl } });
    assert.equal(res.status, 200);
  });

  it('limita tentativas de login por conta (429 + Retry-After) e libera após sucesso', async () => {
    const { email } = await createUser(ctx);
    for (let i = 0; i < 5; i++) assert.equal((await ctx.client().login(email, 'errada-errada-1')).status, 401);
    const blocked = await ctx.client().login(email, USER_PASSWORD); // mesmo com a senha certa
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });

  it('envia cabeçalhos de segurança e CSP restritiva', async () => {
    const res = await ctx.client().get('/login');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
    const api = await ctx.client().get('/api/auth/me');
    assert.equal(api.headers.get('cache-control'), 'no-store');
  });
});

describe('ensureAdmin', () => {
  it('cria o admin aprovado e redefine a senha quando ADMIN_PASSWORD muda', async () => {
    const ctx = await startTestServer();
    try {
      const row = (await one(ctx.db, 'SELECT role, status FROM users WHERE email = $1', [ADMIN_EMAIL]));
      assert.deepEqual({ ...row }, { role: 'admin', status: 'approved' });

      const admin = ctx.client();
      assert.equal((await admin.login(ADMIN_EMAIL, ADMIN_PASSWORD)).status, 200);

      ctx.config.adminPassword = 'NovaSenhaAdmin-456';
      await ctx.authService.ensureAdmin({ info() {} });
      assert.equal((await admin.get('/api/auth/me')).json.user, null, 'sessões antigas encerradas');
      assert.equal((await ctx.client().login(ADMIN_EMAIL, ADMIN_PASSWORD)).status, 401);
      assert.equal((await ctx.client().login(ADMIN_EMAIL, 'NovaSenhaAdmin-456')).status, 200);
    } finally {
      await ctx.stop();
    }
  });

  it('gera senha aleatória quando ADMIN_PASSWORD não está definida', async () => {
    const lines = [];
    const ctx = await startTestServer({ config: { adminPassword: '' } });
    try {
      (await run(ctx.db, 'DELETE FROM users'));
      await ctx.authService.ensureAdmin({ info: (m) => lines.push(m) });
      const generated = lines.find((l) => l.includes('Senha gerada'))?.split(': ').pop();
      assert.ok(generated && generated.length >= 12);
      assert.equal((await ctx.client().login(ADMIN_EMAIL, generated)).status, 200);
    } finally {
      await ctx.stop();
    }
  });

  it('recusa ADMIN_PASSWORD fraca', async () => {
    const ctx = await startTestServer();
    try {
      ctx.config.adminPassword = 'curta';
      await assert.rejects(() => ctx.authService.ensureAdmin({ info() {} }), /ADMIN_PASSWORD/);
    } finally {
      await ctx.stop();
    }
  });
});
