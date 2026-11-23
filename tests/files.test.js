import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { decryptBuffer, encryptBuffer } from '../src/lib/crypto.js';
import { MAX_FILES_PER_ACCOUNT, MAX_FILE_BYTES, detectAttachment, extensionOf, sanitizeFilename } from '../src/modules/files/file-types.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { tiktokTestConfig } from './fake-tiktok.js';
import { createUser, one, run, startTestServer } from './helpers.js';
import { makeImage, tempDir } from './real-media.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000, filesRead: 1000, filesWrite: 1000 };
const dir = tempDir('files-test-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const emailOf = () => `fl${++counter}@example.com`;
const SECRET = 'usuario: lucas@loja.com\nsenha: S3nh@-Super-Secreta-123';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 1)]);

describe('Anexos: regras de tipo e nome (sem servidor)', () => {
  it('extensão: só a última conta; vazio e sem ponto dão null', () => {
    assert.deepEqual(['a.TXT', 'a.txt.exe', 'semponto', '.env', 'x.jpeg'].map(extensionOf), ['txt', 'exe', null, 'env', 'jpeg']);
  });

  it('o conteúdo precisa bater com a extensão', () => {
    const png = fs.readFileSync(makeImage(dir, { name: 'a.png' }));
    const jpg = fs.readFileSync(makeImage(dir, { name: 'a.jpg' }));
    assert.equal(detectAttachment('logins.txt', Buffer.from(SECRET)), 'txt');
    assert.equal(detectAttachment('planilha.csv', Buffer.from('a;b\n1;2')), 'csv');
    assert.equal(detectAttachment('nota.md', Buffer.from('# acentuação ção')), 'md');
    assert.equal(detectAttachment('doc.pdf', PDF), 'pdf');
    assert.equal(detectAttachment('foto.png', png), 'png');
    assert.equal(detectAttachment('foto.jpg', jpg), 'jpg');
    assert.equal(detectAttachment('foto.jpeg', jpg), 'jpg');
    assert.equal(detectAttachment('doc.docx', ZIP), 'docx');
    assert.equal(detectAttachment('doc.xlsx', ZIP), 'xlsx');
    // não bate
    assert.equal(detectAttachment('falso.pdf', Buffer.from('é só texto')), null);
    assert.equal(detectAttachment('falso.png', jpg), null, 'JPEG com extensão .png');
    assert.equal(detectAttachment('falso.jpg', png), null);
    assert.equal(detectAttachment('falso.docx', PDF), null);
    assert.equal(detectAttachment('binario.txt', Buffer.from([0x41, 0x00, 0x42])), null, 'byte nulo: não é texto');
    assert.equal(detectAttachment('latin1.txt', Buffer.from([0xe7, 0xe3, 0x6f])), null, 'UTF-8 inválido');
    assert.equal(detectAttachment('vazio.txt', Buffer.alloc(0)), null);
  });

  it('nada executável nem interpretável pelo navegador', () => {
    for (const name of ['a.exe', 'a.sh', 'a.html', 'a.htm', 'a.svg', 'a.js', 'a.json', 'a.xml', 'a.php', 'a.bat', 'a.dll', 'a.zip', 'a.gif', 'a.txt.exe', 'a.exe.txt.sh', 'semextensao']) {
      assert.equal(detectAttachment(name, Buffer.from('<html><script>alert(1)</script></html>')), null, name);
    }
    assert.equal(detectAttachment('a.html.txt', Buffer.from('<script>alert(1)</script>')), 'txt', 'o conteúdo "html" dentro de um .txt é só texto e só baixa');
  });

  it('nome seguro: sem pasta, controles, caracteres de arquivo especiais; limite de 120 mantendo a extensão', () => {
    assert.equal(sanitizeFilename('../../etc/passwd.txt'), 'passwd.txt');
    assert.equal(sanitizeFilename('C:\\Users\\x\\logins.txt'), 'logins.txt');
    assert.equal(sanitizeFilename('  a\u0000b\r\nc  .txt'), 'abc .txt');
    assert.equal(sanitizeFilename('<a>:"b"|?*.txt'), 'ab.txt');
    assert.equal(sanitizeFilename('Relatório de Março.pdf'), 'Relatório de Março.pdf');
    for (const bad of ['', '   ', '.', '..', '.env', '/', null, undefined]) assert.equal(sanitizeFilename(bad), null, String(bad));
    const long = sanitizeFilename(`${'a'.repeat(300)}.pdf`);
    assert.ok(long.length === 120 && long.endsWith('.pdf'));
  });

  it('criptografia: ida e volta, contexto (dono) autenticado, adulteração detectada, IV novo a cada vez', () => {
    const key = Buffer.alloc(32, 7);
    const plain = Buffer.from(SECRET);
    const a = encryptBuffer(plain, key, 1);
    const b = encryptBuffer(plain, key, 1);
    assert.notDeepEqual(a, b, 'IV aleatório');
    assert.ok(!a.includes(Buffer.from('senha')), 'o texto não aparece cifrado');
    assert.deepEqual(decryptBuffer(a, key, 1), plain);
    assert.throws(() => decryptBuffer(a, key, 2), 'outro dono: não decifra');
    assert.throws(() => decryptBuffer(a, Buffer.alloc(32, 8), 1), 'outra chave');
    const tampered = Buffer.from(a);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptBuffer(tampered, key, 1), 'adulterado');
    for (const bad of [Buffer.alloc(5), Buffer.alloc(40), 'texto', null]) assert.throws(() => decryptBuffer(bad, key, 1));
  });
});

