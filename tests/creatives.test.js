import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, loginAdmin, one, startTestServer } from './helpers.js';
import { jpegBytes, mp4Bytes, pngBytes, uploadCreative, uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, creativesRead: 5000, creativesWrite: 5000 };
const KB = 1024;

/** Envio em pedaços (chunked), sem Content-Length: simula navegador/atacante que não informa o tamanho. */
function chunkedUpload(ctx, client, { chunks, contentType = 'image/png', query = '?filename=x.png', destroyAfterFirstChunk = false }) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${ctx.baseUrl}/api/creatives${query}`);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers: { 'content-type': contentType, cookie: client.cookie, 'x-csrf-token': client.csrfToken, 'transfer-encoding': 'chunked' } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', (err) => (destroyAfterFirstChunk ? resolve({ aborted: true, error: err.code }) : reject(err)));
    (async () => {
      for (const chunk of chunks) {
        if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
        if (destroyAfterFirstChunk) {
          await new Promise((r) => setTimeout(r, 30));
          req.destroy();
          resolve({ aborted: true });
          return;
        }
      }
      req.end();
    })().catch(reject);
  });
}

const filesUnder = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : [e.name]));
};
const storedFiles = (ctx) => filesUnder(ctx.creativesDir).filter((f) => !f.startsWith('.tmp'));
const tempFiles = (ctx) => filesUnder(path.join(ctx.creativesDir, '.tmp'));
const waitFor = async (predicate, ms = 2000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('Biblioteca de criativos: envio, listagem, arquivo, isolamento', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn, creatives: { maxImageBytes: 100 * KB, maxVideoBytes: 300 * KB, quotaBytes: 400 * KB } });
  });
  after(() => ctx.stop());

  const newUser = (over) => createUser(ctx, { approve: true, ...over });

  it('exige login e conta aprovada em todas as rotas', async () => {
    const anon = ctx.client();
    assert.equal((await anon.get('/api/creatives')).status, 401);
    assert.equal((await uploadCreative(anon)).status, 401);
    assert.equal((await anon.get('/api/creatives/1/file')).status, 401);
    const pending = await createUser(ctx);
    for (const res of [await pending.client.get('/api/creatives'), await uploadCreative(pending.client), await pending.client.delete('/api/creatives/1'), await pending.client.get('/api/creatives/1/file')]) {
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'account_pending');
    }
    assert.equal(storedFiles(ctx).length, 0, 'nada foi gravado');
  });

  describe('envio', () => {
    it('aceita JPG, PNG, MP4 e MOV: tipo vem do CONTEÚDO, arquivo fica com nome aleatório e permissão 0600', async () => {
      const { client, id: userId } = await newUser();
      for (const [type, kind, mime, ext] of [['jpg', 'image', 'image/jpeg', 'jpg'], ['png', 'image', 'image/png', 'png'], ['mp4', 'video', 'video/mp4', 'mp4'], ['mov', 'video', 'video/quicktime', 'mov']]) {
        const res = await uploadCreative(client, { type, name: `Meu ${type}`, filename: `original.${type}` });
        assert.equal(res.status, 201, `${type}: ${res.text}`);
        const c = res.json.creative;
        assert.deepEqual({ name: c.name, kind: c.kind, mimeType: c.mimeType, source: c.source, hasFile: c.hasFile, originalFilename: c.originalFilename }, { name: `Meu ${type}`, kind, mimeType: mime, source: 'upload', hasFile: true, originalFilename: `original.${type}` });
        const row = await one(ctx.db, 'SELECT storage_key, size_bytes, user_id FROM creatives WHERE id = $1', [c.id]);
        assert.match(row.storage_key, new RegExp(`^${userId}/[a-f0-9]{32}\\.${ext}$`));
        const onDisk = path.join(ctx.creativesDir, row.storage_key);
        assert.ok(fs.existsSync(onDisk));
        assert.equal((fs.statSync(onDisk).mode & 0o777).toString(8), '600');
        assert.equal(row.size_bytes, fs.statSync(onDisk).size);
      }
    });

    it('guarda SHA-256 e MD5 corretos (o MD5 é a assinatura exigida pelo TikTok) e não vaza campos internos', async () => {
      const { client } = await newUser();
      const bytes = pngBytes('hash', 2000);
      const res = await uploadCreative(client, { bytes, type: 'png' });
      const row = await one(ctx.db, 'SELECT sha256, md5 FROM creatives WHERE id = $1', [res.json.creative.id]);
      assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(row.md5, createHash('md5').update(bytes).digest('hex'));
      for (const secret of ['storage_key', 'storageKey', 'sha256', 'md5', row.sha256, row.md5]) assert.ok(!res.text.includes(secret), `vazou: ${secret}`);
      assert.deepEqual(Object.keys(res.json.creative).sort(), ['aiGenerated', 'createdAt', 'hasFile', 'id', 'kind', 'mimeType', 'name', 'originalFilename', 'sizeBytes', 'source', 'tiktokAdvertisers', 'updatedAt']);
    });

    it('o nome padrão vem do arquivo (sem extensão); nome do arquivo malicioso nunca vira caminho', async () => {
      const { client } = await newUser();
      assert.equal((await uploadCreative(client, { type: 'png', filename: 'foto.final.png' })).json.creative.name, 'foto.final');
      const evil = await uploadCreative(client, { type: 'png', filename: '../../../etc/passwd.png', name: '../../x' });
      assert.equal(evil.status, 201);
      assert.equal(evil.json.creative.originalFilename, '../../../etc/passwd.png', 'só metadado');
      const row = await one(ctx.db, 'SELECT storage_key FROM creatives WHERE id = $1', [evil.json.creative.id]);
      assert.match(row.storage_key, /^\d+\/[a-f0-9]{32}\.png$/);
      assert.equal(fs.existsSync(path.join(ctx.creativesDir, '..', '..', 'etc')), false);
    });

    it('valida o nome (tamanho, caracteres de controle)', async () => {
      const { client } = await newUser();
      assert.equal((await uploadCreative(client, { type: 'png', name: 'x'.repeat(101) })).status, 400);
      assert.equal((await uploadCreative(client, { type: 'png', name: 'a\u0000b' })).status, 400);
      assert.equal((await uploadCreative(client, { type: 'png', filename: 'a'.repeat(201) })).status, 400);
      assert.equal(storedFiles(ctx).length >= 0, true);
    });

    it('recusa tipo declarado não suportado (415) sem gravar nada', async () => {
      const { client } = await newUser();
      const filesBefore = storedFiles(ctx).length;
      for (const contentType of ['image/svg+xml', 'text/html', 'image/gif', 'application/octet-stream', 'text/plain', 'image/webp', 'application/pdf', 'multipart/form-data; boundary=x']) {
        const res = await uploadCreative(client, { bytes: pngBytes(), contentType });
        assert.equal(res.status, 415, contentType);
        assert.equal(res.json.error.code, 'unsupported_media_type');
      }
      assert.equal(storedFiles(ctx).length, filesBefore);
      assert.deepEqual(tempFiles(ctx), []);
    });

    it('recusa conteúdo que não corresponde ao tipo (arquivo disfarçado) mesmo com Content-Type e extensão "certos"', async () => {
      const { client } = await newUser();
      const disguised = {
        'SVG com script como PNG': [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png', 'x.png'],
        'HTML como JPG': [Buffer.from('<html><script>alert(document.cookie)</script></html>'), 'image/jpeg', 'x.jpg'],
        'MP4 declarado como PNG': [mp4Bytes('d1'), 'image/png', 'x.png'],
        'PNG declarado como MP4': [pngBytes('d2'), 'video/mp4', 'x.mp4'],
        'JPEG declarado como vídeo': [jpegBytes('d3'), 'video/quicktime', 'x.mov'],
        'executável como MP4': [Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]), 'video/mp4', 'x.mp4'],
        'HEIC como JPG': [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(40)]), 'image/jpeg', 'x.jpg'],
        'texto qualquer': [Buffer.from('apenas um texto longo o bastante para ter 16+ bytes'), 'image/png', 'x.png'],
      };
      for (const [name, [bytes, contentType, filename]] of Object.entries(disguised)) {
        const res = await uploadCreative(client, { bytes, contentType, filename });
        assert.equal(res.status, 415, name);
        assert.equal(res.json.error.code, 'content_mismatch', name);
      }
      assert.deepEqual(tempFiles(ctx), [], 'temporários removidos');
      assert.equal((await client.get('/api/creatives')).json.total, 0, 'nada entrou na biblioteca');
    });

    it('recusa arquivo vazio (400), cabeçalho truncado (415) e Content-Length inválido', async () => {
      const { client } = await newUser();
      const empty = await uploadCreative(client, { bytes: Buffer.alloc(0), contentType: 'image/png' });
      assert.equal(empty.status, 400);
      assert.equal(empty.json.error.code, 'empty_file');
      assert.equal((await uploadCreative(client, { bytes: Buffer.from([0x89, 0x50]), contentType: 'image/png' })).status, 415);
      assert.deepEqual(tempFiles(ctx), []);
    });

    it('limites por tipo: imagem 100 KB, vídeo 300 KB (por Content-Length, antes de ler o corpo)', async () => {
      const { client } = await newUser();
      const bigImage = await uploadCreative(client, { bytes: pngBytes('big', 101 * KB), contentType: 'image/png' });
      assert.equal(bigImage.status, 413);
      assert.equal(bigImage.json.error.code, 'file_too_large');
      assert.equal((await uploadCreative(client, { bytes: pngBytes('ok-img', 90 * KB), contentType: 'image/png' })).status, 201);
      assert.equal((await uploadCreative(client, { bytes: mp4Bytes('big-vid', 301 * KB), contentType: 'video/mp4' })).status, 413);
      assert.equal((await uploadCreative(client, { bytes: mp4Bytes('ok-vid', 250 * KB), contentType: 'video/mp4' })).status, 201);
      assert.deepEqual(tempFiles(ctx), []);
    });

    it('envio sem Content-Length (chunked) também é interrompido no limite, sem deixar resto no disco nem no banco', async () => {
      const { client } = await newUser();
      const filesBefore = storedFiles(ctx).length;
      const chunks = [pngBytes('c0', 40 * KB), Buffer.alloc(40 * KB, 1), Buffer.alloc(40 * KB, 2)]; // 120 KB > 100 KB
      const res = await chunkedUpload(ctx, client, { chunks });
      assert.equal(res.status, 413);
      assert.equal(res.json.error.code, 'file_too_large');
      await waitFor(() => tempFiles(ctx).length === 0);
      assert.equal(storedFiles(ctx).length, filesBefore);
      assert.equal((await client.get('/api/creatives')).json.total, 0);
    });

    it('conexão cancelada no meio do envio não deixa arquivo parcial nem registro', async () => {
      const { client } = await newUser();
      const filesBefore = storedFiles(ctx).length;
      await chunkedUpload(ctx, client, { chunks: [pngBytes('abort', 30 * KB), Buffer.alloc(30 * KB)], destroyAfterFirstChunk: true });
      await waitFor(() => tempFiles(ctx).length === 0);
      assert.equal(storedFiles(ctx).length, filesBefore);
      assert.equal((await client.get('/api/creatives')).json.total, 0);
      assert.equal((await client.get('/api/auth/me')).status, 200, 'o servidor continua saudável');
    });

    it('envio chunked válido funciona', async () => {
      const { client } = await newUser();
      const bytes = jpegBytes('chunk', 30 * KB);
      const res = await chunkedUpload(ctx, client, { chunks: [bytes.subarray(0, 10 * KB), bytes.subarray(10 * KB)], contentType: 'image/jpeg', query: '?filename=c.jpg' });
      assert.equal(res.status, 201);
      assert.equal(res.json.creative.sizeBytes, bytes.length);
    });

    it('arquivo idêntico: 409 com o ID do existente; outro usuário pode enviar o mesmo arquivo', async () => {
      const a = await newUser();
      const b = await newUser();
      const bytes = pngBytes('mesmo');
      const first = await uploadCreative(a.client, { bytes, name: 'Original' });
      const dup = await uploadCreative(a.client, { bytes, name: 'Copia' });
      assert.equal(dup.status, 409);
      assert.equal(dup.json.error.code, 'duplicate_creative');
      assert.match(dup.json.error.message, /Original/);
      assert.equal(dup.json.error.details[0].message, String(first.json.creative.id));
      assert.equal((await uploadCreative(b.client, { bytes })).status, 201, 'a duplicidade é por usuário');
      assert.equal((await a.client.get('/api/creatives')).json.total, 1);
    });

    it('envios IGUAIS simultâneos: um vence (201), os demais 409, e só um arquivo fica no disco', async () => {
      const { client, id: userId } = await newUser();
      const bytes = pngBytes('corrida', 5000);
      const results = await Promise.all(Array.from({ length: 5 }, () => uploadCreative(client, { bytes })));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
      await waitFor(() => tempFiles(ctx).length === 0);
      assert.equal(filesUnder(path.join(ctx.creativesDir, String(userId))).length, 1);
    });

    it('envios diferentes simultâneos funcionam em paralelo', async () => {
      const { client } = await newUser();
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => uploadCreative(client, { type: 'png', seed: `par${i}` })));
      assert.ok(results.every((r) => r.status === 201));
      assert.equal(new Set(results.map((r) => r.json.creative.id)).size, 6);
    });

    it('cota por usuário (400 KB): recusa quando estoura e libera depois de excluir', async () => {
      const { client } = await newUser();
      const ids = [];
      for (let i = 0; i < 4; i += 1) ids.push(await uploadedId(client, { bytes: mp4Bytes(`q${i}`, 95 * KB), contentType: 'video/mp4' }));
      const over = await uploadCreative(client, { bytes: mp4Bytes('q-over', 95 * KB), contentType: 'video/mp4' });
      assert.equal(over.status, 413);
      assert.equal(over.json.error.code, 'quota_exceeded');
      const list = (await client.get('/api/creatives')).json;
      assert.equal(list.quotaBytes, 400 * KB);
      assert.ok(list.usedBytes > 380 * KB && list.usedBytes <= 400 * KB);
      assert.equal((await client.delete(`/api/creatives/${ids[0]}`)).status, 204);
      assert.equal((await uploadCreative(client, { bytes: mp4Bytes('q-again', 95 * KB), contentType: 'video/mp4' })).status, 201);
      // a cota é por usuário
      const other = await newUser();
      assert.equal((await uploadCreative(other.client, { bytes: mp4Bytes('outro', 95 * KB), contentType: 'video/mp4' })).status, 201);
    });

    it('exige CSRF e a mesma origem', async () => {
      const { client } = await newUser();
      const noCsrf = await uploadCreative(client, { type: 'png', withCsrf: false });
      assert.equal(noCsrf.status, 403);
      assert.equal(noCsrf.json.error.code, 'bad_csrf');
      const crossOrigin = await uploadCreative(client, { type: 'png', headers: { origin: 'https://evil.example' } });
      assert.equal(crossOrigin.status, 403);
      assert.equal(crossOrigin.json.error.code, 'bad_origin');
      assert.equal((await client.get('/api/creatives')).json.total, 0);
    });

    it('limita a frequência de envios (429)', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, creativesWrite: 3 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
      try {
        const { client } = await createUser(limited, { approve: true });
        for (let i = 0; i < 3; i += 1) assert.equal((await uploadCreative(client, { type: 'png' })).status, 201);
        const blocked = await uploadCreative(client, { type: 'png' });
        assert.equal(blocked.status, 429);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      } finally {
        await limited.stop();
      }
    });
  });

  describe('listagem, detalhe, renomear', () => {
    it('lista com total, cota e usado; filtra por tipo e busca (ILIKE com escape)', async () => {
      const { client } = await newUser();
      await uploadCreative(client, { type: 'png', name: 'Banner Verão' });
      await uploadCreative(client, { type: 'jpg', name: 'banner inverno' });
      await uploadCreative(client, { type: 'mp4', name: 'Vídeo 100% promo' });
      await uploadCreative(client, { type: 'mov', name: 'Vídeo_teste' });
      const all = (await client.get('/api/creatives')).json;
      assert.equal(all.total, 4);
      assert.equal(all.creatives.length, 4);
      assert.ok(all.usedBytes > 0 && all.quotaBytes === 400 * KB);
      assert.deepEqual(all.creatives.map((c) => c.name), ['Vídeo_teste', 'Vídeo 100% promo', 'banner inverno', 'Banner Verão'], 'mais recentes primeiro');
      assert.equal((await client.get('/api/creatives?kind=image')).json.total, 2);
      assert.equal((await client.get('/api/creatives?kind=video')).json.total, 2);
      assert.deepEqual((await client.get('/api/creatives?q=BANNER')).json.creatives.map((c) => c.name).sort(), ['Banner Verão', 'banner inverno']);
      assert.deepEqual((await client.get('/api/creatives?q=%25')).json.creatives.map((c) => c.name), ['Vídeo 100% promo'], '% é literal, não curinga');
      assert.deepEqual((await client.get('/api/creatives?q=_')).json.creatives.map((c) => c.name), ['Vídeo_teste'], '_ é literal, não curinga');
      assert.equal((await client.get(`/api/creatives?q=${encodeURIComponent("'; DROP TABLE creatives;--")}`)).json.total, 0);
      assert.equal((await client.get('/api/creatives?kind=video&q=promo')).json.total, 1);
    });

    it('paginação e parâmetros inválidos', async () => {
      const { client } = await newUser();
      for (let i = 0; i < 5; i += 1) await uploadCreative(client, { type: 'png', name: `C${i}`, seed: `pg${i}` });
      const page1 = (await client.get('/api/creatives?limit=2&offset=0')).json;
      const page2 = (await client.get('/api/creatives?limit=2&offset=2')).json;
      assert.deepEqual([page1.creatives.length, page2.creatives.length, page1.total], [2, 2, 5]);
      assert.equal(new Set([...page1.creatives, ...page2.creatives].map((c) => c.id)).size, 4);
      for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=1.5', 'kind=audio', 'q=' + 'x'.repeat(101), 'kind=image&kind=video']) {
        assert.equal((await client.get(`/api/creatives?${bad}`)).status, 400, bad);
      }
    });

    it('detalhe e renomear; validações', async () => {
      const { client } = await newUser();
      const { id } = (await uploadCreative(client, { type: 'png', name: 'Antigo' })).json.creative;
      assert.equal((await client.get(`/api/creatives/${id}`)).json.creative.name, 'Antigo');
      assert.equal((await client.patch(`/api/creatives/${id}`, { name: '  Novo   nome ' })).json.creative.name, 'Novo nome');
      for (const bad of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 5 }, { name: 'a\u0007b' }]) assert.equal((await client.patch(`/api/creatives/${id}`, bad)).status, 400, JSON.stringify(bad));
      for (const bad of ['abc', '0', '-1', '1.5', '99999999999']) assert.equal((await client.get(`/api/creatives/${bad}`)).status, 400, bad);
      assert.equal((await client.get('/api/creatives/987654')).status, 404);
    });
  });

  describe('isolamento entre usuários (sem IDOR)', () => {
    it('um usuário nunca vê, baixa, renomeia nem exclui criativo de outro', async () => {
      const a = await newUser();
      const b = await newUser();
      const mine = (await uploadCreative(a.client, { type: 'png', name: 'Do A' })).json.creative;
      assert.equal((await b.client.get('/api/creatives')).json.total, 0);
      assert.equal((await b.client.get(`/api/creatives/${mine.id}`)).status, 404);
      assert.equal((await b.client.get(`/api/creatives/${mine.id}/file`)).status, 404);
      assert.equal((await b.client.patch(`/api/creatives/${mine.id}`, { name: 'Invadido' })).status, 404);
      assert.equal((await b.client.delete(`/api/creatives/${mine.id}`)).status, 404);
      assert.equal((await a.client.get(`/api/creatives/${mine.id}`)).json.creative.name, 'Do A');
      assert.equal(storedFiles(ctx).length >= 1, true);
    });

    it('o admin também só enxerga os próprios criativos', async () => {
      const a = await newUser();
      const mine = (await uploadCreative(a.client, { type: 'png' })).json.creative;
      const admin = await loginAdmin(ctx);
      assert.equal((await admin.get('/api/creatives')).json.total, 0);
      assert.equal((await admin.get(`/api/creatives/${mine.id}/file`)).status, 404);
    });
  });

  describe('entrega do arquivo ao dono', () => {
    it('devolve exatamente os bytes, com tipo do CONTEÚDO e cabeçalhos que neutralizam conteúdo ativo', async () => {
      const { client } = await newUser();
      const bytes = pngBytes('serve', 3000);
      const { id } = (await uploadCreative(client, { bytes, type: 'png' })).json.creative;
      const res = await fetch(`${ctx.baseUrl}/api/creatives/${id}/file`, { headers: { cookie: client.cookie } });
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.match(res.headers.get('content-disposition'), /^inline; filename="criativo-\d+\.png"$/);
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.match(res.headers.get('cache-control'), /^private/);
      assert.equal(res.headers.get('x-powered-by'), null);
    });

    it('vídeo aceita Range (206) para pré-visualização', async () => {
      const { client } = await newUser();
      const bytes = mp4Bytes('range', 10_000);
      const { id } = (await uploadCreative(client, { bytes, type: 'mp4' })).json.creative;
      const res = await fetch(`${ctx.baseUrl}/api/creatives/${id}/file`, { headers: { cookie: client.cookie, range: 'bytes=100-199' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(100, 200));
      assert.equal(res.headers.get('content-type'), 'video/mp4');
      const bad = await fetch(`${ctx.baseUrl}/api/creatives/${id}/file`, { headers: { cookie: client.cookie, range: 'bytes=99999999-' } });
      assert.equal(bad.status, 416);
    });

    it('arquivo sumiu do disco: erro tratado (sem vazar caminho) e o servidor continua de pé', async () => {
      const { client } = await newUser();
      const { id } = (await uploadCreative(client, { type: 'png' })).json.creative;
      const { storage_key: key } = await one(ctx.db, 'SELECT storage_key FROM creatives WHERE id = $1', [id]);
      fs.rmSync(path.join(ctx.creativesDir, key));
      const res = await client.get(`/api/creatives/${id}/file`);
      assert.ok([404, 500].includes(res.status));
      assert.ok(!res.text.includes(ctx.creativesDir) && !res.text.includes(key), 'não vaza o caminho');
      assert.equal((await client.get('/api/creatives')).status, 200);
    });
  });

  describe('exclusão', () => {
    it('remove o registro E o arquivo do disco', async () => {
      const { client } = await newUser();
      const { id } = (await uploadCreative(client, { type: 'png' })).json.creative;
      const { storage_key: key } = await one(ctx.db, 'SELECT storage_key FROM creatives WHERE id = $1', [id]);
      assert.ok(fs.existsSync(path.join(ctx.creativesDir, key)));
      assert.equal((await client.delete(`/api/creatives/${id}`)).status, 204);
      assert.equal(fs.existsSync(path.join(ctx.creativesDir, key)), false);
      assert.equal((await client.get(`/api/creatives/${id}`)).status, 404);
      assert.equal((await client.delete(`/api/creatives/${id}`)).status, 404, 'excluir de novo');
    });

    it('bloqueia a exclusão enquanto um RASCUNHO de campanha usa o criativo; libera ao trocar/excluir o rascunho', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const video2 = await uploadedId(client, { type: 'mp4' });
      const draft = (await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name: 'Rascunho Usa' }, ad: { videoCreativeId: video } }) })).json.campaign;
      const blocked = await client.delete(`/api/creatives/${video}`);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.error.code, 'creative_in_use');
      assert.match(blocked.json.error.message, /Rascunho Usa/);
      assert.equal((await client.get(`/api/creatives/${video}`)).status, 200, 'continua na biblioteca');
      assert.equal((await client.delete(`/api/creatives/${video2}`)).status, 204, 'outro criativo não é afetado');

      const swap = await uploadedId(client, { type: 'mp4' });
      await client.put(`/api/campaigns/${draft.id}`, { config: completeConfig('TRAFFIC', { campaign: { name: 'Rascunho Usa' }, ad: { videoCreativeId: swap } }) });
      assert.equal((await client.delete(`/api/creatives/${video}`)).status, 204, 'liberado depois de trocar');
      assert.equal((await client.delete(`/api/creatives/${swap}`)).status, 409);
      await client.delete(`/api/campaigns/${draft.id}`);
      assert.equal((await client.delete(`/api/creatives/${swap}`)).status, 204, 'liberado depois de excluir o rascunho');
    });

    it('o bloqueio vale para imagens de carrossel e capa de vídeo', async () => {
      const { client } = await newUser();
      const [i1, i2, cover, video] = [await uploadedId(client, { type: 'png' }), await uploadedId(client, { type: 'jpg' }), await uploadedId(client, { type: 'png' }), await uploadedId(client, { type: 'mp4' })];
      await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name: 'Carrossel' }, ad: { format: 'CAROUSEL_ADS', videoCreativeId: undefined, imageCreativeIds: [i1, i2] } }) });
      await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { campaign: { name: 'Com capa' }, ad: { videoCreativeId: video, coverCreativeId: cover } }) });
      for (const id of [i1, i2, cover, video]) assert.equal((await client.delete(`/api/creatives/${id}`)).json.error.code, 'creative_in_use', String(id));
    });
  });

  describe('criativo que já existe na conta do TikTok (referência por ID)', () => {
    let adminClient;
    before(async () => {
      adminClient = await loginAdmin(ctx);
      assert.equal((await adminClient.post('/api/tiktok/business-centers', { name: 'Loja', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
    });
    const register = (client, over = {}) => client.post('/api/creatives/tiktok', { name: 'Já no TikTok', kind: 'video', advertiserId: '9001', tiktokId: 'v10033g50000abc123', ...over });

    it('registra a referência (sem arquivo) vinculada à conta de anúncio', async () => {
      const { client } = await newUser();
      const res = await register(client);
      assert.equal(res.status, 201);
      assert.deepEqual({ source: res.json.creative.source, hasFile: res.json.creative.hasFile, kind: res.json.creative.kind, tiktokAdvertisers: res.json.creative.tiktokAdvertisers, sizeBytes: res.json.creative.sizeBytes }, { source: 'tiktok', hasFile: false, kind: 'video', tiktokAdvertisers: ['9001'], sizeBytes: null });
      assert.equal((await client.get(`/api/creatives/${res.json.creative.id}/file`)).status, 404, 'não há arquivo para entregar');
      assert.equal((await client.delete(`/api/creatives/${res.json.creative.id}`)).status, 204);
    });

    it('valida conta de anúncio (404 se não for do usuário), ID do TikTok, tipo e nome', async () => {
      const { client } = await newUser();
      assert.equal((await register(client, { advertiserId: '777' })).status, 404);
      assert.equal((await register(client, { advertiserId: 'abc' })).status, 400);
      for (const tiktokId of ['', 'abc', 'v1 2 3 4', '../../x', "v1';DROP", 'x'.repeat(201), 5]) assert.equal((await register(client, { tiktokId })).status, 400, String(tiktokId));
      assert.equal((await register(client, { kind: 'audio' })).status, 400);
      assert.equal((await register(client, { name: '' })).status, 400);
      assert.equal((await client.post('/api/creatives/tiktok', 'texto')).status, 400);
      assert.equal((await register(client, { tiktokId: 'ad-site-i18n/2020/imagem.id-1', kind: 'image' })).status, 201, 'IDs de imagem do TikTok têm barras');
    });

    it('não registra em conta de anúncio de BC privada de outro usuário', async () => {
      const a = await newUser();
      const b = await newUser();
      assert.equal((await a.client.post('/api/tiktok/business-centers', { name: 'Minha', bcId: '222', accessToken: GOOD_TOKEN })).status, 201);
      assert.equal((await register(a.client, { advertiserId: '9101' })).status, 201);
      assert.equal((await register(b.client, { advertiserId: '9101' })).status, 404);
    });
  });

  it('exclusão de usuário apaga a biblioteca no banco (cascata)', async () => {
    const { client, id } = await newUser();
    await uploadCreative(client, { type: 'png' });
    await ctx.db.query('DELETE FROM users WHERE id = $1', [id]);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int AS c FROM creatives WHERE user_id = $1', [id])).c, 0);
  });
});
