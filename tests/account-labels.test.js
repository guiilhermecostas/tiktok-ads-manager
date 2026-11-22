import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ACCOUNT_LABELS, KIND_FILTERS, MAX_LABEL_BATCH, STATUS_FILTERS, countByKind, isAccountLabel, matchesAccountFilter,
} from '../shared/account-labels.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, loginAdmin, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000 };

describe('Etiquetas de conta de anúncio: regras compartilhadas (servidor e telas)', () => {
  const standard = { id: '1', label: null, businessCenterStatus: 'active' };
  const agency = { id: '2', label: 'agency', businessCenterStatus: 'active' };
  const brokenAgency = { id: '3', label: 'agency', businessCenterStatus: 'error' };
  const brokenStandard = { id: '4', label: null, businessCenterStatus: 'error' };
  const all = [standard, agency, brokenAgency, brokenStandard];
  const ids = (filter) => all.filter((a) => matchesAccountFilter(a, filter)).map((a) => a.id);

  it('só "agency" é etiqueta válida (e nada herdado do protótipo de objeto)', () => {
    assert.equal(isAccountLabel('agency'), true);
    for (const bad of ['', 'Agency', 'standard', 'toString', '__proto__', 'constructor', null, undefined, 1, {}, ['agency']]) assert.equal(isAccountLabel(bad), false, String(bad));
    assert.deepEqual(Object.keys(ACCOUNT_LABELS), ['agency']);
    assert.throws(() => { 'use strict'; ACCOUNT_LABELS.outra = 'x'; }, TypeError, 'a lista é imutável');
  });

  it('filtro por tipo e por situação, isolados e combinados', () => {
    assert.deepEqual(ids({}), ['1', '2', '3', '4'], 'sem filtro: tudo');
    assert.deepEqual(ids({ kind: 'all', status: 'all' }), ['1', '2', '3', '4']);
    assert.deepEqual(ids({ kind: 'agency' }), ['2', '3']);
    assert.deepEqual(ids({ kind: 'standard' }), ['1', '4']);
    assert.deepEqual(ids({ status: 'active' }), ['1', '2']);
    assert.deepEqual(ids({ status: 'inactive' }), ['3', '4']);
    assert.deepEqual(ids({ kind: 'agency', status: 'active' }), ['2']);
    assert.deepEqual(ids({ kind: 'standard', status: 'inactive' }), ['4']);
    assert.deepEqual(ids({ kind: 'agency', status: 'inactive' }), ['3']);
  });

  it('tipo desconhecido não deixa passar nada (falha fechada)', () => {
    assert.deepEqual(ids({ kind: 'qualquer-coisa' }), []);
  });

  it('contagem por tipo e opções dos filtros', () => {
    assert.deepEqual(countByKind(all), { standard: 2, agency: 2 });
    assert.deepEqual(countByKind([]), { standard: 0, agency: 0 });
    assert.deepEqual(KIND_FILTERS.map((f) => f.value), ['all', 'standard', 'agency']);
    assert.deepEqual(STATUS_FILTERS.map((f) => f.value), ['all', 'active', 'inactive']);
    assert.equal(MAX_LABEL_BATCH, 200);
  });
});

