import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { all, createUser, one, run, startTestServer } from './helpers.js';
import { pngBytes, uploadCreative } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, creativesRead: 5000, creativesWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `fd${++counter}@example.com`;

describe('Pastas da biblioteca de criativos', () => {
  let ctx;
  let mailer;
  before(async () => {
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { mail: MAIL_CONFIG }, mailer });
  });
  after(() => ctx.stop());

  const user = () => createUser(ctx, { approve: true, email: emailOf() });
  const folder = async (u, name) => (await u.client.post('/api/creatives/folders', { name })).json.folder;
  const upload = async (u, extra = {}) => {
    const res = await uploadCreative(u.client, { type: 'png', ...extra });
    assert.equal(res.status, 201, res.text);
    return res.json.creative;
  };
  const listIn = async (u, query) => (await u.client.get(`/api/creatives?${query}`)).json;

  it('cria, lista (com contagem, ordem alfabética sem diferenciar maiúsculas) e mostra os totais', async () => {
    const u = await user();
    const b = await folder(u, 'oferta B');
    const a = await folder(u, '  Oferta   A ');
    assert.equal(a.name, 'Oferta A', 'espaços normalizados');
    assert.deepEqual(Object.keys(a).sort(), ['count', 'id', 'name']);
    await upload(u);
    const filed = await upload(u, { type: 'jpg' });
    await u.client.patch(`/api/creatives/${filed.id}`, { folderId: b.id });
    const res = await u.client.get('/api/creatives/folders');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.folders.map((f) => [f.name, f.count]), [['Oferta A', 0], ['oferta B', 1]]);
    assert.deepEqual([res.json.total, res.json.unfiledCount], [2, 1]);
  });

  it('valida o nome: vazio, grande demais, caracteres de controle e tipo errado; nome repetido (sem diferenciar maiúsculas) é 409', async () => {
    const u = await user();
    for (const name of ['', '   ', 'x'.repeat(61), 'linha\u0001quebrada', 5, null, undefined, { a: 1 }]) assert.equal((await u.client.post('/api/creatives/folders', { name })).status, 400, JSON.stringify(name));
    assert.equal((await u.client.post('/api/creatives/folders', [])).status, 400);
    assert.equal((await u.client.post('/api/creatives/folders', { name: 'x'.repeat(60) })).status, 201, '60 caracteres é o limite');
    await folder(u, 'Oferta Verão');
    const dup = await u.client.post('/api/creatives/folders', { name: 'OFERTA verão' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'folder_exists');
    const other = await user();
    assert.equal((await other.client.post('/api/creatives/folders', { name: 'Oferta Verão' })).status, 201, 'cada usuário tem os próprios nomes');
  });

  it('o nome da pasta é guardado e devolvido como TEXTO (HTML não é interpretado)', async () => {
    const u = await user();
    const f = await folder(u, '<img src=x onerror=alert(1)>');
    assert.equal(f.name, '<img src=x onerror=alert(1)>');
    assert.equal((await u.client.get('/api/creatives/folders')).json.folders[0].name, '<img src=x onerror=alert(1)>');
  });

  it('no máximo 100 pastas por usuário', async () => {
    const u = await user();
    const id = (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [u.email.toLowerCase()])).id;
    await run(ctx.db, "INSERT INTO creative_folders (user_id, name) SELECT $1, 'Pasta ' || g FROM generate_series(1, 100) g", [id]);
    const res = await u.client.post('/api/creatives/folders', { name: 'Pasta 101' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'too_many_folders');
  });

  it('envia direto para uma pasta (?folderId=); pasta de outra pessoa ou inexistente = 404 SEM gravar nada; pasta inválida = 400', async () => {
    const u = await user();
    const other = await user();
    const mine = await folder(u, 'Minha oferta');
    const theirs = await folder(other, 'Deles');
    const ok = await upload(u, { type: 'png' });
    assert.equal(ok.folderId, null, 'sem pasta por padrão');
    const res = await u.client.request('POST', `/api/creatives?filename=a.png&folderId=${mine.id}`, { raw: pngBytes(), headers: { 'content-type': 'image/png' } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.creative.folderId, mine.id);
    const countBefore = (await one(ctx.db, 'SELECT COUNT(*)::int c FROM creatives')).c;
    for (const bad of [theirs.id, 999999]) {
      const denied = await u.client.request('POST', `/api/creatives?filename=b.png&folderId=${bad}`, { raw: pngBytes(), headers: { 'content-type': 'image/png' } });
      assert.equal(denied.status, 404, `pasta ${bad}`);
    }
    for (const bad of ['abc', '-1', '1e3', 'none', '1;2']) {
      const denied = await u.client.request('POST', `/api/creatives?filename=c.png&folderId=${encodeURIComponent(bad)}`, { raw: pngBytes(), headers: { 'content-type': 'image/png' } });
      assert.equal(denied.status, 400, bad);
    }
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM creatives')).c, countBefore, 'nada foi gravado');
  });

  it('filtra a lista por pasta, por "sem pasta" e junto com tipo e busca; filtro inválido = 400', async () => {
    const u = await user();
    const f = await folder(u, 'Oferta X');
    const inside = await upload(u, { name: 'dentro' });
    await upload(u, { name: 'fora' });
    const video = await upload(u, { type: 'mp4', name: 'video dentro' });
    await u.client.post('/api/creatives/move', { ids: [inside.id, video.id], folderId: f.id });
    assert.deepEqual((await listIn(u, `folderId=${f.id}`)).creatives.map((c) => c.name).sort(), ['dentro', 'video dentro']);
    assert.deepEqual((await listIn(u, 'folderId=none')).creatives.map((c) => c.name), ['fora']);
    assert.deepEqual((await listIn(u, `folderId=${f.id}&kind=video`)).creatives.map((c) => c.name), ['video dentro']);
    assert.deepEqual((await listIn(u, `folderId=${f.id}&q=video`)).creatives.map((c) => c.name), ['video dentro']);
    assert.equal((await listIn(u, `folderId=${f.id}`)).total, 2, 'o total respeita o filtro');
    assert.equal((await listIn(u, '')).total, 3);
    for (const bad of ['abc', '-3', '1e3', "1' OR '1'='1"]) assert.equal((await u.client.get(`/api/creatives?folderId=${encodeURIComponent(bad)}`)).status, 400, bad);
    const other = await user();
    assert.deepEqual((await listIn(other, `folderId=${f.id}`)).creatives, [], 'a pasta de outro usuário não mostra nada');
  });

  it('muda um criativo de pasta (e tira da pasta); junto com o nome; pasta inexistente não deixa mudar nem o nome', async () => {
    const u = await user();
    const f = await folder(u, 'Oferta Y');
    const c = await upload(u, { name: 'original' });
    const moved = await u.client.patch(`/api/creatives/${c.id}`, { folderId: f.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.creative.folderId, f.id);
    assert.equal(moved.json.creative.name, 'original');
    const both = await u.client.patch(`/api/creatives/${c.id}`, { name: 'novo nome', folderId: null });
    assert.deepEqual([both.json.creative.name, both.json.creative.folderId], ['novo nome', null]);
    const missing = await u.client.patch(`/api/creatives/${c.id}`, { name: 'não deve mudar', folderId: 999999 });
    assert.equal(missing.status, 404);
    assert.equal((await u.client.get(`/api/creatives/${c.id}`)).json.creative.name, 'novo nome');
    assert.equal((await u.client.patch(`/api/creatives/${c.id}`, {})).status, 400, 'nada para atualizar');
    assert.equal((await u.client.patch(`/api/creatives/${c.id}`, { folderId: 'abc' })).status, 400);
    assert.equal((await u.client.patch(`/api/creatives/${c.id}`, { name: 'só renomear' })).json.creative.name, 'só renomear');
    const other = await user();
    assert.equal((await other.client.patch(`/api/creatives/${c.id}`, { folderId: null })).status, 404, 'criativo de outra pessoa');
  });

  it('move vários de uma vez: TUDO OU NADA (ID de outra pessoa ou pasta alheia = 404 e nada muda)', async () => {
    const u = await user();
    const other = await user();
    const f = await folder(u, 'Oferta Z');
    const theirs = await folder(other, 'Pasta alheia');
    const [a, b] = [await upload(u, { name: 'a' }), await upload(u, { name: 'b' })];
    const foreign = await upload(other, { name: 'de outro' });
    const mixed = await u.client.post('/api/creatives/move', { ids: [a.id, foreign.id], folderId: f.id });
    assert.equal(mixed.status, 404);
    assert.equal((await u.client.get(`/api/creatives/${a.id}`)).json.creative.folderId, null, 'o primeiro NÃO foi movido');
    assert.equal((await u.client.post('/api/creatives/move', { ids: [a.id], folderId: theirs.id })).status, 404, 'pasta de outra pessoa');
    assert.equal((await u.client.post('/api/creatives/move', { ids: [a.id], folderId: 999999 })).status, 404);
    assert.equal((await other.client.get(`/api/creatives/${foreign.id}`)).json.creative.folderId, null, 'o criativo do outro não foi tocado');
    const ok = await u.client.post('/api/creatives/move', { ids: [a.id, b.id, a.id], folderId: f.id });
    assert.deepEqual(ok.json, { moved: 2 }, 'repetidos contam uma vez só');
    assert.equal((await u.client.get('/api/creatives/folders')).json.folders[0].count, 2);
    assert.deepEqual((await u.client.post('/api/creatives/move', { ids: [a.id, b.id], folderId: null })).json, { moved: 2 });
    assert.equal((await u.client.get('/api/creatives/folders')).json.unfiledCount, 2);
  });

  it('valida o corpo de "mover": lista vazia/grande, IDs e pasta inválidos', async () => {
    const u = await user();
    const bad = [{}, { ids: [] }, { ids: 'x', folderId: null }, { ids: [1], folderId: 'a' }, { ids: [1], folderId: 1.5 }, { ids: [0], folderId: null }, { ids: ['a'], folderId: null }, { ids: [1.5], folderId: null }, { ids: Array.from({ length: 101 }, (_, i) => i + 1), folderId: null }, { ids: [1] }];
    for (const body of bad) assert.equal((await u.client.post('/api/creatives/move', body)).status, 400, JSON.stringify(body).slice(0, 50));
    assert.equal((await u.client.post('/api/creatives/move', [])).status, 400);
  });

  it('renomeia a pasta (repetido = 409; de outra pessoa = 404)', async () => {
    const u = await user();
    const other = await user();
    const a = await folder(u, 'Antiga');
    await folder(u, 'Existente');
    assert.deepEqual((await u.client.patch(`/api/creatives/folders/${a.id}`, { name: 'Nova' })).json.folder, { id: a.id, name: 'Nova' });
    assert.equal((await u.client.patch(`/api/creatives/folders/${a.id}`, { name: 'existente' })).status, 409);
    assert.equal((await u.client.patch(`/api/creatives/folders/${a.id}`, { name: 'NOVA' })).status, 200, 'trocar só maiúsculas da própria pasta é permitido');
    assert.equal((await u.client.patch(`/api/creatives/folders/${a.id}`, { name: '' })).status, 400);
    assert.equal((await other.client.patch(`/api/creatives/folders/${a.id}`, { name: 'Roubada' })).status, 404);
    assert.equal((await u.client.patch('/api/creatives/folders/999999', { name: 'x' })).status, 404);
    assert.equal((await u.client.patch('/api/creatives/folders/abc', { name: 'x' })).status, 400);
  });

  it('apagar a pasta NÃO apaga os criativos: eles voltam para "sem pasta"', async () => {
    const u = await user();
    const other = await user();
    const f = await folder(u, 'Vai sumir');
    const c1 = await upload(u, { name: 'um' });
    const c2 = await upload(u, { name: 'dois' });
    await u.client.post('/api/creatives/move', { ids: [c1.id, c2.id], folderId: f.id });
    assert.equal((await other.client.delete(`/api/creatives/folders/${f.id}`)).status, 404, 'pasta de outra pessoa');
    const res = await u.client.delete(`/api/creatives/folders/${f.id}`);
    assert.deepEqual([res.status, res.json], [200, { moved: 2 }]);
    assert.deepEqual((await u.client.get('/api/creatives/folders')).json.folders, []);
    const list = (await listIn(u, 'folderId=none')).creatives;
    assert.deepEqual(list.map((c) => [c.name, c.folderId]).sort(), [['dois', null], ['um', null]]);
    assert.equal((await u.client.delete(`/api/creatives/folders/${f.id}`)).status, 404);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM creatives WHERE id = ANY($1::int[])', [[c1.id, c2.id]])).c, 2, 'os arquivos continuam no banco');
  });

  it('excluir um criativo atualiza a contagem da pasta; o banco impede nome repetido e nome vazio', async () => {
    const u = await user();
    const f = await folder(u, 'Contagem');
    const c = await upload(u);
    await u.client.patch(`/api/creatives/${c.id}`, { folderId: f.id });
    assert.equal((await u.client.get('/api/creatives/folders')).json.folders[0].count, 1);
    assert.equal((await u.client.delete(`/api/creatives/${c.id}`)).status, 204);
    assert.equal((await u.client.get('/api/creatives/folders')).json.folders[0].count, 0);
    const owner = (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [u.email.toLowerCase()])).id;
    await assert.rejects(run(ctx.db, "INSERT INTO creative_folders (user_id, name) VALUES ($1, 'CONTAGEM')", [owner]), (e) => e.code === '23505');
    await assert.rejects(run(ctx.db, "INSERT INTO creative_folders (user_id, name) VALUES ($1, '')", [owner]), (e) => e.code === '23514');
  });

  it('isolamento: o usuário só enxerga as próprias pastas; IDs de pastas alheias nunca funcionam', async () => {
    const a = await user();
    const b = await user();
    const fa = await folder(a, 'Só da A');
    assert.deepEqual((await b.client.get('/api/creatives/folders')).json, { folders: [], total: 0, unfiledCount: 0 });
    const cb = await upload(b);
    assert.equal((await b.client.patch(`/api/creatives/${cb.id}`, { folderId: fa.id })).status, 404);
    assert.equal((await b.client.get(`/api/creatives/${cb.id}`)).json.creative.folderId, null);
    const rows = await all(ctx.db, 'SELECT folder_id FROM creatives WHERE id = $1', [cb.id]);
    assert.equal(rows[0].folder_id, null);
  });

  it('permissões: sem login 401; colaborador de "Campanhas" só lê as pastas; com "Criativos" faz tudo', async () => {
    const owner = await user();
    const f = await folder(owner, 'Da conta');
    assert.equal((await ctx.client().get('/api/creatives/folders')).status, 401);
    async function collaborator(areas) {
      const email = emailOf();
      assert.equal((await owner.client.post('/api/team/invites', { email, name: 'Maria Colab', areas })).status, 201);
      const client = ctx.client();
      const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
      client.csrf = accepted.json.csrfToken;
      return client;
    }
    const campaigns = await collaborator(['campaigns']);
    assert.equal((await campaigns.get('/api/creatives/folders')).status, 200, 'quem publica campanhas precisa ver as pastas para escolher criativos');
    assert.equal((await campaigns.post('/api/creatives/folders', { name: 'Não pode' })).status, 403);
    assert.equal((await campaigns.patch(`/api/creatives/folders/${f.id}`, { name: 'x' })).status, 403);
    assert.equal((await campaigns.delete(`/api/creatives/folders/${f.id}`)).status, 403);
    assert.equal((await campaigns.post('/api/creatives/move', { ids: [1], folderId: null })).status, 403);
    const creatives = await collaborator(['creatives']);
    assert.equal((await creatives.post('/api/creatives/folders', { name: 'Da equipe' })).status, 201);
    assert.deepEqual((await owner.client.get('/api/creatives/folders')).json.folders.map((x) => x.name), ['Da conta', 'Da equipe'], 'a pasta é do espaço do dono');
    const reports = await collaborator(['reports']);
    assert.equal((await reports.get('/api/creatives/folders')).status, 403);
  });
});
