import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { MAX_AVATAR_UPLOAD_BYTES, createAvatarProcessor } from '../src/modules/profile/avatar-processor.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { createUser, loginAdmin, one, startTestServer } from './helpers.js';
import { ffmpegPath, makeImage, probe, tempDir } from './real-media.js';
import { tiktokTestConfig } from './fake-tiktok.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000, profileWrite: 1000, avatarRead: 1000 };
const dir = tempDir('profile-test-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const png = (name = 'foto.png', opts = {}) => fs.readFileSync(makeImage(dir, { name, width: 300, height: 200, ...opts }));
const jpg = (name = 'foto.jpg', opts = {}) => fs.readFileSync(makeImage(dir, { name, width: 300, height: 200, ...opts }));
let counter = 0;
const emailOf = (p = 'p') => `${p}${++counter}@example.com`;
const COLLAB_PASSWORD = 'SenhaDoColaborador-12';

const upload = (client, bytes, contentType = 'image/png', opts = {}) => client.request('POST', '/api/profile/avatar', { raw: bytes, headers: { 'content-type': contentType }, ...opts });
const dims = (buffer) => {
  const file = `${dir}/lida-${Math.random().toString(16).slice(2)}.jpg`;
  fs.writeFileSync(file, buffer);
  const m = /Video: mjpeg[^\n]*?(\d{2,5})x(\d{2,5})/.exec(probe(file));
  return [Number(m[1]), Number(m[2])];
};
const rawGet = (ctx, client, urlPath) => fetch(ctx.baseUrl + urlPath, { headers: { cookie: client.cookie } });

describe('Foto de perfil: envio, entrega e permissões', () => {
  let ctx;
  let mailer;
  before(async () => {
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, mailer });
  });
  after(() => ctx.stop());

  async function addCollaborator(owner, areas = ['creatives']) {
    const email = emailOf('colab');
    await owner.client.post('/api/team/invites', { email, name: 'Maria Colaboradora', areas });
    const token = mailer.tokenFrom(mailer.lastTo(email));
    const client = ctx.client();
    const accepted = await client.post('/api/invitations/accept', { token, password: COLLAB_PASSWORD });
    client.csrf = accepted.json.csrfToken;
    return { client, id: accepted.json.user.id, email };
  }
  const approved = (name) => createUser(ctx, { approve: true, name, email: emailOf() });

  it('PNG e JPEG: o servidor devolve SEMPRE um JPEG 256x256 novo, e a versão aparece em /me', async () => {
    const user = await approved('Ana');
    assert.equal((await user.client.get('/api/auth/me')).json.user.avatarVersion, null, 'começa sem foto');
    for (const [bytes, type] of [[png(), 'image/png'], [jpg(), 'image/jpeg']]) {
      const res = await upload(user.client, bytes, type);
      assert.equal(res.status, 201, res.text);
      assert.ok(Number.isInteger(res.json.avatarVersion) && res.json.avatarVersion > 1_600_000_000_000);
      const image = await rawGet(ctx, user.client, `/api/avatars/${user.id}`);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/jpeg');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.match(image.headers.get('cache-control'), /^private/);
      const body = Buffer.from(await image.arrayBuffer());
      assert.deepEqual(dims(body), [256, 256]);
      assert.ok(body.length <= 200 * 1024);
    }
    const me = (await user.client.get('/api/auth/me')).json.user;
    assert.ok(me.avatarVersion > 0);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [user.id])).c, 1, 'uma só linha por usuário (a nova substitui)');
  });

  it('trocar a foto muda a versão (a tela busca a imagem nova); remover volta ao estado sem foto', async () => {
    const user = await approved('Bia');
    const first = (await upload(user.client, png('a.png', { color: '0x2255ee' }))).json.avatarVersion;
    await new Promise((r) => setTimeout(r, 15));
    const second = (await upload(user.client, png('b.png', { color: '0xee5522' }))).json.avatarVersion;
    assert.ok(second > first);
    assert.equal((await user.client.get('/api/auth/me')).json.user.avatarVersion, second);
    assert.equal((await user.client.delete('/api/profile/avatar')).status, 204);
    assert.equal((await user.client.get('/api/auth/me')).json.user.avatarVersion, null);
    assert.equal((await rawGet(ctx, user.client, `/api/avatars/${user.id}`)).status, 404);
    assert.equal((await user.client.delete('/api/profile/avatar')).status, 204, 'remover sem foto não dá erro');
  });

  it('a imagem guardada não carrega metadados nem conteúdo escondido (polyglot)', async () => {
    const user = await approved('Caio');
    const bytes = Buffer.concat([jpg('meta.jpg'), Buffer.from('<script>alert(1)</script><?php evil(); ?>')]);
    assert.equal((await upload(user.client, bytes, 'image/jpeg')).status, 201);
    const stored = (await one(ctx.db, 'SELECT data FROM user_avatars WHERE user_id = $1', [user.id])).data.toString('latin1');
    assert.ok(!/<script>|<\?php|SEGREDO|xmpmeta|ns\.adobe\.com/i.test(stored));
  });

  it('o que vale é o CONTEÚDO: SVG, HTML, GIF, PDF, vídeo e texto com Content-Type de imagem são recusados (415)', async () => {
    const user = await approved('Duda');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    const attempts = [[svg, 'image/png'], [svg, 'image/jpeg'], [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'], [Buffer.from('GIF89a\x01\x00\x01\x00'), 'image/jpeg'], [Buffer.from('%PDF-1.4 ...'), 'image/png'], [Buffer.from('texto qualquer'), 'image/jpeg'], [png(), 'image/jpeg'], [jpg(), 'image/png']];
    for (const [bytes, type] of attempts) assert.equal((await upload(user.client, bytes, type)).status, 415, `${type} ${bytes.subarray(0, 12).toString('latin1')}`);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [user.id])).c, 0, 'nada foi guardado');
  });

  it('Content-Type não suportado ou ausente: 415 (SVG, GIF, WebP, texto, vídeo)', async () => {
    const user = await approved('Eva');
    for (const type of ['image/svg+xml', 'image/gif', 'image/webp', 'text/html', 'video/mp4', 'application/octet-stream', '']) {
      assert.equal((await upload(user.client, png(), type)).status, 415, JSON.stringify(type));
    }
    assert.ok([400, 415].includes((await upload(user.client, png(), 'application/json')).status), 'JSON é lido (e recusado) antes de chegar à foto');
    const noType = await fetch(`${ctx.baseUrl}/api/profile/avatar`, { method: 'POST', headers: { cookie: user.client.cookie, 'x-csrf-token': user.client.csrfToken }, body: png() });
    assert.ok([400, 415].includes(noType.status));
  });

  it('tamanho: vazio (400), acima do limite (413, mesmo sem Content-Length confiável) e dimensões gigantes (422)', async () => {
    const user = await approved('Fabi');
    assert.equal((await upload(user.client, Buffer.alloc(0))).status, 400);
    // Acima do limite: 413, ou a conexão é fechada antes de o navegador terminar de enviar (EPIPE/ECONNRESET). Nos dois casos nada é guardado.
    const refused = async (bytes) => {
      try {
        return (await upload(user.client, bytes)).status;
      } catch (err) {
        return ['EPIPE', 'ECONNRESET'].includes(err.cause?.code) ? 413 : `erro inesperado: ${err.message}`;
      }
    };
    assert.equal(await refused(Buffer.concat([png(), Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES)])), 413);
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(50_000, 16);
    header.writeUInt32BE(50_000, 20);
    assert.equal((await upload(user.client, header)).status, 422, 'bomba de descompressão recusada pelo cabeçalho');
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
    assert.equal((await upload(user.client, corrupt, 'image/jpeg')).status, 422, 'arquivo corrompido');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [user.id])).c, 0);
  });

  it('exige sessão, token CSRF e mesma origem; conta pendente não envia', async () => {
    const user = await approved('Gabi');
    assert.equal((await upload(ctx.client(), png())).status, 401);
    assert.equal((await upload(user.client, png(), 'image/png', { withCsrf: false })).status, 403);
    assert.equal((await upload(user.client, png(), 'image/png', { headers: { 'content-type': 'image/png', origin: 'https://evil.example' } })).status, 403);
    assert.equal((await user.client.delete('/api/profile/avatar', { withCsrf: false })).status, 403);
    assert.equal((await ctx.client().get(`/api/avatars/${user.id}`)).status, 401, 'foto exige login');
    const pending = await createUser(ctx, { approve: false });
    assert.equal((await upload(pending.client, png())).status, 403);
  });

  it('quem pode ver a foto de quem: a própria pessoa, o dono e os colegas da equipe; estranhos recebem 404; admin vê tudo', async () => {
    const owner = await approved('Dono');
    const stranger = await approved('Estranho');
    const member = await addCollaborator(owner);
    const teammate = await addCollaborator(owner);
    await upload(owner.client, png('dono.png'));
    await upload(member.client, png('membro.png'));
    const seeing = async (viewer, targetId) => (await rawGet(ctx, viewer.client, `/api/avatars/${targetId}`)).status;
    assert.equal(await seeing(owner, owner.id), 200, 'própria foto');
    assert.equal(await seeing(member, member.id), 200, 'própria foto (colaborador)');
    assert.equal(await seeing(owner, member.id), 200, 'dono vê a do colaborador');
    assert.equal(await seeing(member, owner.id), 200, 'colaborador vê a do dono');
    assert.equal(await seeing(teammate, member.id), 200, 'colega de equipe');
    assert.equal(await seeing(stranger, owner.id), 404, 'estranho não vê a do dono');
    assert.equal(await seeing(stranger, member.id), 404, 'nem a do colaborador');
    assert.equal(await seeing(owner, stranger.id), 404);
    assert.equal(await seeing(member, stranger.id), 404, 'colaborador não vê quem é de fora da equipe');
    const admin = await loginAdmin(ctx);
    assert.equal((await rawGet(ctx, admin, `/api/avatars/${member.id}`)).status, 200, 'admin supervisiona');
    // a equipe de OUTRO dono não se mistura
    const otherOwner = await approved('Outro dono');
    const otherMember = await addCollaborator(otherOwner);
    await upload(otherMember.client, png('outro.png'));
    assert.equal(await seeing(member, otherMember.id), 404);
    assert.equal(await seeing(owner, otherMember.id), 404);
  });

  it('pedidos inválidos: ID fora do padrão (400), usuário inexistente ou sem foto (404, mesma resposta que "sem permissão")', async () => {
    const user = await approved('Hugo');
    for (const bad of ['abc', '0', '-1', '1.5', '99999999999']) assert.equal((await rawGet(ctx, user.client, `/api/avatars/${bad}`)).status, 400, bad);
    assert.equal((await rawGet(ctx, user.client, '/api/avatars/2000000000')).status, 404);
    assert.equal((await rawGet(ctx, user.client, `/api/avatars/${user.id}`)).status, 404, 'sem foto');
    assert.equal((await rawGet(ctx, user.client, '/api/avatars/')).status, 404);
  });

  it('a foto do colaborador aparece na lista de equipe do dono (com a versão) e some junto com a conta', async () => {
    const owner = await approved('Dono2');
    const member = await addCollaborator(owner);
    let listed = (await owner.client.get('/api/team')).json.members[0];
    assert.equal(listed.userId, member.id);
    assert.equal(listed.avatarVersion, null);
    const version = (await upload(member.client, png('c.png'))).json.avatarVersion;
    listed = (await owner.client.get('/api/team')).json.members[0];
    assert.equal(listed.avatarVersion, version);
    assert.equal((await rawGet(ctx, owner.client, `/api/avatars/${member.id}`)).status, 200);
    assert.equal((await owner.client.delete(`/api/team/members/${listed.id}`)).status, 204);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [member.id])).c, 0, 'cascata ao remover o colaborador');
  });

  it('o colaborador muda a PRÓPRIA foto (não a do dono) sem precisar de nenhuma área', async () => {
    const owner = await approved('Dono3');
    const member = await addCollaborator(owner, ['reports']);
    assert.equal((await upload(member.client, png())).status, 201);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [member.id])).c, 1);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [owner.id])).c, 0, 'a foto do dono não mudou');
    assert.equal((await member.client.get('/api/auth/me')).json.user.avatarVersion > 0, true);
    assert.equal((await owner.client.get('/api/auth/me')).json.user.avatarVersion, null);
  });

  it('duas trocas simultâneas: sem erro 500 e fica uma única foto', async () => {
    const user = await approved('Iara');
    const results = await Promise.all([1, 2, 3, 4].map((i) => upload(user.client, png(`p${i}.png`, { color: `0x${i}0${i}0${i}0` }))));
    assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join(','));
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM user_avatars WHERE user_id = $1', [user.id])).c, 1);
  });

  it('não sobram arquivos temporários da pasta de criativos depois dos envios (aceitos ou recusados)', async () => {
    const leftovers = () => fs.readdirSync(`${ctx.creativesDir}/.tmp`).filter((n) => n.endsWith('.part') || n.startsWith('avatar-'));
    const user = await approved('Jana');
    await upload(user.client, png());
    await upload(user.client, Buffer.from('<svg/>'), 'image/png');
    await upload(user.client, Buffer.concat([png(), Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES)])).catch(() => {}); // pode fechar a conexão antes do fim do envio
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(leftovers(), []);
  });
});

