import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { niceMax, smoothPath } from '../public/js/charts.js';
import { buildInsights, percentChange } from '../shared/report-insights.js';

/** Números de um caminho "M x y C x1 y1 x2 y2 x y …". */
const numbers = (path) => path.match(/-?\d+(?:\.\d+)?/g).map(Number);
const segments = (path) => {
  const n = numbers(path);
  const out = [];
  for (let i = 2; i + 5 < n.length + 1; i += 6) out.push(n.slice(i, i + 6));
  return out;
};

describe('Gráficos: curva suave', () => {
  it('casos pequenos: vazio, 1 ponto, 2 pontos (reta)', () => {
    assert.equal(smoothPath([]), '');
    assert.equal(smoothPath([[10, 20]]), 'M10 20');
    assert.equal(smoothPath([[0, 10], [100, 50]]), 'M0 10L100 50');
  });

  it('passa por TODOS os pontos, com um segmento de Bézier entre cada par', () => {
    const points = [[0, 100], [50, 40], [100, 70], [150, 10], [200, 90]];
    const path = smoothPath(points);
    assert.ok(path.startsWith('M0 100C'));
    assert.equal((path.match(/C/g) ?? []).length, points.length - 1);
    const ends = segments(path).map((s) => [s[4], s[5]]);
    assert.deepEqual(ends, points.slice(1), 'cada segmento termina no ponto seguinte');
  });

  it('é MONÓTONA: sem "ondas" falsas (as curvas nunca passam acima/abaixo dos dois pontos vizinhos)', () => {
    const points = [[0, 10], [40, 10], [80, 12], [120, 90], [160, 92], [200, 92]]; // degrau: o tipo de dado que gera overshoot em splines comuns
    const segs = segments(smoothPath(points));
    segs.forEach((s, i) => {
      const [y0, y1] = [points[i][1], points[i + 1][1]];
      const lo = Math.min(y0, y1) - 0.01;
      const hi = Math.max(y0, y1) + 0.01;
      assert.ok(s[1] >= lo && s[1] <= hi && s[3] >= lo && s[3] <= hi, `segmento ${i}: controles ${s[1]}, ${s[3]} fora de [${lo}, ${hi}]`);
    });
  });

  it('série constante vira linha reta; extremos locais ficam planos (picos não "estouram")', () => {
    const flat = segments(smoothPath([[0, 50], [10, 50], [20, 50], [30, 50]]));
    assert.ok(flat.every((s) => s[1] === 50 && s[3] === 50 && s[5] === 50));
    const peak = segments(smoothPath([[0, 80], [50, 20], [100, 80]]));
    assert.equal(peak[0][3], 20, 'no pico a tangente é horizontal');
    assert.equal(peak[1][1], 20);
  });

  it('nunca gera NaN/Infinity (pontos repetidos no mesmo x, valores enormes)', () => {
    for (const points of [[[0, 1], [0, 5], [10, 2]], [[0, 1e12], [1, -1e12], [2, 3]], [[0, 0], [1, 0], [2, 0]]]) {
      assert.ok(!/NaN|Infinity/.test(smoothPath(points)));
    }
  });

  it('limite "bonito" do eixo: 1, 2, 2,5, 5 ou 10 vezes uma potência de 10, sempre acima do valor', () => {
    for (const [value, expected] of [[0, 1], [-3, 1], [0.7, 1], [1, 1], [1.1, 2], [2.4, 2.5], [4.2, 5], [7, 10], [13, 20], [180, 200], [4300, 5000], [99999, 100000]]) assert.equal(niceMax(value), expected, String(value));
    for (let v = 0.01; v < 1e6; v *= 1.7) assert.ok(niceMax(v) >= v);
  });
});

describe('Relatórios: variação e observações automáticas', () => {
  it('variação percentual: sem base (0/ausente) é null', () => {
    assert.equal(percentChange(110, 100), 10);
    assert.equal(percentChange(50, 100), -50);
    assert.equal(percentChange(0, 100), -100);
    for (const prev of [0, null, undefined]) assert.equal(percentChange(10, prev), null);
  });

  const FORMAT = { money: (v) => `R$ ${v}`, percent: (v) => `${v.toFixed(1)}%` };
  const day = (date, spend) => ({ date, spend, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0 });
  const baseGroup = (over = {}) => ({ currency: 'BRL', totals: { spend: 100, impressions: 1000, clicks: 50, conversions: 0, ctr: 5, cpc: 2 }, previous: { spend: 50, impressions: 800, clicks: 20, conversions: 1, ctr: 2.5, cpc: 2.5 }, daily: [day('2026-11-20', 10), day('2026-11-21', 70), day('2026-11-22', 20)], ...over });
  const data = (over = {}) => ({ failed: 0, analyzed: 2, totalAdvertisers: 2, accounts: [{ id: '1', name: 'Conta A', currency: 'BRL', totals: { spend: 80 } }, { id: '2', name: 'Conta B', currency: 'BRL', totals: { spend: 20 } }], ...over });

  it('destaca o dia de maior gasto, gasto sem conversão, variação do gasto/CTR e concentração em uma conta', () => {
    const notes = buildInsights({ group: baseGroup(), data: data(), metricsCurrency: 'BRL', format: FORMAT }).map((n) => n.text);
    assert.ok(notes.some((t) => t.includes('21/11') && t.includes('maior gasto')));
    assert.ok(notes.some((t) => /nenhuma conversão/.test(t)));
    assert.ok(notes.some((t) => /gasto subiu/.test(t)));
    assert.ok(notes.some((t) => /CTR melhorou/.test(t)));
    assert.ok(notes.some((t) => t.includes('"Conta A"') && /concentra/.test(t)));
  });

  it('sem gasto: só avisa que não houve; falhas e limite de contas aparecem', () => {
    const zero = buildInsights({ group: baseGroup({ totals: { spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpc: 0 } }), data: data(), metricsCurrency: 'BRL', format: FORMAT });
    assert.equal(zero.length, 1);
    assert.match(zero[0].text, /Nenhum gasto/);
    const partial = buildInsights({ group: baseGroup(), data: data({ failed: 2, analyzed: 1, totalAdvertisers: 5 }), metricsCurrency: 'BRL', format: FORMAT }).map((n) => n.text);
    assert.ok(partial.some((t) => /2 contas não puderam/.test(t)) && partial.some((t) => /primeiras 1 de 5/.test(t)));
  });
});
