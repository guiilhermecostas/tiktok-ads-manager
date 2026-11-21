import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createUser, one, run, startTestServer } from './helpers.js';
// Os testes de login criam muitos usuários; limites altos evitam interferência do rate limit.

const valid = { name: 'Black Friday', objective: 'CONVERSIONS', dailyBudget: 15000, status: 'active' };

describe('Campanhas', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: { register: 1000, loginIp: 1000, loginAccount: 1000 } });
  });
  after(() => ctx.stop());

  it('CRUD completo', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const created = await client.post('/api/campaigns', valid);
    assert.equal(created.status, 201);
    const { id } = created.json.campaign;
    assert.equal(created.json.campaign.dailyBudget, 15000);

    assert.equal((await client.get('/api/campaigns')).json.campaigns.length, 1);
    assert.equal((await client.get(`/api/campaigns/${id}`)).json.campaign.name, 'Black Friday');

    const updated = await client.put(`/api/campaigns/${id}`, { ...valid, name: 'Cyber Monday', status: 'paused' });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.campaign.name, 'Cyber Monday');
    assert.equal(updated.json.campaign.status, 'paused');

    const summary = (await client.get('/api/campaigns/summary')).json.summary;
    assert.deepEqual(summary, { total: 1, active: 0, paused: 1, draft: 0, activeBudget: 0 });

    assert.equal((await client.delete(`/api/campaigns/${id}`)).status, 204);
    assert.equal((await client.get(`/api/campaigns/${id}`)).status, 404);
  });

  it('isola dados entre usuários (sem IDOR)', async () => {
    const a = await createUser(ctx, { approve: true });
    const b = await createUser(ctx, { approve: true });
    const { id } = (await a.client.post('/api/campaigns', valid)).json.campaign;

    assert.equal((await b.client.get(`/api/campaigns/${id}`)).status, 404);
    assert.equal((await b.client.put(`/api/campaigns/${id}`, { ...valid, name: 'Invadida' })).status, 404);
    assert.equal((await b.client.delete(`/api/campaigns/${id}`)).status, 404);
    assert.equal((await b.client.get('/api/campaigns')).json.campaigns.length, 0);
    assert.equal((await a.client.get(`/api/campaigns/${id}`)).json.campaign.name, 'Black Friday');
  });

  it('valida campos da campanha', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const bad = [
      { ...valid, name: '' },
      { ...valid, name: 'x'.repeat(101) },
      { ...valid, objective: 'DROP TABLE' },
      { ...valid, dailyBudget: -1 },
      { ...valid, dailyBudget: 1.5 },
      { ...valid, dailyBudget: '100' },
      { ...valid, dailyBudget: 1e12 },
      { ...valid, status: 'deleted' },
      { ...valid, name: 'com\u0000controle' },
    ];
    for (const payload of bad) {
      assert.equal((await client.post('/api/campaigns', payload)).status, 400, JSON.stringify(payload));
    }
    assert.equal((await client.get('/api/campaigns/abc')).status, 400);
    assert.equal((await client.get('/api/campaigns/1;DROP')).status, 400);
  });

  it('trata SQL injection e HTML como texto puro', async () => {
    const { client } = await createUser(ctx, { approve: true });
    const evil = `'); DROP TABLE users;-- <img src=x onerror=alert(1)>`;
    const res = await client.post('/api/campaigns', { ...valid, name: evil });
    assert.equal(res.status, 201);
    assert.equal(res.json.campaign.name, evil);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM users')).c > 0, true);
  });

  it('excluir usuário remove suas campanhas e sessões (cascade)', async () => {
    const { client, id } = await createUser(ctx, { approve: true });
    await client.post('/api/campaigns', valid);
    (await run(ctx.db, 'DELETE FROM users WHERE id = $1', [id]));
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM campaigns WHERE user_id = $1', [id])).c, 0);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*) c FROM sessions WHERE user_id = $1', [id])).c, 0);
  });
});

describe('Front-end estático e rotas', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: { register: 1000, loginIp: 1000, loginAccount: 1000 } });
  });
  after(() => ctx.stop());

  it('serve o shell da SPA nas rotas de navegação', async () => {
    for (const path of ['/', '/login', '/register', '/campaigns', '/admin']) {
      const res = await ctx.client().get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.text, /<div id="app"/);
    }
  });

  it('serve os assets e bloqueia arquivos sensíveis', async () => {
    const c = ctx.client();
    assert.equal((await c.get('/css/styles.css')).status, 200);
    assert.equal((await c.get('/js/main.js')).status, 200);
    for (const path of ['/.env', '/package.json', '/src/config.js', '/data/app.db', '/../package.json', '/%2e%2e/package.json', '/js/../../.env']) {
      const res = await c.get(path);
      assert.ok(![200].includes(res.status) || res.text.includes('id="app"'), `${path} -> ${res.status}`);
      assert.ok(!res.text.includes('ADMIN_PASSWORD') && !res.text.includes('"dependencies"'), `${path} vazou conteúdo`);
    }
  });

  it('rotas /api inexistentes: 401 para anônimo (não revela rotas) e JSON 404 para aprovado', async () => {
    const anon = await ctx.client().get('/api/nao-existe');
    assert.equal(anon.status, 401);
    const { client } = await createUser(ctx, { approve: true });
    const res = await client.get('/api/nao-existe');
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'not_found');
  });
});
