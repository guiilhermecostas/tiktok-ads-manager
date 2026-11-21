import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { decrypt, encrypt, parseEncryptionKey } from '../src/lib/crypto.js';
import { TtlCache } from '../src/lib/ttl-cache.js';
import { sumTotals } from '../src/modules/tiktok/tiktok.client.js';

describe('crypto (AES-256-GCM)', () => {
  const key = randomBytes(32);
  it('cifra e decifra, com IV diferente a cada vez', () => {
    const a = encrypt('segredo', key);
    const b = encrypt('segredo', key);
    assert.notEqual(a, b);
    assert.ok(!a.includes('segredo'));
    assert.equal(decrypt(a, key), 'segredo');
    assert.equal(decrypt(encrypt('açúcar ✓', key), key), 'açúcar ✓');
  });
  it('detecta adulteração e formato inválido', () => {
    const parts = encrypt('segredo', key).split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('xxxxxxx').toString('base64url')].join('.');
    assert.throws(() => decrypt(tampered, key));
    assert.throws(() => decrypt('lixo', key));
    assert.throws(() => decrypt(encrypt('x', key), randomBytes(32)));
  });
  it('valida o tamanho da chave', () => {
    assert.equal(parseEncryptionKey(randomBytes(32).toString('base64')).length, 32);
    for (const bad of ['', 'curta', randomBytes(16).toString('base64'), undefined]) assert.throws(() => parseEncryptionKey(bad), /32 bytes/);
  });
});

describe('TtlCache', () => {
  it('expira entradas e respeita o limite', () => {
    const cache = new TtlCache({ ttlMs: 100, maxEntries: 2 });
    cache.set('a', 1, 0);
    assert.equal(cache.get('a', 50), 1);
    assert.equal(cache.get('a', 101), undefined);
    cache.set('x', 1, 0);
    cache.set('y', 2, 0);
    cache.set('z', 3, 0);
    assert.equal(cache.entries.size, 2);
    assert.equal(cache.get('x', 1), undefined, 'a mais antiga saiu');
  });
  it('remember executa o loader uma única vez', async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    let calls = 0;
    const load = async () => ++calls;
    assert.equal(await cache.remember('k', load), 1);
    assert.equal(await cache.remember('k', load), 1);
    assert.equal(calls, 1);
  });
});

describe('sumTotals', () => {
  it('soma e calcula CTR/CPC sem dividir por zero', () => {
    assert.deepEqual(sumTotals([]), { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0 });
    const t = sumTotals([{ spend: 10, impressions: 1000, clicks: 50, conversions: 1 }, { spend: 5, impressions: 1000, clicks: 50, conversions: 2 }]);
    assert.equal(t.spend, 15);
    assert.equal(t.ctr, 5);
    assert.equal(t.cpc, 0.15);
  });
});