describe('Etiquetar contas de anúncio (conta de agência)', () => {
  let ctx;
  let fake;
  let admin;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    admin = await loginAdmin(ctx);
  });
  after(() => ctx.stop());

  const labelsOf = async (client) => Object.fromEntries((await client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => [a.id, a.label]));
  const dbLabels = async () => Object.fromEntries((await ctx.db.query('SELECT advertiser_id, label FROM tiktok_advertisers ORDER BY advertiser_id')).rows.map((r) => [r.advertiser_id, r.label]));
  const label = (client, bcId, advertiserIds, value = 'agency') => client.patch(`/api/tiktok/business-centers/${bcId}/advertisers`, { advertiserIds, label: value });

  /** Usuário novo com uma BC própria (contas 9001, 9002, 9003) e o ID dela no sistema. */
  async function userWithBc() {
    await ctx.db.query('DELETE FROM tiktok_business_centers');
    fake.state.validTokens = new Set([GOOD_TOKEN, OTHER_TOKEN]);
    fake.state.bcs = { 111: ['9001', '9002', '9003'], 222: ['9101'] };
    const user = await createUser(ctx, { approve: true });
    const bc = (await user.client.post('/api/tiktok/business-centers', { name: 'Minha BC', bcId: '111', accessToken: GOOD_TOKEN })).json.businessCenter;
    return { ...user, bc };
  }

  it('toda conta nasce comum (sem etiqueta) e o dono pode etiquetá-la', async () => {
    const { client } = await userWithBc();
    assert.deepEqual(await labelsOf(client), { 9001: null, 9002: null, 9003: null });
    const list = (await client.get('/api/tiktok/advertisers')).json.advertisers;
    assert.ok(list.every((a) => a.canLabel === true));
  });

  it('marca como agência, só as contas pedidas; remover a etiqueta volta a ser comum', async () => {
    const { client, bc } = await userWithBc();
    const res = await label(client, bc.id, ['9001', '9003']);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { updated: 2 });
    assert.deepEqual(await labelsOf(client), { 9001: 'agency', 9002: null, 9003: 'agency' });
    assert.deepEqual(await dbLabels(), { 9001: 'agency', 9002: null, 9003: 'agency' });

    assert.equal((await label(client, bc.id, ['9001'], null)).status, 200);
    assert.deepEqual(await labelsOf(client), { 9001: null, 9002: null, 9003: 'agency' });
  });

  it('repetir o mesmo ID no pedido conta uma vez só; repetir a mesma etiqueta é inofensivo', async () => {
    const { client, bc } = await userWithBc();
    assert.deepEqual((await label(client, bc.id, ['9002', '9002', '9002'])).json, { updated: 1 });
    assert.deepEqual((await label(client, bc.id, ['9002'])).json, { updated: 1 });
    assert.equal((await labelsOf(client))['9002'], 'agency');
  });

  it('a etiqueta SOBREVIVE à sincronização; conta nova nasce comum e conta que saiu do TikTok some', async () => {
    const { client, bc } = await userWithBc();
    await label(client, bc.id, ['9001', '9002']);
    fake.state.bcs = { 111: ['9001', '9003', '9004'], 222: ['9101'] }; // 9002 saiu; 9004 é nova
    assert.equal((await client.post(`/api/tiktok/business-centers/${bc.id}/sync`)).status, 200);
    assert.deepEqual(await labelsOf(client), { 9001: 'agency', 9003: null, 9004: null });
    assert.deepEqual(await dbLabels(), { 9001: 'agency', 9003: null, 9004: null });
  });

  it('sincronizar quando o TikTok devolve zero contas apaga as contas (e as etiquetas junto)', async () => {
    const { client, bc } = await userWithBc();
    await label(client, bc.id, ['9001']);
    fake.state.bcs = { 111: [], 222: ['9101'] };
    assert.equal((await client.post(`/api/tiktok/business-centers/${bc.id}/sync`)).status, 200);
    assert.deepEqual(await dbLabels(), {});
  });

  it('a etiqueta também sobrevive à troca do token da BC', async () => {
    const { client, bc } = await userWithBc();
    await label(client, bc.id, ['9002']);
    assert.equal((await client.patch(`/api/tiktok/business-centers/${bc.id}`, { accessToken: OTHER_TOKEN })).status, 200);
    assert.equal((await labelsOf(client))['9002'], 'agency');
  });

  it('a etiqueta é por Business Center: a mesma conta em outra BC não é afetada', async () => {
    const { client, bc } = await userWithBc();
    fake.state.bcs = { 111: ['9001', '9002', '9003'], 222: ['9001'] }; // 9001 também está na BC 222
    const other = (await client.post('/api/tiktok/business-centers', { name: 'Outra BC', bcId: '222', accessToken: GOOD_TOKEN })).json.businessCenter;
    await label(client, bc.id, ['9001']);
    const rows = (await client.get('/api/tiktok/advertisers')).json.advertisers.filter((a) => a.id === '9001');
    assert.deepEqual(rows.map((a) => [a.businessCenterId, a.label]).sort(), [[bc.id, 'agency'], [other.id, null]].sort());
  });

  describe('permissões', () => {
    it('outro usuário não etiqueta (nem descobre) a BC alheia: 404 e nada muda', async () => {
      const { client, bc } = await userWithBc();
      const stranger = await createUser(ctx, { approve: true });
      assert.equal((await label(stranger.client, bc.id, ['9001'])).status, 404);
      assert.equal((await label(stranger.client, 999999, ['9001'])).status, 404);
      assert.deepEqual(await labelsOf(client), { 9001: null, 9002: null, 9003: null });
    });

    it('BC compartilhada: a equipe vê a etiqueta, mas só o admin altera (403 para o usuário)', async () => {
      const { bc } = await userWithBc();
      assert.equal((await admin.patch(`/api/tiktok/business-centers/${bc.id}`, { shared: true })).status, 200);
      const member = await createUser(ctx, { approve: true });
      // o dono da BC é outro usuário; o admin etiqueta como supervisor
      assert.equal((await label(admin, bc.id, ['9002'])).status, 200);
      const seen = (await member.client.get('/api/tiktok/advertisers')).json.advertisers;
      assert.deepEqual(Object.fromEntries(seen.map((a) => [a.id, a.label])), { 9001: null, 9002: 'agency', 9003: null });
      assert.ok(seen.every((a) => a.canLabel === false), 'membro da equipe não pode etiquetar');
      assert.equal((await label(member.client, bc.id, ['9001'])).status, 403);
      assert.equal((await labelsOf(member.client))['9001'], null);
    });

    it('o admin vê canLabel em tudo e etiqueta a BC de qualquer usuário', async () => {
      const { bc } = await userWithBc();
      assert.equal((await label(admin, bc.id, ['9003'])).status, 200);
      assert.ok((await admin.get('/api/tiktok/advertisers')).json.advertisers.every((a) => a.canLabel === true));
    });

    it('exige sessão e token CSRF', async () => {
      const { client, bc } = await userWithBc();
      const anon = ctx.client();
      assert.equal((await label(anon, bc.id, ['9001'])).status, 401);
      const res = await client.patch(`/api/tiktok/business-centers/${bc.id}/advertisers`, { advertiserIds: ['9001'], label: 'agency' }, { withCsrf: false });
      assert.equal(res.status, 403);
      assert.equal((await labelsOf(client))['9001'], null);
    });
  });

  describe('validação do pedido (nada é gravado quando inválido)', () => {
    it('rejeita etiqueta desconhecida ou ausente', async () => {
      const { client, bc } = await userWithBc();
      for (const bad of ['vip', '', 'Agency', 'toString', 1, true, {}, ['agency']]) assert.equal((await label(client, bc.id, ['9001'], bad)).status, 400, JSON.stringify(bad));
      const missing = await client.patch(`/api/tiktok/business-centers/${bc.id}/advertisers`, { advertiserIds: ['9001'] });
      assert.equal(missing.status, 400, 'sem o campo "label" não vale como remover');
      assert.deepEqual(await labelsOf(client), { 9001: null, 9002: null, 9003: null });
    });

    it('rejeita lista inválida: vazia, grande demais, não-lista e IDs fora do padrão numérico', async () => {
      const { client, bc } = await userWithBc();
      const tooMany = Array.from({ length: MAX_LABEL_BATCH + 1 }, (_, i) => String(1000 + i));
      for (const bad of [[], tooMany, '9001', null, { 0: '9001' }, [9001], ['abc'], ['9001; DROP TABLE users'], ["9001' OR '1'='1"], [''], ['9'.repeat(25)], [null]]) {
        assert.equal((await label(client, bc.id, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
      }
      assert.equal((await client.patch(`/api/tiktok/business-centers/${bc.id}/advertisers`, [])).status, 400, 'corpo que não é objeto');
      assert.equal((await client.patch(`/api/tiktok/business-centers/abc/advertisers`, { advertiserIds: ['9001'], label: 'agency' })).status, 400, 'ID de BC inválido');
      assert.deepEqual(await labelsOf(client), { 9001: null, 9002: null, 9003: null });
    });

    it('aceita o tamanho máximo do lote', async () => {
      const { client, bc } = await userWithBc();
      const ids = ['9001', ...Array.from({ length: MAX_LABEL_BATCH - 1 }, (_, i) => String(8000 + i))];
      assert.equal((await label(client, bc.id, ids)).status, 404, 'passou da validação; falha só porque os outros IDs não existem');
    });

    it('conta que não é desta BC derruba o pedido INTEIRO (nada é alterado pela metade)', async () => {
      const { client, bc } = await userWithBc();
      const res = await label(client, bc.id, ['9001', '9999']);
      assert.equal(res.status, 404);
      assert.deepEqual(await labelsOf(client), { 9001: null, 9002: null, 9003: null });
    });
  });

  it('a restrição do banco recusa etiqueta inválida mesmo fora da API', async () => {
    await userWithBc();
    await assert.rejects(ctx.db.query("UPDATE tiktok_advertisers SET label = 'vip' WHERE advertiser_id = '9001'"), (err) => err.code === '23514');
    await assert.rejects(ctx.db.query("UPDATE tiktok_advertisers SET label = '' WHERE advertiser_id = '9001'"), (err) => err.code === '23514');
  });
});
