import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AVATAR_SIZE, MAX_AVATAR_OUTPUT_BYTES, createAvatarProcessor, readImageSize } from '../src/modules/profile/avatar-processor.js';
import { ffmpegPath, makeImage, probe, tempDir } from './real-media.js';

const dir = tempDir('avatar-test-');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** PNG mínimo só com a assinatura e o IHDR (o suficiente para o cabeçalho; NÃO é decodificável). */
function fakePngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}
/** JPEG com um bloco APPn grande (EXIF) antes do SOF0, como câmeras fazem. */
function fakeJpegHeader(width, height, { appBytes = 0, marker = 0xc0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (appBytes) {
    const app = Buffer.alloc(4 + appBytes);
    app[0] = 0xff;
    app[1] = 0xe1;
    app.writeUInt16BE(appBytes + 2, 2);
    parts.push(app);
  }
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = marker;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

describe('Foto de perfil: leitura do tamanho pelo cabeçalho', () => {
  it('PNG e JPEG (inclusive com EXIF grande antes do tamanho)', () => {
    assert.deepEqual(readImageSize(fakePngHeader(640, 480)), { width: 640, height: 480 });
    assert.deepEqual(readImageSize(fakeJpegHeader(1200, 900)), { width: 1200, height: 900 });
    assert.deepEqual(readImageSize(fakeJpegHeader(3000, 2000, { appBytes: 60_000 })), { width: 3000, height: 2000 });
    assert.deepEqual(readImageSize(fakeJpegHeader(300, 200, { marker: 0xc2 })), { width: 300, height: 200 }, 'JPEG progressivo (SOF2)');
  });

  it('arquivo truncado, vazio ou sem tamanho: null (nunca estoura)', () => {
    for (const bad of [Buffer.alloc(0), Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xd8, 0xff]), fakePngHeader(1, 1).subarray(0, 20), Buffer.from('GIF89a......'), Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]), fakeJpegHeader(10, 10).subarray(0, 8)]) {
      assert.equal(readImageSize(bad), null);
    }
    const loop = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0x00, 0x01]), Buffer.alloc(50)]); // tamanho de bloco inválido
    assert.equal(readImageSize(loop), null);
  });
});

