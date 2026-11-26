import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { createUser, one, startTestServer } from './helpers.js';
import { mp4Bytes, pngBytes, uploadCreative } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, creativesRead: 5000, creativesWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `ex${++counter}@example.com`;

describe('Gerenciador de arquivos dos criativos: ordenação, tamanho das pastas e exclusão em lote', () => {
  let ctx;
  let mailer;
  before(async () => {
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { mail: MAIL_CONFIG }, mailer });
  });
  after(() => ctx.stop());

  const user = () => createUser(ctx, { approve: true, email: emailOf() });
  const upload = async (u, extra = {}) => {
    const res = await uploadCreative(u.client, { type: 'png', ...extra });
    assert.equal(res.status, 201, res.text);
    return res.json.creative;
  };
  const names = async (u, query = '') => (await u.client.get(`/api/creatives?${query}`)).json.creatives.map((c) => c.name);

  describe('ordenação da lista', () => {
    it('padrão: mais recentes primeiro; ordena por nome, tamanho e tipo nos dois sentidos', async () => {
      const u = await user();
      await upload(u, { name: 'banana', bytes: pngBytes(1, 300) });
      await upload(u, { name: 'Abacate', bytes: pngBytes(2, 100) });
      await upload(u, { name: 'cereja', type: 'mp4', bytes: mp4Bytes(3, 600) });
      assert.deepEqual(await names(u), ['cereja', 'Abacate', 'banana'], 'padrão = mais novo primeiro');
      assert.deepEqual(await names(u, 'sort=date&dir=asc'), ['banana', 'Abacate', 'cereja']);
      assert.deepEqual(await names(u, 'sort=name&dir=asc'), ['Abacate', 'banana', 'cereja'], 'nome sem diferenciar maiúsculas');
      assert.deepEqual(await names(u, 'sort=name&dir=desc'), ['cereja', 'banana', 'Abacate']);
      assert.deepEqual(await names(u, 'sort=size&dir=asc'), ['Abacate', 'banana', 'cereja'], 'do menor para o maior');
      assert.deepEqual(await names(u, 'sort=size&dir=desc'), ['cereja', 'banana', 'Abacate']);
      const byKind = await names(u, 'sort=kind&dir=asc');
      assert.equal(byKind.at(-1), 'cereja', 'imagem vem antes de vídeo em ordem crescente');
    });

    it('arquivo que só existe no TikTok (sem tamanho) fica no fim, nos dois sentidos', async () => {
      const u = await user();
      await upload(u, { name: 'pequeno', bytes: pngBytes(11, 50) });
      await upload(u, { name: 'grande', bytes: pngBytes(12, 900) });
      const owner = await one(ctx.db, 'SELECT id FROM users WHERE email = $1', [u.email]);
      await ctx.db.query("INSERT INTO creatives (user_id, name, kind, source) VALUES ($1, 'so no tiktok', 'video', 'tiktok')", [owner.id]);
      assert.equal((await names(u, 'sort=size&dir=asc')).at(-1), 'so no tiktok');
      assert.equal((await names(u, 'sort=size&dir=desc')).at(-1), 'so no tiktok');
      assert.deepEqual((await names(u, 'sort=size&dir=desc')).slice(0, 2), ['grande', 'pequeno']);
    });

    it('a paginação continua correta com ordenação (sem repetir nem perder itens)', async () => {
      const u = await user();
      for (let i = 0; i < 5; i += 1) await upload(u, { name: `item ${i}`, bytes: pngBytes(100 + i, 40 + i) });
      const first = await names(u, 'sort=name&dir=asc&limit=2&offset=0');
      const second = await names(u, 'sort=name&dir=asc&limit=2&offset=2');
      const third = await names(u, 'sort=name&dir=asc&limit=2&offset=4');
      assert.deepEqual([...first, ...second, ...third], ['item 0', 'item 1', 'item 2', 'item 3', 'item 4']);
    });

    it('valores inválidos viram 400 (nada de SQL montado com o que o cliente mandou)', async () => {
      const u = await user();
      for (const query of ['sort=nome', 'sort=', 'sort=created_at', "sort=name;DROP TABLE creatives", 'sort=name&dir=up', 'dir=', 'sort=name&sort=size', 'dir=ASC']) {
        const res = await u.client.get(`/api/creatives?${query}`);
        assert.equal(res.status, 400, query);
      }
      assert.equal((await u.client.get('/api/creatives?sort=name')).status, 200, 'sort sem dir usa o padrão (desc)');
      assert.equal((await u.client.get('/api/creatives?dir=asc')).status, 200, 'dir sem sort ordena por data');
    });

    it('combina com pasta, tipo e busca', async () => {
      const u = await user();
      const f = (await u.client.post('/api/creatives/folders', { name: 'Oferta' })).json.folder;
      const a = await upload(u, { name: 'zeta' });
      const b = await upload(u, { name: 'alfa' });
      await upload(u, { name: 'fora' });
      await u.client.post('/api/creatives/move', { ids: [a.id, b.id], folderId: f.id });
      assert.deepEqual(await names(u, `folderId=${f.id}&sort=name&dir=asc`), ['alfa', 'zeta']);
      assert.deepEqual(await names(u, `folderId=${f.id}&sort=name&dir=desc&q=a`), ['zeta', 'alfa']);
      assert.deepEqual(await names(u, 'folderId=none&sort=name&dir=asc'), ['fora']);
    });
  });

  describe('tamanho de cada pasta', () => {
    it('a lista de pastas traz a soma dos tamanhos (0 para pasta vazia) e só conta o que é da própria pessoa', async () => {
      const u = await user();
      const other = await user();
      const full = (await u.client.post('/api/creatives/folders', { name: 'Cheia' })).json.folder;
      const empty = (await u.client.post('/api/creatives/folders', { name: 'Vazia' })).json.folder;
      const a = await upload(u, { bytes: pngBytes(21, 100) });
      const b = await upload(u, { bytes: pngBytes(22, 200) });
      await upload(other, { bytes: pngBytes(23, 5000) });
      await u.client.post('/api/creatives/move', { ids: [a.id, b.id], folderId: full.id });
      const folders = (await u.client.get('/api/creatives/folders')).json.folders;
      const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
      assert.equal(byName.Cheia.sizeBytes, a.sizeBytes + b.sizeBytes);
      assert.equal(byName.Cheia.count, 2);
      assert.equal(byName.Vazia.sizeBytes, 0);
      assert.equal(byName.Vazia.id, empty.id);
    });
  });

  describe('exclusão em lote (POST /api/creatives/delete)', () => {
    it('exclui vários de uma vez, apaga os arquivos do disco e atualiza os totais', async () => {
      const u = await user();
      const items = [await upload(u), await upload(u), await upload(u)];
      const keys = [];
      for (const c of items) keys.push((await one(ctx.db, 'SELECT storage_key FROM creatives WHERE id = $1', [c.id])).storage_key);
      for (const key of keys) assert.ok(fs.existsSync(path.join(ctx.creativesDir, key)));
      const res = await u.client.post('/api/creatives/delete', { ids: [items[0].id, items[1].id, items[0].id] });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { removed: 2, failed: [] }, 'repetidos contam uma vez só');
      assert.equal(fs.existsSync(path.join(ctx.creativesDir, keys[0])), false);
      assert.equal(fs.existsSync(path.join(ctx.creativesDir, keys[1])), false);
      assert.ok(fs.existsSync(path.join(ctx.creativesDir, keys[2])), 'o que não foi pedido continua');
      const left = (await u.client.get('/api/creatives')).json;
      assert.equal(left.total, 1);
      assert.equal((await u.client.get('/api/creatives/folders')).json.total, 1);
    });

    it('um criativo usado em rascunho NÃO sai, mas os outros saem; a resposta explica quem ficou', async () => {
      const u = await user();
      const used = await upload(u, { type: 'mp4', name: 'em uso' });
      const free = await upload(u, { type: 'mp4', name: 'livre' });
      await u.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name: 'Rascunho Lote' }, ad: { videoCreativeId: used.id } }) });
      const res = await u.client.post('/api/creatives/delete', { ids: [used.id, free.id] });
      assert.equal(res.status, 200);
      assert.equal(res.json.removed, 1);
      assert.equal(res.json.failed.length, 1);
      assert.equal(res.json.failed[0].id, used.id);
      assert.match(res.json.failed[0].message, /Rascunho Lote/);
      assert.equal((await u.client.get(`/api/creatives/${used.id}`)).status, 200);
      assert.equal((await u.client.get(`/api/creatives/${free.id}`)).status, 404);
    });

    it('ID de outra pessoa ou inexistente não é apagado nem revela nada: vira "não encontrado" e o resto segue', async () => {
      const u = await user();
      const other = await user();
      const mine = await upload(u);
      const theirs = await upload(other);
      const res = await u.client.post('/api/creatives/delete', { ids: [theirs.id, mine.id, 999999] });
      assert.equal(res.status, 200);
      assert.equal(res.json.removed, 1);
      assert.deepEqual(res.json.failed.map((f) => f.id).sort(), [theirs.id, 999999].sort());
      assert.ok(res.json.failed.every((f) => f.message === 'Criativo não encontrado.'), 'mesma mensagem para alheio e inexistente');
      assert.equal((await other.client.get(`/api/creatives/${theirs.id}`)).status, 200, 'o criativo do outro continua');
    });

    it('valida o corpo: lista de 1 a 100 IDs inteiros positivos', async () => {
      const u = await user();
      for (const body of [{}, { ids: [] }, { ids: 'abc' }, { ids: [1.5] }, { ids: ['x'] }, { ids: [-1] }, { ids: [null] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, [], null]) {
        assert.equal((await u.client.post('/api/creatives/delete', body)).status, 400, JSON.stringify(body)?.slice(0, 60));
      }
    });

    it('exige login, CSRF e a área Criativos (quem só publica campanhas não exclui)', async () => {
      const owner = await user();
      const c = await upload(owner);
      assert.equal((await ctx.client().post('/api/creatives/delete', { ids: [c.id] })).status, 401);
      const noCsrf = await owner.client.request('POST', '/api/creatives/delete', { json: { ids: [c.id] }, withCsrf: false });
      assert.equal(noCsrf.status, 403);
      const email = emailOf();
      assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas: ['campaigns'] })).status, 201);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      assert.equal((await client.post('/api/creatives/delete', { ids: [c.id] })).status, 403);
      assert.equal((await owner.client.get(`/api/creatives/${c.id}`)).status, 200, 'nada foi apagado');
      assert.equal((await owner.client.post('/api/creatives/delete', { ids: [c.id] })).json.removed, 1);
    });
  });
});
