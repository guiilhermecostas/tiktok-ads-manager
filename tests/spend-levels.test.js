import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEVELS, MAX_LEVEL, TOP_AMOUNT, computeLevel, formatUsdShort, ladder, levelRange } from '../shared/spend-levels.js';

describe('Níveis de gasto em anúncios', () => {
  it('são 13 níveis, de US$ 0 a US$ 100 milhões, exatamente nas faixas pedidas, sem buraco nem sobreposição', () => {
    assert.equal(LEVELS.length, 13);
    assert.equal(MAX_LEVEL, 13);
    assert.deepEqual(LEVELS.map((l) => [l.from, l.to]), [
      [0, 1_000], [1_000, 10_000], [10_000, 50_000], [50_000, 100_000], [100_000, 250_000], [250_000, 500_000], [500_000, 1_000_000],
      [1_000_000, 2_500_000], [2_500_000, 5_000_000], [5_000_000, 10_000_000], [10_000_000, 20_000_000], [20_000_000, 50_000_000], [50_000_000, 100_000_000],
    ]);
    LEVELS.forEach((level, i) => {
      assert.equal(level.n, i + 1);
      if (i) assert.equal(level.from, LEVELS[i - 1].to, 'cada nível começa onde o anterior termina');
    });
    assert.equal(TOP_AMOUNT, 100_000_000);
    assert.ok(Object.isFrozen(LEVELS));
  });

  it('cada nível tem nome, frase de incentivo e uma cor própria (a barra muda de cor a cada nível)', () => {
    assert.equal(new Set(LEVELS.map((l) => l.color)).size, 13, 'nenhuma cor repetida');
    assert.equal(new Set(LEVELS.map((l) => l.name)).size, 13, 'nenhum nome repetido');
    for (const level of LEVELS) {
      assert.match(level.color, /^#[0-9a-f]{6}$/i);
      assert.ok(level.name.length >= 4 && level.message.length >= 20, level.name);
    }
    assert.equal(LEVELS[0].name, 'Iniciante');
    assert.equal(LEVELS[12].name, 'Imperador');
  });

  it('o nível sai do gasto: limites exatos pertencem ao nível de cima (US$ 1.000 já é o nível 2)', () => {
    const levelOf = (v) => computeLevel(v).level.n;
    assert.deepEqual([0, 1, 999.99, 1_000, 9_999.99, 10_000, 49_999, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000].map(levelOf), [1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.equal(levelOf(99_999_999), 13);
  });

  it('o progresso dentro do nível, o que falta e o próximo nível estão certos', () => {
    const half = computeLevel(5_500); // metade do nível 2 (1.000 a 10.000)
    assert.equal(half.level.n, 2);
    assert.equal(half.progress, 0.5);
    assert.equal(half.remaining, 4_500);
    assert.equal(half.next.n, 3);
    assert.equal(half.isMax, false);
    const start = computeLevel(10_000);
    assert.deepEqual([start.level.n, start.progress, start.remaining], [3, 0, 40_000]);
    const zero = computeLevel(0);
    assert.deepEqual([zero.level.n, zero.progress, zero.remaining, zero.next.n], [1, 0, 1_000, 2]);
  });

  it('o último nível enche até US$ 100 milhões e, passando disso, fica completo (sem próximo nível)', () => {
    const near = computeLevel(75_000_000);
    assert.deepEqual([near.level.n, near.progress, near.isMax, near.next], [13, 0.5, true, null]);
    assert.equal(near.remaining, 25_000_000);
    const done = computeLevel(250_000_000);
    assert.deepEqual([done.level.n, done.progress, done.isMax, done.remaining], [13, 1, true, 0]);
  });

  it('valor estranho nunca quebra: negativo, texto, nulo, infinito e NaN contam como zero', () => {
    for (const bad of [-5, NaN, Infinity, -Infinity, null, undefined, '1000', {}, []]) {
      const out = computeLevel(bad);
      assert.deepEqual([out.level.n, out.progress, out.spendUsd], [1, 0, 0], String(bad));
    }
  });

  it('a escada mostra os degraus vencidos, o atual e os que faltam', () => {
    const steps = ladder(4);
    assert.equal(steps.length, 13);
    assert.deepEqual(steps.map((s) => s.state), ['done', 'done', 'done', 'current', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    assert.deepEqual(ladder(1).map((s) => s.state).slice(0, 2), ['current', 'todo']);
    assert.ok(ladder(13).slice(0, 12).every((s) => s.state === 'done') && ladder(13)[12].state === 'current');
  });

  it('valores em dólar legíveis (em português) e a faixa de cada nível', () => {
    assert.deepEqual([0, 500, 999, 1_000, 10_000, 12_500, 250_000, 1_000_000, 2_500_000, 100_000_000].map(formatUsdShort), ['US$ 0', 'US$ 500', 'US$ 999', 'US$ 1 mil', 'US$ 10 mil', 'US$ 12,5 mil', 'US$ 250 mil', 'US$ 1 mi', 'US$ 2,5 mi', 'US$ 100 mi']);
    assert.equal(levelRange(LEVELS[2]), 'US$ 10 mil a US$ 50 mil');
    assert.equal(levelRange(LEVELS[12]), 'US$ 50 mi a US$ 100 mi');
  });
});
