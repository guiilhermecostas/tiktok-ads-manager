import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { createLocalCreativeStorage } from '../src/modules/creatives/creative-storage.js';
import { DECLARED_TYPES, SNIFF_BYTES, sniffCreativeType } from '../src/modules/creatives/creative-types.js';
import { jpegBytes, mp4Bytes, movBytes, pngBytes } from './media-fixtures.js';

describe('detecção do tipo pelo CONTEÚDO do arquivo', () => {
  const head = (buffer) => buffer.subarray(0, SNIFF_BYTES);

  it('reconhece JPEG, PNG, MP4 e MOV', () => {
    assert.deepEqual(sniffCreativeType(head(jpegBytes())), { kind: 'image', mime: 'image/jpeg', ext: 'jpg' });
    assert.deepEqual(sniffCreativeType(head(pngBytes())), { kind: 'image', mime: 'image/png', ext: 'png' });
    assert.deepEqual(sniffCreativeType(head(mp4Bytes())), { kind: 'video', mime: 'video/mp4', ext: 'mp4' });
    assert.deepEqual(sniffCreativeType(head(movBytes())), { kind: 'video', mime: 'video/quicktime', ext: 'mov' });
  });

  it('aceita as marcas de vídeo do contêiner ISO (mp41, mp42, avc1, M4V…)', () => {
    for (const brand of ['mp41', 'mp42', 'avc1', 'M4V ', 'isom', 'iso2']) {
      const buf = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(8)]);
      assert.equal(sniffCreativeType(buf)?.kind, 'video', brand);
    }
  });

  it('recusa tipos perigosos ou não suportados, mesmo que o nome/Content-Type digam outra coisa', () => {
    const cases = {
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'),
      html: Buffer.from('<!doctype html><script>alert(1)</script>'),
      htmlComImagem: Buffer.from('<html><body><img src=x onerror=alert(1)>'),
      gif: Buffer.from('GIF89a\u0001\u0000\u0001\u0000'),
      pdf: Buffer.from('%PDF-1.7\n'),
      webp: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
      exe: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
      zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
      heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]), // imagem HEIC usa o mesmo contêiner do MP4
      avif: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif'), Buffer.alloc(8)]),
      mif1: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmif1'), Buffer.alloc(8)]),
      vazio: Buffer.alloc(0),
      curto: Buffer.from([0xff, 0xd8]),
      truncadoPng: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      ftypTruncado: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
    };
    for (const [name, buffer] of Object.entries(cases)) assert.equal(sniffCreativeType(buffer), null, name);
  });

  it('o Content-Type declarado só aceita os 4 tipos suportados', () => {
    assert.deepEqual(Object.keys(DECLARED_TYPES).sort(), ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime']);
    for (const bad of ['image/svg+xml', 'text/html', 'image/gif', 'application/octet-stream', 'image/webp', 'application/pdf']) assert.equal(DECLARED_TYPES[bad], undefined, bad);
  });
});

