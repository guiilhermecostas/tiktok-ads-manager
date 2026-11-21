import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCookies } from '../src/lib/cookies.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { RateLimiter } from '../src/lib/rate-limit.js';
import { parseCents, parseEmail, parseId, parseText } from '../src/lib/validation.js';

describe('password', () => {
  it('gera hashes diferentes (salt) e verifica corretamente', async () => {
    const a = await hashPassword('minha-senha-123');
    const b = await hashPassword('minha-senha-123');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('minha-senha-123', a), true);
    assert.equal(await verifyPassword('minha-senha-124', a), false);
  });
  it('rejeita formatos de hash inválidos sem lançar', async () => {
    assert.equal(await verifyPassword('x', ''), false);
    assert.equal(await verifyPassword('x', 'md5$abc'), false);
  });
});

describe('RateLimiter', () => {
  it('bloqueia após o limite e libera depois da janela', () => {
    const rl = new RateLimiter({ max: 2, windowMs: 1000 });
    try {
      assert.equal(rl.consume('k', 0).allowed, true);
      assert.equal(rl.consume('k', 100).allowed, true);
      const blocked = rl.consume('k', 200);
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.retryAfterSec, 1);
      assert.equal(rl.consume('outra', 200).allowed, true);
      assert.equal(rl.consume('k', 1001).allowed, true);
    } finally {
      rl.stop();
    }
  });
  it('sweep remove chaves expiradas (sem vazamento de memória)', () => {
    const rl = new RateLimiter({ max: 5, windowMs: 1000 });
    try {
      rl.consume('a', 0);
      rl.sweep(5000);
      assert.equal(rl.hits.size, 0);
    } finally {
      rl.stop();
    }
  });
});

describe('validation', () => {
  it('parseEmail normaliza e valida', () => {
    assert.equal(parseEmail('  Fulano@Exemplo.COM '), 'fulano@exemplo.com');
    for (const bad of ['', 'a@b', 'a b@c.com', null, 42, 'a@@b.com', `${'a'.repeat(300)}@x.com`]) {
      assert.throws(() => parseEmail(bad), { status: 400 }, String(bad));
    }
  });
  it('parseText limpa espaços e bloqueia controles', () => {
    assert.equal(parseText('  Ana   Maria ', 'Nome'), 'Ana Maria');
    assert.equal(parseText('', 'Empresa', { required: false }), null);
    assert.throws(() => parseText('a\u0007b', 'Nome'), { status: 400 });
    assert.throws(() => parseText('x', 'Nome'), { status: 400 });
  });
  it('parseId e parseCents', () => {
    assert.equal(parseId('12'), 12);
    assert.equal(parseId('2147483647'), 2_147_483_647, 'maior ID possível do banco');
    for (const bad of ['0', '-3', '1.5', 'abc', '', undefined, '9999999999999999999', '2147483648', '99999999999']) assert.throws(() => parseId(bad), { status: 400 }, String(bad));
    assert.equal(parseCents(0, 'x'), 0);
    assert.throws(() => parseCents(0.5, 'x'), { status: 400 });
  });
});

describe('cookies', () => {
  it('faz o parse e ignora lixo', () => {
    const c = parseCookies('a=1; tt_sid=abc%20def; broken; =x; q="v"');
    assert.equal(c.a, '1');
    assert.equal(c.tt_sid, 'abc def');
    assert.equal(c.q, 'v');
    assert.equal(Object.getPrototypeOf(c), null); // sem poluição de protótipo
    assert.deepEqual(parseCookies(undefined), Object.create(null));
    assert.doesNotThrow(() => parseCookies('x=%E0%A4%A'));
  });
});