describe('Anexos da conta (API)', () => {
  let ctx;
  let mailer;
  before(async () => {
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, mailer });
  });
  after(() => ctx.stop());

  const owner = () => createUser(ctx, { approve: true, name: 'Lucas Dono', email: emailOf() });
  const upload = (client, name, bytes, headers = {}, opts = {}) => client.request('POST', `/api/files?filename=${encodeURIComponent(name)}`, { raw: bytes, headers: { 'content-type': 'application/octet-stream', ...headers }, ...opts });
  const download = (client, id) => fetch(`${ctx.baseUrl}/api/files/${id}/download`, { headers: { cookie: client.cookie } });
  async function collaborator(boss, areas) {
    const email = emailOf();
    await boss.client.post('/api/team/invites', { email, name: 'Maria Colega', areas });
    const client = ctx.client();
    const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
    client.csrf = accepted.json.csrfToken;
    return { client, id: accepted.json.user.id };
  }

  it('envia, lista (sem conteúdo) e baixa exatamente os mesmos bytes, sempre como download', async () => {
    const user = await owner();
    const res = await upload(user.client, 'logins da loja.txt', Buffer.from(SECRET));
    assert.equal(res.status, 201, res.text);
    const file = res.json.file;
    assert.deepEqual({ name: file.name, ext: file.ext, size: file.size, uploadedBy: file.uploadedBy }, { name: 'logins da loja.txt', ext: 'txt', size: Buffer.byteLength(SECRET), uploadedBy: 'Lucas Dono' });
    const list = await user.client.get('/api/files');
    assert.equal(list.json.files.length, 1);
    assert.ok(!list.text.includes('senha') && !list.text.includes('data'), 'a lista não traz o conteúdo');
    assert.equal(list.json.usage.count, 1);
    assert.equal(list.json.enabled, true);

    const got = await download(user.client, file.id);
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(await got.arrayBuffer()).toString(), SECRET);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.match(got.headers.get('content-disposition'), /^attachment; filename="logins da loja\.txt"; filename\*=UTF-8''logins%20da%20loja\.txt$/);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(got.headers.get('cache-control'), 'no-store');
    assert.match(got.headers.get('content-security-policy'), /sandbox/);
  });

  it('o arquivo é gravado CRIPTOGRAFADO: nem o banco mostra o conteúdo', async () => {
    const user = await owner();
    const { json } = await upload(user.client, 'segredo.txt', Buffer.from(SECRET));
    const row = await one(ctx.db, 'SELECT data, size FROM workspace_files WHERE id = $1', [json.file.id]);
    assert.ok(!row.data.includes(Buffer.from('S3nh@')) && !row.data.includes(Buffer.from('lucas@loja.com')));
    assert.equal(row.data[0], 1, 'versão do formato');
    assert.ok(row.data.length > row.size, 'tem IV e tag de autenticação');
  });

  it('PDF, planilha, imagem e documento de verdade funcionam', async () => {
    const user = await owner();
    const png = fs.readFileSync(makeImage(dir, { name: 'p.png' }));
    for (const [name, bytes] of [['contrato.pdf', PDF], ['dados.csv', Buffer.from('a;b\n1;2')], ['print.png', png], ['equipe.docx', ZIP], ['notas.md', Buffer.from('# oi')]]) {
      const res = await upload(user.client, name, bytes);
      assert.equal(res.status, 201, `${name}: ${res.text}`);
      assert.deepEqual(Buffer.from(await (await download(user.client, res.json.file.id)).arrayBuffer()), bytes, name);
    }
  });

  it('recusa o que não é documento/imagem OU quando o conteúdo não bate com a extensão (415)', async () => {
    const user = await owner();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const attempts = [['virus.exe', Buffer.from('MZ\u0090\u0000')], ['pagina.html', html], ['img.svg', Buffer.from('<svg onload=alert(1)/>')], ['codigo.js', Buffer.from('alert(1)')], ['dados.json', Buffer.from('{}')], ['x.txt.exe', Buffer.from('oi')], ['semextensao', Buffer.from('oi')], ['falso.pdf', Buffer.from('é só texto')], ['falso.png', html], ['bin.txt', Buffer.from([0, 1, 2, 3])], ['arquivo.zip', ZIP]];
    for (const [name, bytes] of attempts) assert.equal((await upload(user.client, name, bytes, { 'content-type': 'text/plain' })).status, 415, name);
    assert.equal((await user.client.get('/api/files')).json.files.length, 0, 'nada foi guardado');
  });

  it('nomes perigosos viram nomes seguros; nome inválido (400); vazio (400)', async () => {
    const user = await owner();
    const res = await upload(user.client, '../../etc/passwd.txt', Buffer.from('oi'));
    assert.equal(res.json.file.name, 'passwd.txt');
    const crlf = await upload(user.client, 'a\r\nSet-Cookie: x=1.txt', Buffer.from('oi'));
    const got = await download(user.client, crlf.json.file.id);
    assert.ok(!/[\r\n]/.test(got.headers.get('content-disposition')) && !got.headers.get('set-cookie'));
    assert.equal((await upload(user.client, '..', Buffer.from('oi'))).status, 400);
    assert.equal((await user.client.request('POST', '/api/files', { raw: Buffer.from('oi') })).status, 400, 'sem filename');
    assert.equal((await upload(user.client, 'vazio.txt', Buffer.alloc(0))).status, 400);
    const unicode = await upload(user.client, 'Relatório – março.pdf', PDF);
    assert.equal(unicode.json.file.name, 'Relatório – março.pdf');
    const header = (await download(user.client, unicode.json.file.id)).headers.get('content-disposition');
    assert.match(header, /filename\*=UTF-8''Relat%C3%B3rio%20%E2%80%93%20mar%C3%A7o\.pdf/);
  });

  it('limite de tamanho por arquivo (413)', async () => {
    const user = await owner();
    const big = Buffer.concat([Buffer.from('a'.repeat(MAX_FILE_BYTES + 10))]);
    let status;
    try {
      status = (await upload(user.client, 'grande.txt', big)).status;
    } catch (err) {
      status = ['EPIPE', 'ECONNRESET'].includes(err.cause?.code) ? 413 : `erro: ${err.message}`;
    }
    assert.equal(status, 413);
    assert.equal((await upload(user.client, 'no-limite.txt', Buffer.from('a'.repeat(MAX_FILE_BYTES)))).status, 201);
  });

  it('limite de quantidade e de espaço total por conta (413)', async () => {
    const user = await owner();
    for (let i = 0; i < MAX_FILES_PER_ACCOUNT; i += 1) {
      await run(ctx.db, "INSERT INTO workspace_files (owner_id, name, ext, size, data) VALUES ($1, $2, 'txt', 10, $3)", [user.id, `f${i}.txt`, Buffer.alloc(40)]);
    }
    const res = await upload(user.client, 'mais-um.txt', Buffer.from('oi'));
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'quota_exceeded');
    const other = await owner();
    await run(ctx.db, "INSERT INTO workspace_files (owner_id, name, ext, size, data) VALUES ($1, 'cheio.txt', 'txt', 5242880, $2)", [other.id, Buffer.alloc(40)]);
    for (let i = 0; i < 19; i += 1) await run(ctx.db, "INSERT INTO workspace_files (owner_id, name, ext, size, data) VALUES ($1, $2, 'txt', 5242880, $3)", [other.id, `c${i}.txt`, Buffer.alloc(40)]);
    assert.equal((await upload(other.client, 'estourou.txt', Buffer.from('oi'))).status, 413, 'passaria de 100 MB');
  });

  it('exclui; excluir de novo e baixar excluído dão 404', async () => {
    const user = await owner();
    const { json } = await upload(user.client, 'a.txt', Buffer.from('oi'));
    assert.equal((await user.client.delete(`/api/files/${json.file.id}`)).status, 204);
    assert.equal((await user.client.delete(`/api/files/${json.file.id}`)).status, 404);
    assert.equal((await download(user.client, json.file.id)).status, 404);
    assert.equal((await user.client.get('/api/files')).json.files.length, 0);
  });

  it('isolamento: outra conta não lista, baixa nem exclui (404); ID inválido (400); sem login (401)', async () => {
    const a = await owner();
    const b = await owner();
    const { json } = await upload(a.client, 'meu.txt', Buffer.from(SECRET));
    assert.deepEqual((await b.client.get('/api/files')).json.files, []);
    assert.equal((await download(b.client, json.file.id)).status, 404);
    assert.equal((await b.client.delete(`/api/files/${json.file.id}`)).status, 404);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_files WHERE id = $1', [json.file.id])).c, 1);
    for (const bad of ['abc', '0', '-1']) assert.equal((await download(a.client, bad)).status, 400, bad);
    assert.equal((await ctx.client().get('/api/files')).status, 401);
    assert.equal((await fetch(`${ctx.baseUrl}/api/files/${json.file.id}/download`)).status, 401);
  });

  it('exige token CSRF e mesma origem para enviar e excluir; conta pendente não acessa', async () => {
    const user = await owner();
    assert.equal((await upload(user.client, 'a.txt', Buffer.from('oi'), {}, { withCsrf: false })).status, 403);
    assert.equal((await upload(user.client, 'a.txt', Buffer.from('oi'), { origin: 'https://evil.example' })).status, 403);
    const { json } = await upload(user.client, 'b.txt', Buffer.from('oi'));
    assert.equal((await user.client.delete(`/api/files/${json.file.id}`, { withCsrf: false })).status, 403);
    const pending = await createUser(ctx, { approve: false });
    assert.equal((await pending.client.get('/api/files')).status, 403);
  });

  it('equipe: colaborador com "Contas TikTok" vê, baixa, envia e exclui os arquivos do dono; os demais não', async () => {
    const boss = await owner();
    const { json } = await upload(boss.client, 'logins.txt', Buffer.from(SECRET));
    const withAccounts = await collaborator(boss, ['accounts']);
    const list = await withAccounts.client.get('/api/files');
    assert.equal(list.json.files[0].name, 'logins.txt');
    assert.equal(Buffer.from(await (await download(withAccounts.client, json.file.id)).arrayBuffer()).toString(), SECRET);
    const sent = await upload(withAccounts.client, 'da-maria.pdf', PDF);
    assert.equal(sent.status, 201);
    assert.equal(sent.json.file.uploadedBy, 'Maria Colega', 'mostra quem enviou');
    assert.equal((await one(ctx.db, 'SELECT owner_id FROM workspace_files WHERE id = $1', [sent.json.file.id])).owner_id, boss.id, 'fica na conta do dono');
    assert.equal((await boss.client.get('/api/files')).json.files.length, 2, 'o dono vê o que a colega enviou');
    assert.equal((await withAccounts.client.delete(`/api/files/${sent.json.file.id}`)).status, 204);
    for (const areas of [['creatives'], ['campaigns'], ['reports'], ['creatives', 'campaigns', 'reports']]) {
      const denied = await collaborator(boss, areas);
      assert.equal((await denied.client.get('/api/files')).status, 403, areas.join());
      assert.equal((await download(denied.client, json.file.id)).status, 403);
      assert.equal((await upload(denied.client, 'x.txt', Buffer.from('oi'))).status, 403);
      assert.equal((await denied.client.delete(`/api/files/${json.file.id}`)).status, 403);
    }
  });

  it('remover o colaborador mantém o arquivo e limpa o "enviado por"; arquivo trocado de dono no banco não decifra; adulterado não abre', async () => {
    const boss = await owner();
    const mate = await collaborator(boss, ['accounts']);
    const sent = (await upload(mate.client, 'maria.txt', Buffer.from('oi'))).json.file;
    const members = (await boss.client.get('/api/team')).json.members;
    await boss.client.delete(`/api/team/members/${members[0].id}`);
    const kept = (await boss.client.get('/api/files')).json.files.find((f) => f.id === sent.id);
    assert.equal(kept.uploadedBy, null);
    assert.equal((await download(boss.client, sent.id)).status, 200, 'o arquivo continua');

    const other = await owner();
    await run(ctx.db, 'UPDATE workspace_files SET owner_id = $1 WHERE id = $2', [other.id, sent.id]); // alguém moveu a linha no banco
    const moved = await download(other.client, sent.id);
    assert.equal(moved.status, 409);
    assert.equal((await moved.json()).error.code, 'file_unreadable');
    await run(ctx.db, 'UPDATE workspace_files SET owner_id = $1 WHERE id = $2', [boss.id, sent.id]);
    await run(ctx.db, 'UPDATE workspace_files SET data = $1 WHERE id = $2', [Buffer.alloc(60, 3), sent.id]);
    assert.equal((await download(boss.client, sent.id)).status, 409, 'dado adulterado');
  });

  it('a restrição do banco recusa extensão e tamanho inválidos mesmo fora da API', async () => {
    const user = await owner();
    const insert = (ext, size) => ctx.db.query('INSERT INTO workspace_files (owner_id, name, ext, size, data) VALUES ($1, $2, $3, $4, $5)', [user.id, 'x', ext, size, Buffer.alloc(40)]);
    await assert.rejects(() => insert('exe', 10), (e) => e.code === '23514');
    await assert.rejects(() => insert('html', 10), (e) => e.code === '23514');
    await assert.rejects(() => insert('txt', 0), (e) => e.code === '23514');
    await assert.rejects(() => insert('txt', 5_242_881), (e) => e.code === '23514');
  });
});

