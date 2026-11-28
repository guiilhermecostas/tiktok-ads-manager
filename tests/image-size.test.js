import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageInfo } from '../src/lib/image-size.js';
import { jpegWithSize as jpeg, pngWithSize as png } from './media-fixtures.js';

describe('imageInfo (tipo e tamanho lidos do cabeçalho)', () => {
  it('PNG: largura e altura do bloco IHDR', () => {
    assert.deepEqual(imageInfo(png(512, 512)), { type: 'png', width: 512, height: 512 });
    assert.deepEqual(imageInfo(png(300, 200)), { type: 'png', width: 300, height: 200 });
  });

  it('JPEG: acha o quadro depois de outros segmentos (baseline e progressivo)', () => {
    assert.deepEqual(imageInfo(jpeg(640, 640)), { type: 'jpeg', width: 640, height: 640 });
    assert.deepEqual(imageInfo(jpeg(800, 600, { sof: 0xc2 })), { type: 'jpeg', width: 800, height: 600 });
  });

  it('o que não é JPEG nem PNG (ou está truncado/corrompido) devolve null, sem lançar erro', () => {
    for (const bad of [null, undefined, 'texto', Buffer.alloc(0), Buffer.from('GIF89a......'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), png(0, 10), png(10, 0)]) assert.equal(imageInfo(bad), null);
    assert.equal(imageInfo(png(10, 10).subarray(0, 20)), null, 'PNG cortado');
    assert.equal(imageInfo(jpeg(10, 10).subarray(0, 12)), null, 'JPEG cortado');
    assert.equal(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00])), null, 'JPEG sem quadro');
    const loop = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]); // segmento com tamanho 0: não pode travar
    assert.equal(imageInfo(loop), null);
  });
});
