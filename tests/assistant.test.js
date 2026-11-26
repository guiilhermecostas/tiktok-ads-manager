import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parsePeriod } from '../src/modules/assistant/assistant.routes.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, assistantRead: 1000 };
const m = (spend) => ({ spend, impressions: spend * 100, clicks: spend * 3, conversion: 1 });
const RANGE = '?from=2026-11-25T00:00:00Z&to=2026-11-26T00:00:00Z';

describe('Assistente: período pedido', () => {
  it('aceita ISO UTC e recusa o resto', () => {
    const { from, to } = parsePeriod({ from: '2026-11-25T03:00:00.000Z', to: '2026-11-26T03:00:00Z' });
    assert.equal(to.getTime() - from.getTime(), 24 * 3600 * 1000);
    for (const q of [{}, { from: '2026-11-25' }, { from: 'x', to: 'y' }, { from: '2026-11-26T00:00:00Z', to: '2026-11-25T00:00:00Z' }, { from: '2026-11-25T00:00:00Z', to: '2026-11-25T00:00:00Z' }, { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' }, { from: ['a'], to: 'b' }, { from: '2026-13-45T99:99:99Z', to: '2026-11-26T00:00:00Z' }]) {
      assert.throws(() => parsePeriod(q), (err) => err.status === 400, JSON.stringify(q));
    }
  });
});

describe('Assistente: contas que caíram e criativos enviados (API)', () => {
  let ctx;
  let fake;
  let nowMs;
  before(async () => {
    fake = createFakeTiktok();
    nowMs = Date.parse('2026-11-25T17:20:00Z');
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn, clock: () => new Date(nowMs), monitorStatuses: true });
  });
  after(() => ctx.stop());

  const reset = async () => {
    for (const table of ['advertiser_status_events', 'advertiser_status', 'spend_ledger', 'tiktok_hourly_spend', 'tiktok_business_centers', 'creatives']) await run(ctx.db, `DELETE FROM ${table}`);
    fake.state.bcs = { 111: ['9001', '9002'] };
    fake.state.currencies = { 9001: 'USD', 9002: 'USD' };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.hourly = {};
    fake.state.advertiserStatus = {};
    fake.state.rejectFields = false;
    fake.state.failHourlyFor = new Set();
    fake.state.hourlyDelayMs = 0;
  };
  const owner = async () => {
    const user = await createUser(ctx, { approve: true });
    assert.equal((await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN })).status, 201);
    return user;
  };
  const down = (who) => who.client.get(`/api/assistant/accounts-down${RANGE}`);

  describe('situação das contas', () => {
    it('a coleta anota a situação (primeira leitura sem "de") e só registra MUDANÇAS depois', async () => {
      await reset();
      const user = await owner();
      await ctx.hourly.collectAll();
      let res = await down(user);
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.events.length, res.json.current.length, res.json.monitored], [2, 0, 2]);
      assert.ok(res.json.events.every((e) => e.previousStatus === null && e.status === 'STATUS_ENABLE'));
      assert.ok(res.json.monitoredSince);

      await ctx.hourly.collectAll();
      assert.equal((await down(user)).json.events.length, 2, 'nada mudou: nenhum evento novo');

      fake.state.advertiserStatus = { 9001: 'STATUS_LIMIT' };
      nowMs += 30 * 60 * 1000;
      await ctx.hourly.collectAll();
      res = await down(user);
      assert.equal(res.json.events.length, 3);
      assert.deepEqual([res.json.events[0].advertiserId, res.json.events[0].previousStatus, res.json.events[0].status], ['9001', 'STATUS_ENABLE', 'STATUS_LIMIT']);
      assert.deepEqual(res.json.current.map((c) => [c.advertiserId, c.status]), [['9001', 'STATUS_LIMIT']]);
      const since = res.json.current[0].since;
      await ctx.hourly.collectAll();
      assert.equal((await down(user)).json.current[0].since, since, 'a data "desde" só muda quando o status muda');

      fake.state.advertiserStatus = {};
      await ctx.hourly.collectAll();
      res = await down(user);
      assert.deepEqual([res.json.events.length, res.json.current.length], [4, 0]);
      assert.deepEqual([res.json.events[0].previousStatus, res.json.events[0].status], ['STATUS_LIMIT', 'STATUS_ENABLE']);
    });

    it('o período filtra os eventos', async () => {
      await reset();
      const user = await owner();
      await ctx.hourly.collectAll();
      const other = await user.client.get('/api/assistant/accounts-down?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z');
      assert.deepEqual([other.json.events.length, other.json.monitored], [0, 2]);
    });

    it('cada pessoa só vê as próprias contas', async () => {
      await reset();
      const user = await owner();
      await ctx.hourly.collectAll();
      const stranger = await createUser(ctx, { approve: true });
      const res = await down(stranger);
      assert.deepEqual([res.status, res.json.events.length, res.json.monitored, res.json.monitoredSince], [200, 0, 0, null]);
      assert.equal((await down(user)).json.events.length, 2);
    });

    it('se a leitura da situação falhar, o gasto por hora continua sendo coletado', async () => {
      await reset();
      const user = await owner();
      fake.state.rejectFields = true; // o TikTok recusa o pedido de campos de /advertiser/info/
      fake.state.hourly = { 9001: { '2026-11-25': { 10: m(5) } } };
      const summary = await ctx.hourly.collectAll();
      assert.ok(summary.rows >= 1 && !summary.error);
      assert.ok((await one(ctx.db, 'SELECT COUNT(*)::int c FROM tiktok_hourly_spend')).c >= 1);
      assert.equal((await down(user)).json.monitored, 0);
    });

    it('conta que o TikTok devolve com status fora do padrão é ignorada (nada inválido entra no banco)', async () => {
      await reset();
      await owner();
      fake.state.advertiserStatus = { 9001: 'banida!', 9002: 'STATUS_LIMIT' };
      await ctx.hourly.collectAll();
      assert.deepEqual((await all(ctx.db, 'SELECT advertiser_id FROM advertiser_status ORDER BY 1')).map((r) => r.advertiser_id), ['9002']);
    });

    it('o banco recusa status e IDs inválidos', async () => {
      await reset();
      const user = await createUser(ctx, { approve: true });
      for (const sql of [
        `INSERT INTO advertiser_status (owner_id, advertiser_id, name, status) VALUES (${user.id}, '1', 'x', 'enable')`,
        `INSERT INTO advertiser_status (owner_id, advertiser_id, name, status) VALUES (${user.id}, 'abc', 'x', 'STATUS_ENABLE')`,
        `INSERT INTO advertiser_status_events (owner_id, advertiser_id, name, status) VALUES (${user.id}, '1', 'x', 'qualquer')`,
      ]) await assert.rejects(() => run(ctx.db, sql), sql);
    });
  });

  describe('criativos enviados', () => {
    const creative = (userId, name, kind, at) => run(ctx.db, `INSERT INTO creatives (user_id, name, kind, source, original_filename, mime_type, size_bytes, sha256, md5, storage_key, created_at)
      VALUES ($1, $2, $3, 'upload', $2, $4, 10, $5, $6, $7, $8)`, [userId, name, kind, kind === 'video' ? 'video/mp4' : 'image/png', `sha-${name}`, `md5-${name}`, `key-${name}`, at]);

    it('conta os enviados no período, por tipo, com os nomes dos mais recentes', async () => {
      await reset();
      const user = await createUser(ctx, { approve: true });
      await creative(user.id, 'video-a', 'video', '2026-11-25T08:00:00Z');
      await creative(user.id, 'video-b', 'video', '2026-11-25T12:00:00Z');
      await creative(user.id, 'imagem-a', 'image', '2026-11-25T15:00:00Z');
      await creative(user.id, 'antigo', 'video', '2026-11-20T15:00:00Z');
      const res = await user.client.get(`/api/assistant/creatives${RANGE}`);
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.total, res.json.videos, res.json.images], [3, 2, 1]);
      assert.deepEqual(res.json.latest, ['imagem-a', 'video-b', 'video-a']);
      assert.equal((await user.client.get('/api/assistant/creatives?from=2026-11-26T00:00:00Z&to=2026-11-27T00:00:00Z')).json.total, 0);
    });

    it('não conta os de outra pessoa nem os importados do TikTok', async () => {
      await reset();
      const [a, b] = [await createUser(ctx, { approve: true }), await createUser(ctx, { approve: true })];
      await creative(b.id, 'do-outro', 'video', '2026-11-25T08:00:00Z');
      await run(ctx.db, "INSERT INTO creatives (user_id, name, kind, source, created_at) VALUES ($1, 'do-tiktok', 'video', 'tiktok', '2026-11-25T09:00:00Z')", [a.id]);
      assert.equal((await a.client.get(`/api/assistant/creatives${RANGE}`)).json.total, 0);
      assert.equal((await b.client.get(`/api/assistant/creatives${RANGE}`)).json.total, 1);
    });
  });

  describe('permissões e validação', () => {
    it('visitante 401; conta pendente 403; período inválido 400', async () => {
      await reset();
      const visitor = ctx.client();
      assert.equal((await visitor.get(`/api/assistant/accounts-down${RANGE}`)).status, 401);
      assert.equal((await visitor.get(`/api/assistant/creatives${RANGE}`)).status, 401);
      const pending = await createUser(ctx);
      assert.equal((await pending.client.get(`/api/assistant/creatives${RANGE}`)).json.error.code, 'account_pending');
      const user = await createUser(ctx, { approve: true });
      for (const path of ['/api/assistant/accounts-down', '/api/assistant/creatives', '/api/assistant/creatives?from=x&to=y', '/api/assistant/accounts-down?from=2026-11-26T00:00:00Z&to=2026-11-25T00:00:00Z']) {
        assert.equal((await user.client.get(path)).status, 400, path);
      }
    });

    it('colaborador só vê o que a área dele permite (contas: "Contas TikTok"; criativos: "Criativos")', async () => {
      await reset();
      const boss = await createUser(ctx, { approve: true });
      const member = await createUser(ctx, { approve: true });
      await run(ctx.db, "INSERT INTO workspace_members (owner_id, user_id, areas) VALUES ($1, $2, ARRAY['reports'])", [boss.id, member.id]);
      assert.equal((await member.client.get(`/api/assistant/accounts-down${RANGE}`)).json.error.code, 'area_forbidden');
      assert.equal((await member.client.get(`/api/assistant/creatives${RANGE}`)).json.error.code, 'area_forbidden');
      await run(ctx.db, "UPDATE workspace_members SET areas = ARRAY['accounts', 'creatives'] WHERE user_id = $1", [member.id]);
      assert.equal((await member.client.get(`/api/assistant/accounts-down${RANGE}`)).status, 200);
      assert.equal((await member.client.get(`/api/assistant/creatives${RANGE}`)).status, 200);
    });
  });
});
