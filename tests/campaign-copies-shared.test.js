import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAMPAIGN_NAME_MAX, MAX_COPIES, MAX_PUBLICATIONS_PER_RUN, copyNames, maxCopiesFor, normalizeCopies } from '../shared/campaign-copies.js';

describe('Várias campanhas iguais por conta (regras compartilhadas)', () => {
  it('os limites: 10 cópias por conta e 60 campanhas por rodada', () => {
    assert.equal(MAX_COPIES, 10);
    assert.equal(MAX_PUBLICATIONS_PER_RUN, 60);
    assert.equal(CAMPAIGN_NAME_MAX, 100);
  });

  it('com uma cópia o nome fica como está; com várias, ganha número de dois dígitos', () => {
    assert.deepEqual(copyNames('Black Friday', 1), ['Black Friday']);
    assert.deepEqual(copyNames('  Black Friday  ', 3), ['Black Friday 01', 'Black Friday 02', 'Black Friday 03']);
    assert.deepEqual(copyNames('X', 10).slice(-2), ['X 09', 'X 10']);
    for (const bad of [0, -1, 1.5, NaN, undefined, null, '3']) assert.deepEqual(copyNames('Nome', bad), ['Nome'], String(bad));
  });

  it('os nomes das cópias cabem em 100 caracteres (corta o começo do nome, nunca o número) e são todos diferentes', () => {
    const names = copyNames('x'.repeat(150), 10);
    assert.equal(new Set(names).size, 10);
    for (const name of names) assert.ok(name.length <= CAMPAIGN_NAME_MAX, `${name.length}`);
    assert.ok(names[9].endsWith(' 10') && names[0].endsWith(' 01'));
    assert.equal(copyNames('', 2)[0], '01', 'sem nome base: só o número, sem espaço sobrando');
  });

  it('o teto da rodada: cabem menos cópias quando há muitas contas (60 ÷ contas), de 1 a 10', () => {
    assert.equal(maxCopiesFor(1), 10);
    assert.equal(maxCopiesFor(6), 10);
    assert.equal(maxCopiesFor(7), 8);
    assert.equal(maxCopiesFor(12), 5);
    assert.equal(maxCopiesFor(30), 2);
    assert.equal(maxCopiesFor(60), 1);
    assert.equal(maxCopiesFor(500), 1, 'nunca menos de 1');
    assert.equal(maxCopiesFor(0), 10, 'sem conta escolhida: o máximo por conta');
  });

  it('quantidade válida: inteiro de 1 a 10; qualquer outra coisa é recusada', () => {
    for (const ok of [1, 5, 10]) assert.equal(normalizeCopies(ok), ok);
    for (const bad of [0, 11, -3, 2.5, '5', null, undefined, NaN, Infinity, [], {}]) assert.equal(normalizeCopies(bad), null, String(bad));
  });
});
