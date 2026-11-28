import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MAX_FOLDER_DEPTH } from '../shared/creative-folders.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { all, createUser, one, run, startTestServer } from './helpers.js';
import { uploadCreative } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, creativesRead: 5000, creativesWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `sf${++counter}@example.com`;

describe('Pastas dentro de pastas (subpastas) da biblioteca de criativos', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS, config: { mail: MAIL_CONFIG }, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  const user = () => createUser(ctx, { approve: true, email: emailOf() });
  const create = (u, name, parentId) => u.client.post('/api/creatives/folders', parentId === undefined ? { name } : { name, parentId });
  const folder = async (u, name, parentId) => {
    const res = await create(u, name, parentId);
    assert.equal(res.status, 201, res.text);
    return res.json.folder;
  };
  const folders = async (u) => (await u.client.get('/api/creatives/folders')).json;
  const upload = async (u, extra = {}) => {
    const res = await uploadCreative(u.client, { type: 'png', ...extra });
    assert.equal(res.status, 201, res.text);
    return res.json.creative;
  };
  const move = (u, ids, folderId) => u.client.post('/api/creatives/move', { ids, folderId });

  it('a migração criou a coluna do pai e trocou o índice de nome único (agora por pasta pai)', async () => {
    const columns = (await all(ctx.db, "SELECT column_name FROM information_schema.columns WHERE table_name = 'creative_folders'")).map((r) => r.column_name);
    assert.ok(columns.includes('parent_id'));
    const indexes = (await all(ctx.db, "SELECT indexname FROM pg_indexes WHERE tablename = 'creative_folders'")).map((r) => r.indexname);
    assert.ok(indexes.includes('creative_folders_sibling_name_key'));
    assert.ok(!indexes.includes('creative_folders_user_name_key'), 'o índice antigo (nome único no usuário todo) saiu');
  });

  it('cria uma subpasta: a resposta e a lista trazem o pai; pasta de nível mais alto continua com pai nulo', async () => {
    const u = await user();
    const oferta = await folder(u, 'Oferta A');
    const sub = await folder(u, 'Verão', oferta.id);
    assert.deepEqual([oferta.parentId, sub.parentId, sub.count], [null, oferta.id, 0]);
    const list = await folders(u);
    assert.deepEqual(list.folders.map((f) => [f.name, f.parentId]), [['Oferta A', null], ['Verão', oferta.id]]);
    assert.equal((await create(u, 'Raiz', null)).json.folder.parentId, null, 'parentId nulo = nível mais alto');
  });

  it('o nome é único só entre IRMÃS (sem diferenciar maiúsculas); em lugares diferentes pode repetir', async () => {
    const u = await user();
    const a = await folder(u, 'Oferta A');
    const b = await folder(u, 'Oferta B');
    await folder(u, 'Vídeos', a.id);
    await folder(u, 'Vídeos', b.id); // outro pai: pode
    await folder(u, 'Vídeos'); // nível mais alto: pode
    const dup = await create(u, 'VÍDEOS', a.id);
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'folder_exists');
    assert.match(dup.json.error.message, /dentro de "Oferta A"/);
    const dupRoot = await create(u, 'vídeos');
    assert.equal(dupRoot.status, 409, 'duas de nível mais alto com o mesmo nome continuam proibidas');
    assert.doesNotMatch(dupRoot.json.error.message, /dentro de/);
  });

  it('pai inválido: não numérico = 400; inexistente ou de outra pessoa = 404 (nada é criado)', async () => {
    const u = await user();
    const other = await user();
    const theirs = await folder(other, 'Deles');
    const foldersBefore = (await folders(u)).folders.length;
    for (const parentId of ['abc', '1', 1.5, [], {}, true, -1, 0, 1e10]) {
      const res = await create(u, 'Filha', parentId);
      assert.ok([400, 404].includes(res.status), `${JSON.stringify(parentId)} -> ${res.status}`);
    }
    assert.equal((await create(u, 'Filha', 999999)).status, 404);
    assert.equal((await create(u, 'Filha', theirs.id)).status, 404, 'a pasta de outra pessoa não serve de pai');
    assert.equal((await folders(u)).folders.length, foldersBefore, 'nada foi criado');
    assert.equal((await folders(other)).folders.length, 1, 'a outra pessoa não ganhou subpasta');
  });

  it(`no máximo ${MAX_FOLDER_DEPTH} níveis; a pasta de baixo recusa filhas (409) e as outras seguem livres`, async () => {
    const u = await user();
    let parent;
    for (let level = 1; level <= MAX_FOLDER_DEPTH; level += 1) parent = await folder(u, `Nível ${level}`, parent?.id);
    const tooDeep = await create(u, 'Nível 6', parent.id);
    assert.equal(tooDeep.status, 409);
    assert.equal(tooDeep.json.error.code, 'folder_too_deep');
    assert.match(tooDeep.json.error.message, /até 5 níveis/);
    const list = (await folders(u)).folders;
    assert.equal(list.length, MAX_FOLDER_DEPTH);
    assert.equal((await create(u, 'Outra raiz')).status, 201);
    assert.equal((await create(u, 'Irmã do último', list[MAX_FOLDER_DEPTH - 2].id)).status, 201, 'o penúltimo nível ainda aceita');
  });

  it('o limite de 100 pastas conta as subpastas também', async () => {
    const u = await user();
    const root = await folder(u, 'Raiz');
    const id = (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [u.email.toLowerCase()])).id;
    await run(ctx.db, "INSERT INTO creative_folders (user_id, name, parent_id) SELECT $1, 'Sub ' || g, $2 FROM generate_series(1, 99) g", [id, root.id]);
    const res = await create(u, 'Sub 100', root.id);
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'too_many_folders');
  });

  it('envia e move criativos para uma subpasta; a lista por pasta mostra só os arquivos DIRETOS dela', async () => {
    const u = await user();
    const a = await folder(u, 'Oferta A');
    const sub = await folder(u, 'Verão', a.id);
    const inA = await upload(u, { name: 'na A' });
    const inSub = await upload(u, { name: 'na sub' });
    assert.equal((await move(u, [inA.id], a.id)).status, 200);
    assert.equal((await move(u, [inSub.id], sub.id)).status, 200);
    const direct = (id) => u.client.get(`/api/creatives?folderId=${id}`).then((r) => r.json.creatives.map((c) => c.name));
    assert.deepEqual(await direct(a.id), ['na A']);
    assert.deepEqual(await direct(sub.id), ['na sub']);
    assert.equal((await u.client.get('/api/creatives')).json.total, 2, '"todos os arquivos" mostra tudo');
    const direct2 = await u.client.request('POST', `/api/creatives?filename=x.png&folderId=${sub.id}`, { raw: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x'.repeat(40))]), headers: { 'content-type': 'image/png' } });
    assert.equal(direct2.status, 201, 'enviar direto para a subpasta');
    assert.equal(direct2.json.creative.folderId, sub.id);
    const counts = Object.fromEntries((await folders(u)).folders.map((f) => [f.name, f.count]));
    assert.deepEqual(counts, { 'Oferta A': 1, 'Verão': 2 }, 'a contagem de cada pasta é só dos arquivos diretos');
  });

  it('apagar a pasta apaga as subpastas (qualquer nível), mas NENHUM criativo: todos voltam para "sem pasta"', async () => {
    const u = await user();
    const other = await user();
    const keepOther = await folder(other, 'Da outra pessoa');
    const a = await folder(u, 'Oferta A');
    const b = await folder(u, 'Verão', a.id);
    const c = await folder(u, 'Vídeos', b.id);
    const sibling = await folder(u, 'Oferta B');
    const files = [await upload(u, { name: 'a' }), await upload(u, { name: 'b' }), await upload(u, { name: 'c' }), await upload(u, { name: 'irmã' })];
    for (const [file, target] of [[files[0], a], [files[1], b], [files[2], c], [files[3], sibling]]) await move(u, [file.id], target.id);
    const res = await u.client.delete(`/api/creatives/folders/${a.id}`);
    assert.deepEqual([res.status, res.json], [200, { moved: 3, subfolders: 2 }]);
    assert.deepEqual((await folders(u)).folders.map((f) => f.name), ['Oferta B'], 'a pasta e as subpastas sumiram; a irmã ficou');
    const rows = await all(ctx.db, 'SELECT name, folder_id FROM creatives WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1) ORDER BY name', [u.email.toLowerCase()]);
    assert.deepEqual(rows.map((r) => [r.name, r.folder_id === null]), [['a', true], ['b', true], ['c', true], ['irmã', false]], 'os 3 criativos continuam na biblioteca, sem pasta');
    assert.equal((await folders(other)).folders[0].id, keepOther.id, 'nada da outra pessoa mudou');
    assert.equal((await u.client.delete(`/api/creatives/folders/${a.id}`)).status, 404, 'apagar de novo = 404');
  });

  it('apagar só a subpasta não apaga a pasta de cima; o resumo diz quantas subpastas foram junto', async () => {
    const u = await user();
    const a = await folder(u, 'Oferta A');
    const b = await folder(u, 'Verão', a.id);
    const res = await u.client.delete(`/api/creatives/folders/${b.id}`);
    assert.deepEqual([res.status, res.json], [200, { moved: 0, subfolders: 0 }]);
    assert.deepEqual((await folders(u)).folders.map((f) => f.name), ['Oferta A']);
  });

  it('renomear respeita o nome único entre irmãs e ignora tentativa de mudar o pai (a pasta não "muda de lugar")', async () => {
    const u = await user();
    const a = await folder(u, 'Oferta A');
    const b = await folder(u, 'Oferta B');
    const v1 = await folder(u, 'Vídeos', a.id);
    await folder(u, 'Imagens', a.id);
    const clash = await u.client.patch(`/api/creatives/folders/${v1.id}`, { name: 'imagens' });
    assert.equal(clash.status, 409, 'já existe uma irmã com esse nome');
    assert.equal((await u.client.patch(`/api/creatives/folders/${v1.id}`, { name: 'Oferta B' })).status, 200, 'o mesmo nome de uma pasta que não é irmã pode');
    const moved = await u.client.patch(`/api/creatives/folders/${v1.id}`, { name: 'Vídeos 2', parentId: b.id });
    assert.equal(moved.status, 200);
    assert.equal((await folders(u)).folders.find((f) => f.id === v1.id).parentId, a.id, 'o pai não mudou');
  });

  it('isolamento: ninguém lê, renomeia ou apaga as subpastas de outra pessoa', async () => {
    const u = await user();
    const other = await user();
    const a = await folder(u, 'Oferta A');
    const sub = await folder(u, 'Verão', a.id);
    assert.equal((await other.client.patch(`/api/creatives/folders/${sub.id}`, { name: 'Invasão' })).status, 404);
    assert.equal((await other.client.delete(`/api/creatives/folders/${a.id}`)).status, 404);
    assert.equal((await folders(other)).folders.length, 0);
    assert.equal((await folders(u)).folders.length, 2, 'tudo intacto');
  });

  it('o banco também protege: não aceita duas irmãs com o mesmo nome nem pai de outra pessoa apagado deixando órfã', async () => {
    const u = await user();
    const id = (await one(ctx.db, 'SELECT id FROM users WHERE lower(email) = $1', [u.email.toLowerCase()])).id;
    const a = await folder(u, 'Oferta A');
    await run(ctx.db, "INSERT INTO creative_folders (user_id, name, parent_id) VALUES ($1, 'Sub', $2)", [id, a.id]);
    await assert.rejects(run(ctx.db, "INSERT INTO creative_folders (user_id, name, parent_id) VALUES ($1, 'SUB', $2)", [id, a.id]), /creative_folders_sibling_name_key|duplicate/i);
    await assert.rejects(run(ctx.db, "INSERT INTO creative_folders (user_id, name) VALUES ($1, 'oferta a')", [id]), /creative_folders_sibling_name_key|duplicate/i, 'também entre as de nível mais alto (pai nulo)');
    await run(ctx.db, 'DELETE FROM creative_folders WHERE id = $1', [a.id]);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM creative_folders WHERE user_id = $1', [id])).c, 0, 'a filha foi junto (ON DELETE CASCADE): nunca sobra órfã');
  });

  it('entra no registro de atividades: a subpasta mostra em qual pasta foi criada', async () => {
    const u = await user();
    const a = await folder(u, 'Oferta A');
    await folder(u, 'Verão', a.id);
    const entries = [];
    for (let i = 0; i < 40 && entries.length < 2; i += 1) {
      entries.splice(0, entries.length, ...(await u.client.get('/api/team/activity?range=365')).json.entries.filter((e) => e.action === 'folder.create'));
      if (entries.length < 2) await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    const sub = entries.find((e) => e.targetName === 'Verão');
    assert.ok(sub, 'registrou a subpasta');
    assert.equal(sub.details.folder, 'Oferta A');
    assert.equal(entries.find((e) => e.targetName === 'Oferta A').details.folder, undefined, 'a de nível mais alto não tem pasta de origem');
  });
});