describe('Anexos: sem chave de criptografia e limites', () => {
  it('sem TOKEN_ENCRYPTION_KEY o recurso fica desligado (503) e nada é gravado sem criptografia', async () => {
    const ctx = await startTestServer({ limits: LIMITS, config: { tiktok: { ...tiktokTestConfig().tiktok, encryptionKey: null } } });
    try {
      const user = await createUser(ctx, { approve: true, email: emailOf() });
      assert.equal((await user.client.get('/api/files')).json.enabled, false);
      const res = await user.client.request('POST', '/api/files?filename=a.txt', { raw: Buffer.from('oi'), headers: { 'content-type': 'text/plain' } });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'files_disabled');
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_files')).c, 0);
    } finally {
      await ctx.stop();
    }
  });

  it('limita envios por minuto (429)', async () => {
    const ctx = await startTestServer({ limits: { ...LIMITS, filesWrite: 2 }, config: tiktokTestConfig() });
    try {
      const user = await createUser(ctx, { approve: true, email: emailOf() });
      const send = () => user.client.request('POST', '/api/files?filename=a.txt', { raw: Buffer.from(`oi ${Math.random()}`), headers: { 'content-type': 'text/plain' } });
      assert.deepEqual([(await send()).status, (await send()).status, (await send()).status], [201, 201, 429]);
    } finally {
      await ctx.stop();
    }
  });
});