describe('Foto de perfil: processamento com FFmpeg de verdade', () => {
  const processor = createAvatarProcessor({ ffmpegPath, tmpDir: dir });
  const decodeSize = (buffer) => {
    const file = path.join(dir, `saida-${Math.random().toString(16).slice(2)}.jpg`);
    fs.writeFileSync(file, buffer);
    const match = /Video: mjpeg[^\n]*?(\d{2,5})x(\d{2,5})/.exec(probe(file));
    return { width: Number(match[1]), height: Number(match[2]) };
  };

  it('qualquer proporção vira JPEG quadrado 256x256, sem metadados', async () => {
    const wide = makeImage(dir, { name: 'larga.png', width: 800, height: 200 });
    const tall = makeImage(dir, { name: 'alta.jpg', width: 150, height: 600 });
    const small = makeImage(dir, { name: 'pequena.png', width: 40, height: 40 });
    for (const [file, ext] of [[wide, 'png'], [tall, 'jpg'], [small, 'png']]) {
      const out = await processor.process(file, ext);
      assert.deepEqual([out[0], out[1]], [0xff, 0xd8], 'é JPEG');
      assert.deepEqual(decodeSize(out), { width: AVATAR_SIZE, height: AVATAR_SIZE }, path.basename(file));
      assert.ok(out.length > 100 && out.length <= MAX_AVATAR_OUTPUT_BYTES);
      assert.ok(!out.toString('latin1').includes('SEGREDO'), 'comentário do PNG original some');
    }
  });

  it('metadados do JPEG de origem (XMP, comentário) não passam para a foto guardada', async () => {
    const file = makeImage(dir, { name: 'com-metadados.jpg', width: 300, height: 300 });
    const original = fs.readFileSync(file).toString('latin1');
    assert.ok(/SEGREDO|xmpmeta|Comment|http:\/\/ns\.adobe\.com/i.test(original), 'o arquivo de teste realmente tem metadados');
    const out = (await processor.process(file, 'jpg')).toString('latin1');
    assert.ok(!/SEGREDO|xmpmeta|ns\.adobe\.com/i.test(out));
  });

  it('conteúdo extra colado depois da imagem (polyglot) não é copiado para a saída', async () => {
    const file = makeImage(dir, { name: 'polyglot.jpg', width: 200, height: 200 });
    fs.appendFileSync(file, '<script>alert("xss")</script><?php system($_GET["c"]); ?>');
    const out = (await processor.process(file, 'jpg')).toString('latin1');
    assert.ok(!out.includes('<script>') && !out.includes('<?php'));
  });

  it('o resultado muda se a imagem muda (recorte central de verdade)', async () => {
    const a = await processor.process(makeImage(dir, { name: 'azul.png', color: '0x0000ff' }), 'png');
    const b = await processor.process(makeImage(dir, { name: 'vermelha.png', color: '0xff0000' }), 'png');
    assert.notDeepEqual(a, b);
  });

  it('imagem com lado acima do limite é recusada ANTES de decodificar (422)', async () => {
    const file = path.join(dir, 'bomba.png');
    fs.writeFileSync(file, fakePngHeader(40_000, 40_000));
    await assert.rejects(() => processor.process(file, 'png'), (e) => e.status === 422 && e.code === 'invalid_image' && /grande demais/.test(e.message));
    const jpeg = path.join(dir, 'bomba.jpg');
    fs.writeFileSync(jpeg, fakeJpegHeader(65_000, 65_000));
    await assert.rejects(() => processor.process(jpeg, 'jpg'), (e) => e.status === 422);
    const edge = path.join(dir, 'limite.png');
    fs.writeFileSync(edge, fakePngHeader(4097, 10));
    await assert.rejects(() => processor.process(edge, 'png'), (e) => e.status === 422, '4097 já passa do limite');
  });

  it('arquivo corrompido (cabeçalho válido, dados lixo), vazio ou truncado: 422 sem vazar detalhes do FFmpeg', async () => {
    const garbage = path.join(dir, 'lixo.jpg');
    fs.writeFileSync(garbage, Buffer.concat([fakeJpegHeader(100, 100), Buffer.alloc(500, 7)]));
    const empty = path.join(dir, 'vazio.png');
    fs.writeFileSync(empty, '');
    const truncated = path.join(dir, 'truncado.png');
    fs.writeFileSync(truncated, fakePngHeader(100, 100));
    for (const [file, ext] of [[garbage, 'jpg'], [empty, 'png'], [truncated, 'png']]) {
      await assert.rejects(() => processor.process(file, ext), (e) => e.status === 422 && !/ffmpeg|Invalid|\/tmp/i.test(e.message), path.basename(file));
    }
  });

  it('sem FFmpeg: 503 claro; processador marca-se como indisponível', async () => {
    const off = createAvatarProcessor({ ffmpegPath: null, tmpDir: dir });
    assert.equal(off.available, false);
    await assert.rejects(() => off.process(path.join(dir, 'x.png'), 'png'), (e) => e.status === 503 && e.code === 'avatar_unavailable');
  });

  it('não deixa arquivos temporários para trás (nem em erro)', async () => {
    const before = fs.readdirSync(dir).filter((n) => n.startsWith('avatar-'));
    await processor.process(makeImage(dir, { name: 'limpa.png' }), 'png');
    await assert.rejects(() => processor.process(path.join(dir, 'lixo.jpg'), 'jpg'));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('avatar-')), before);
  });

  it('várias conversões ao mesmo tempo terminam (fila de concorrência) e dão resultados válidos', async () => {
    const files = Array.from({ length: 6 }, (_, i) => makeImage(dir, { name: `par${i}.png`, color: `0x${(i * 40 + 20).toString(16).padStart(2, '0')}8040` }));
    const results = await Promise.all(files.map((f) => processor.process(f, 'png')));
    assert.ok(results.every((r) => r[0] === 0xff && r[1] === 0xd8));
  });
});