describe('Perfil: nome', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS });
  });
  after(() => ctx.stop());

  it('o usuário muda o PRÓPRIO nome (normalizado) e só o nome: e-mail, função e status não mudam', async () => {
    const user = await createUser(ctx, { approve: true, name: 'Nome Antigo', email: emailOf() });
    const res = await user.client.patch('/api/profile', { name: '  Novo   Nome  ', email: 'invasor@example.com', role: 'admin', status: 'approved', id: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { name: 'Novo Nome' });
    const me = (await user.client.get('/api/auth/me')).json.user;
    assert.deepEqual([me.name, me.email, me.role], ['Novo Nome', user.email, 'user'], 'campos extras ignorados');
    assert.equal((await one(ctx.db, "SELECT role FROM users WHERE id = $1", [user.id])).role, 'user');
  });

  it('valida o nome (tamanho, caracteres de controle, tipo) e exige sessão e CSRF', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    for (const bad of [undefined, null, '', 'A', 'x'.repeat(81), 'a\u0000b', 123, ['Nome'], { a: 1 }]) assert.equal((await user.client.patch('/api/profile', { name: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await user.client.patch('/api/profile', [])).status, 400);
    assert.equal((await ctx.client().patch('/api/profile', { name: 'Fulano' })).status, 401);
    assert.equal((await user.client.patch('/api/profile', { name: 'Fulano' }, { withCsrf: false })).status, 403);
    const pending = await createUser(ctx, { approve: false });
    assert.equal((await pending.client.patch('/api/profile', { name: 'Fulano' })).status, 403);
  });

  it('o nome com HTML é guardado como texto (a tela nunca o interpreta) e o novo nome aparece para quem o vê', async () => {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await user.client.patch('/api/profile', { name: '<img src=x onerror=alert(1)>' })).status, 200);
    assert.equal((await user.client.get('/api/auth/me')).json.user.name, '<img src=x onerror=alert(1)>');
  });
});

describe('Foto de perfil: limites e indisponibilidade', () => {
  it('limita as trocas por minuto (429) e responde 503 se o servidor não tem FFmpeg', async () => {
    const limited = await startTestServer({ limits: { ...LIMITS, profileWrite: 3 } });
    try {
      const user = await createUser(limited, { approve: true, email: emailOf() });
      const statuses = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await upload(user.client, png())).status);
      assert.deepEqual(statuses, [201, 201, 201, 429]);
    } finally {
      await limited.stop();
    }
    const noFfmpeg = await startTestServer({ limits: LIMITS, avatarProcessor: createAvatarProcessor({ ffmpegPath: null, tmpDir: dir }) });
    try {
      const user = await createUser(noFfmpeg, { approve: true, email: emailOf() });
      const res = await upload(user.client, png());
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'avatar_unavailable');
    } finally {
      await noFfmpeg.stop();
    }
    assert.ok(ffmpegPath);
  });
});
