import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BULK_NAME_MAX, MAX_BULK_PRODUCTS, generateProducts, previewProduct, skuBase } from '../shared/catalog-bulk.js';
import { MAX_PRODUCTS_PER_REQUEST, normalizeProduct, toBatches } from '../shared/catalog.js';

const INPUT = { name: '05 - US - Dezy Agência', count: '300', price: '27', brand: 'Generic', description: '', imageUrl: 'https://loja.example/img.jpg', landingPageUrl: 'https://loja.example/oferta?a=1&b=2' };
const TAG = 'abc12345';

describe('Geração de produtos em lote: regras compartilhadas', () => {
  it('gera exatamente a quantidade pedida, todos válidos, com SKU único e título numerado', () => {
    const { products, errors } = generateProducts(INPUT, TAG);
    assert.deepEqual(errors, []);
    assert.equal(products.length, 300);
    assert.equal(new Set(products.map((p) => p.skuId)).size, 300, 'SKUs diferentes');
    assert.equal(products[0].skuId, `05-US-DEZY-AGENCIA-${TAG}-1`);
    assert.equal(products[0].title, '05 - US - Dezy Agência · 1');
    assert.equal(products[299].title, '05 - US - Dezy Agência · 300');
    for (const p of products) {
      assert.deepEqual(normalizeProduct(p).errors, [], p.skuId);
      assert.equal(p.price, 27);
      assert.equal(p.brand, 'Generic');
      assert.equal(p.availability, 'IN_STOCK');
      assert.equal(p.condition, 'NEW');
      assert.equal(p.landingPageUrl, INPUT.landingPageUrl, 'o link vai exatamente como foi informado');
    }
  });

  it('descrição em branco usa o nome base; descrição informada é mantida', () => {
    assert.equal(generateProducts({ ...INPUT, count: 1 }, TAG).products[0].description, INPUT.name);
    assert.equal(generateProducts({ ...INPUT, count: 1, description: 'Texto padrão.' }, TAG).products[0].description, 'Texto padrão.');
  });

  it('"numerar a partir de" continua a numeração; sufixos diferentes nunca repetem SKU', () => {
    const second = generateProducts({ ...INPUT, count: 3, startAt: '301' }, 'zzzz9999').products;
    assert.deepEqual(second.map((p) => p.title.split(' · ')[1]), ['301', '302', '303']);
    const first = generateProducts({ ...INPUT, count: 3 }, TAG).products;
    assert.equal(new Set([...first, ...second].map((p) => p.skuId)).size, 6);
    assert.equal(generateProducts({ ...INPUT, count: 2, startAt: '0' }, TAG).products[0].title.endsWith('· 0'), true);
  });

  it('quantidade: de 1 a 5.000, só inteiros', () => {
    assert.equal(generateProducts({ ...INPUT, count: String(MAX_BULK_PRODUCTS) }, TAG).products.length, MAX_BULK_PRODUCTS);
    for (const count of ['', '0', '-1', '5001', '1.5', '1e3', 'abc', ' ', null, undefined, 10 ** 9, '100000', {}, []]) {
      const { products, errors } = generateProducts({ ...INPUT, count }, TAG);
      assert.deepEqual([products.length, errors[0]?.path], [0, 'count'], JSON.stringify(count));
    }
    assert.equal(generateProducts({ ...INPUT, count: 25 }, TAG).products.length, 25, 'número também vale');
  });

  it('erros saem no campo certo: nome, preço, marca, imagem, link, descrição enorme e numeração', () => {
    const cases = [
      [{ name: '' }, 'name'], [{ name: '   ' }, 'name'], [{ name: 'a'.repeat(BULK_NAME_MAX + 1) }, 'name'], [{ name: 'Oferta 😀' }, 'name'], [{ name: 42 }, 'name'],
      [{ price: '' }, 'price'], [{ price: '0' }, 'price'], [{ price: '-5' }, 'price'], [{ price: 'abc' }, 'price'],
      [{ brand: '' }, 'brand'], [{ brand: 'x'.repeat(151) }, 'brand'],
      [{ imageUrl: '' }, 'imageUrl'], [{ imageUrl: 'ftp://x/y.jpg' }, 'imageUrl'], [{ imageUrl: 'javascript:alert(1)' }, 'imageUrl'],
      [{ landingPageUrl: '' }, 'landingPageUrl'], [{ landingPageUrl: 'loja.example/oferta' }, 'landingPageUrl'], [{ landingPageUrl: 'https://user:pass@loja.example/' }, 'landingPageUrl'], [{ landingPageUrl: 'https://loja.example/a b' }, 'landingPageUrl'],
      [{ description: 'd'.repeat(10_001) }, 'description'], [{ startAt: '-2' }, 'startAt'], [{ startAt: 'x' }, 'startAt'],
    ];
    for (const [patch, path] of cases) {
      const { products, errors } = generateProducts({ ...INPUT, ...patch }, TAG);
      assert.equal(products.length, 0, JSON.stringify(patch));
      assert.equal(errors[0]?.path, path, JSON.stringify(patch));
      assert.ok(errors[0].message.length > 3);
    }
    assert.equal(generateProducts(null, TAG).products.length, 0);
    assert.equal(generateProducts([], TAG).errors[0].path, 'name');
  });

  it('o sufixo da geração é obrigatório e restrito (nada de caracteres estranhos no SKU)', () => {
    for (const tag of [undefined, '', 'ab', 'AB CD', 'abc-123', '../etc', 'x'.repeat(13), 5]) {
      assert.equal(generateProducts({ ...INPUT, count: 1 }, tag).errors[0]?.path, 'tag', String(tag));
    }
  });

  it('SKU fica dentro de 100 caracteres mesmo com nome longo e numeração alta; sem acento nem emoji', () => {
    const { products, errors } = generateProducts({ ...INPUT, name: 'Á'.repeat(BULK_NAME_MAX), count: 3, startAt: '99999' }, 'abcdef123456');
    assert.deepEqual(errors, []);
    assert.ok(products.every((p) => p.skuId.length <= 100 && /^[A-Za-z0-9-]+$/.test(p.skuId)));
    assert.equal(skuBase('  Ôferta!!  Ação--Já  '), 'OFERTA-ACAO-JA');
    assert.equal(skuBase('😀 !!!'), 'PRODUTO');
    assert.equal(skuBase(undefined), 'PRODUTO');
  });

  it('prévia: mostra o exemplo sem exigir os demais campos', () => {
    assert.deepEqual(previewProduct('Oferta', '7'), { title: 'Oferta · 7', skuId: 'OFERTA-…-7' });
    assert.equal(previewProduct('Oferta', '').title, 'Oferta · 1');
    assert.equal(previewProduct('', '1'), null);
    assert.equal(previewProduct('a'.repeat(BULK_NAME_MAX + 1), '1'), null);
    assert.equal(previewProduct(7, '1'), null);
  });

  it('5.000 produtos viram lotes de até 500 e nenhum lote passa do limite de bytes', () => {
    const { products } = generateProducts({ ...INPUT, count: MAX_BULK_PRODUCTS, description: 'd'.repeat(2000) }, TAG);
    const batches = toBatches(products);
    assert.equal(batches.flat().length, MAX_BULK_PRODUCTS);
    assert.ok(batches.every((b) => b.length <= MAX_PRODUCTS_PER_REQUEST && JSON.stringify(b).length <= 1_500_000 + 3000));
    assert.deepEqual(batches.flat().map((p) => p.skuId), products.map((p) => p.skuId), 'mantém a ordem');
  });
});