describe('armazenamento local de criativos', () => {
  let dir;
  let storage;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-storage-'));
    storage = createLocalCreativeStorage({ dir: path.join(dir, 'criativos') });
    await storage.init();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mode = (target) => (fs.statSync(target).mode & 0o777).toString(8);

  it('init cria as pastas privadas (0700)', () => {
    assert.equal(mode(storage.base), '700');
    assert.equal(mode(path.join(storage.base, '.tmp')), '700');
  });

  it('receive grava no temporário calculando tamanho, SHA-256, MD5 e guardando os primeiros bytes', async () => {
    const data = pngBytes('s1', 5000);
    const temp = storage.tempPath();
    assert.ok(temp.startsWith(path.join(storage.base, '.tmp')));
    const result = await storage.receive(Readable.from([data.subarray(0, 100), data.subarray(100, 2000), data.subarray(2000)]), temp, { maxBytes: 1_000_000 });
    assert.equal(result.size, data.length);
    assert.equal(result.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(result.md5, createHash('md5').update(data).digest('hex'));
    assert.deepEqual(result.head, data.subarray(0, SNIFF_BYTES));
    assert.deepEqual(fs.readFileSync(temp), data);
    assert.equal(mode(temp), '600');
    await storage.removeTemp(temp);
    assert.equal(fs.existsSync(temp), false);
  });

  it('os primeiros bytes são capturados mesmo quando o 1º pedaço é minúsculo', async () => {
    const data = mp4Bytes('s2', 200);
    const temp = storage.tempPath();
    const pieces = Array.from({ length: Math.ceil(data.length / 3) }, (_, i) => data.subarray(i * 3, i * 3 + 3));
    const result = await storage.receive(Readable.from(pieces), temp, { maxBytes: 10_000 });
    assert.deepEqual(result.head, data.subarray(0, SNIFF_BYTES));
    await storage.removeTemp(temp);
  });

  it('interrompe ao passar do limite (413) e não deixa de contar pedaços grandes', async () => {
    const temp = storage.tempPath();
    await assert.rejects(
      () => storage.receive(Readable.from([randomBytes(600), randomBytes(600)]), temp, { maxBytes: 1000 }),
      (err) => err.status === 413 && err.code === 'file_too_large',
    );
    await storage.removeTemp(temp);
    // exatamente no limite passa
    const ok = storage.tempPath();
    assert.equal((await storage.receive(Readable.from([randomBytes(1000)]), ok, { maxBytes: 1000 })).size, 1000);
    await storage.removeTemp(ok);
  });

  it('commit usa nome ALEATÓRIO por usuário, com pastas 0700 e arquivo 0600', async () => {
    const temp = storage.tempPath();
    await storage.receive(Readable.from([jpegBytes('s3')]), temp, { maxBytes: 100_000 });
    const key = await storage.commit(temp, 42, 'jpg');
    assert.match(key, /^42\/[a-f0-9]{32}\.jpg$/);
    const file = storage.pathFor(key);
    assert.ok(fs.existsSync(file));
    assert.equal(fs.existsSync(temp), false, 'o temporário foi movido');
    assert.equal(mode(file), '600');
    assert.equal(mode(path.dirname(file)), '700');
    const other = storage.tempPath();
    await storage.receive(Readable.from([jpegBytes('s3')]), other, { maxBytes: 100_000 });
    assert.notEqual(await storage.commit(other, 42, 'jpg'), key, 'mesmo conteúdo, chaves diferentes');
  });

  it('pathFor recusa qualquer chave fora do formato (path traversal, absoluto, extensão estranha)', () => {
    for (const bad of ['../x.jpg', '1/../../etc/passwd', '/etc/passwd', '1/abc.jpg', '1/' + 'a'.repeat(32) + '.exe', '1/' + 'A'.repeat(32) + '.jpg', '1/' + 'a'.repeat(32) + '.jpg/../../x', '', null, undefined, 42, '1/' + 'a'.repeat(32) + '.jpg\0', '..%2f..%2fx', 'x/' + 'a'.repeat(32) + '.jpg', '12345678901/' + 'a'.repeat(32) + '.jpg']) {
      assert.throws(() => storage.pathFor(bad), /inválida|fora da pasta/, String(bad));
    }
    assert.ok(storage.pathFor('7/' + 'a'.repeat(32) + '.mov').startsWith(storage.base + path.sep));
  });

  it('remove apaga o arquivo e tolera arquivo que já não existe', async () => {
    const temp = storage.tempPath();
    await storage.receive(Readable.from([pngBytes('s4')]), temp, { maxBytes: 100_000 });
    const key = await storage.commit(temp, 9, 'png');
    await storage.remove(key);
    assert.equal(fs.existsSync(storage.pathFor(key)), false);
    await assert.doesNotReject(() => storage.remove(key));
  });

  it('init apaga temporários ANTIGOS (>1 h) e preserva os recentes', async () => {
    const tmp = path.join(storage.base, '.tmp');
    const old = path.join(tmp, 'antigo.part');
    const recent = path.join(tmp, 'recente.part');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(recent, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    await storage.init();
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
  });
});
