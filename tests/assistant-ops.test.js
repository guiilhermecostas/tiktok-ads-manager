import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountsThatDropped, bestByCost, bestByPerformance, isRejectedStatus, localRange, rejectedAds, totalsByCurrency } from '../shared/assistant-ops.js';

const ad = (id, extra = {}) => ({ id, name: `Anúncio ${id}`, currency: 'USD', spend: 10, impressions: 1000, clicks: 20, ctr: 2, cpc: 0.5, result: 2, costPerResult: 5, conversions: 2, status: 'AD_STATUS_DELIVERY_OK', modifiedAt: '2026-11-25T10:00:00.000Z', ...extra });
const DOWN = ['STATUS_LIMIT', 'STATUS_DISABLE'];

describe('assistente: contas e rankings da operação', () => {
  it('períodos em horário LOCAL: hoje, ontem, 7/14/30 dias, este mês e mês passado', () => {
    const now = new Date(2026, 10, 25, 15, 30); // 25/11/2026 15:30 local
    const fmt = (r) => [r.from.getDate(), r.from.getMonth() + 1, r.to.getDate(), r.to.getMonth() + 1];
    assert.deepEqual(fmt(localRange('today', now)), [25, 11, 26, 11]);
    assert.deepEqual(fmt(localRange('yesterday', now)), [24, 11, 25, 11]);
    assert.deepEqual(fmt(localRange('last7', now)), [19, 11, 26, 11]);
    assert.deepEqual(fmt(localRange('last14', now)), [12, 11, 26, 11]);
    assert.deepEqual(fmt(localRange('last30', now)), [27, 10, 26, 11]);
    assert.deepEqual(fmt(localRange('thisMonth', now)), [1, 11, 26, 11]);
    assert.deepEqual(fmt(localRange('lastMonth', now)), [1, 10, 1, 11]);
    assert.deepEqual(fmt(localRange('qualquer', now)), [25, 11, 26, 11], 'desconhecido vira hoje');
    assert.deepEqual(fmt(localRange('today', new Date(2026, 11, 31, 23, 59))), [31, 12, 1, 1], 'virada de ano');
    assert.deepEqual(fmt(localRange('lastMonth', new Date(2027, 0, 10))), [1, 12, 1, 1], 'janeiro: mês passado é dezembro');
  });

  it('soma por moeda sem misturar dólar com real', () => {
    const t = totalsByCurrency([ad(1, { spend: 10 }), ad(2, { spend: 5 }), ad(3, { currency: 'BRL', spend: 100, clicks: 7 }), ad(4, { currency: null, spend: 1 })]);
    assert.deepEqual(t.map((x) => [x.currency, x.spend, x.count]), [['BRL', 100, 1], ['USD', 15, 2], ['UNKNOWN', 1, 1]]);
    assert.equal(t.find((x) => x.currency === 'USD').clicks, 40);
    assert.deepEqual(totalsByCurrency([]), []);
  });

  it('anúncios reprovados: só os reprovados e, no período, os alterados nele', () => {
    const rows = [
      ad(1, { status: 'AD_STATUS_AUDIT_DENY', modifiedAt: '2026-11-25T10:00:00.000Z' }),
      ad(2, { status: 'AD_STATUS_REVIEW_PARTIALLY_APPROVED', modifiedAt: '2026-11-20T10:00:00.000Z' }),
      ad(3, { status: 'AD_STATUS_DELIVERY_OK', modifiedAt: '2026-11-25T11:00:00.000Z' }),
      ad(4, { status: 'AD_STATUS_AUDIT_DENY', modifiedAt: null }),
      ad(5, { status: 'AD_STATUS_DISABLE' }),
    ];
    const r = rejectedAds(rows, { from: new Date('2026-11-25T00:00:00Z'), to: new Date('2026-11-26T00:00:00Z') });
    assert.deepEqual(r.inPeriod.map((x) => x.id), [1]);
    assert.deepEqual(r.total.map((x) => x.id), [1, 2, 4]);
    assert.ok(isRejectedStatus('AD_STATUS_AUDIT_DENY') && !isRejectedStatus('AD_STATUS_AUDIT') && !isRejectedStatus(undefined));
  });

  it('melhores por desempenho: mais conversões, depois CTR; só com gasto; uma lista por moeda', () => {
    const rows = [
      ad(1, { conversions: 5, ctr: 1 }), ad(2, { conversions: 5, ctr: 3 }), ad(3, { conversions: 9, ctr: 0.5 }), ad(4, { spend: 0, conversions: 99 }),
      ad(5, { currency: 'BRL', conversions: 1, spend: 50 }),
    ];
    const out = bestByPerformance(rows, 2);
    const usd = out.find((g) => g.currency === 'USD');
    assert.deepEqual(usd.rows.map((r) => r.id), [3, 2], 'o de gasto zero fica de fora');
    assert.deepEqual(out.find((g) => g.currency === 'BRL').rows.map((r) => r.id), [5]);
    assert.deepEqual(bestByPerformance([]), []);
  });

  it('melhores em custo: menor custo por resultado entre quem tem resultado e gasto relevante', () => {
    const rows = [
      ad(1, { spend: 100, result: 10, costPerResult: 10 }),
      ad(2, { spend: 80, result: 20, costPerResult: 4 }),
      ad(3, { spend: 0.5, result: 1, costPerResult: 0.5 }), // gasto ínfimo: não vale
      ad(4, { spend: 50, result: 0, costPerResult: 0 }),
      ad(5, { currency: 'BRL', spend: 30, result: 3, costPerResult: 10 }),
    ];
    const out = bestByCost(rows, 5);
    const usd = out.find((g) => g.currency === 'USD');
    assert.equal(usd.metric, 'costPerResult');
    assert.deepEqual(usd.rows.map((r) => r.id), [2, 1]);
    assert.equal(out.find((g) => g.currency === 'BRL').rows[0].id, 5);
  });

  it('sem resultado em ninguém, usa o menor CPC; sem cliques, não devolve nada daquela moeda', () => {
    const noResults = [ad(1, { result: 0, costPerResult: 0, cpc: 0.9 }), ad(2, { result: 0, costPerResult: 0, cpc: 0.2 }), ad(3, { result: 0, costPerResult: 0, cpc: 0, clicks: 0 })];
    const out = bestByCost(noResults);
    assert.equal(out[0].metric, 'cpc');
    assert.deepEqual(out[0].rows.map((r) => r.id), [2, 1]);
    assert.deepEqual(bestByCost([ad(1, { result: 0, costPerResult: 0, clicks: 0, cpc: 0 })]), []);
    assert.deepEqual(bestByCost([]), []);
  });

  it('conta que caiu: de ativa para queda; primeira leitura e repetições não contam', () => {
    const events = [
      { advertiserId: '1', name: 'A', previousStatus: 'STATUS_ENABLE', status: 'STATUS_LIMIT', at: '2026-11-25T12:00:00Z' },
      { advertiserId: '1', name: 'A', previousStatus: 'STATUS_DISABLE', status: 'STATUS_LIMIT', at: '2026-11-25T11:00:00Z' },
      { advertiserId: '2', name: 'B', previousStatus: null, status: 'STATUS_LIMIT', at: '2026-11-25T10:00:00Z' },
      { advertiserId: '3', name: 'C', previousStatus: 'STATUS_ENABLE', status: 'STATUS_PENDING_CONFIRM', at: '2026-11-25T09:00:00Z' },
      { advertiserId: '4', name: 'D', previousStatus: 'STATUS_LIMIT', status: 'STATUS_ENABLE', at: '2026-11-25T08:00:00Z' },
      { advertiserId: '5', name: 'E', previousStatus: 'STATUS_PENDING_CONFIRM', status: 'STATUS_DISABLE', at: '2026-11-25T07:00:00Z' },
    ];
    assert.deepEqual(accountsThatDropped(events, DOWN).map((e) => e.advertiserId), ['1', '5']);
    assert.deepEqual(accountsThatDropped([], DOWN), []);
  });
});
