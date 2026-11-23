import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesAccountFilter } from '../shared/account-labels.js';
import { MAIN_CURRENCY, countByCurrency, currencySymbol, distinctCurrencies, isMainCurrency, moneyPrefix } from '../shared/currency.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, startTestServer } from './helpers.js';

describe('Moeda das contas (regras compartilhadas)', () => {
  const accounts = [{ currency: 'BRL' }, { currency: 'USD' }, { currency: 'BRL' }, { currency: null }, { currency: 'USD' }, { currency: 'BRL' }];

  it('símbolo, moeda principal e moedas distintas', () => {
    assert.equal(MAIN_CURRENCY, 'BRL');
    assert.deepEqual([currencySymbol('BRL'), currencySymbol('USD'), currencySymbol('EUR'), currencySymbol('XYZ'), currencySymbol(null)], ['R$', 'US$', '€', 'XYZ', '']);
    assert.deepEqual([isMainCurrency('BRL'), isMainCurrency(null), isMainCurrency(undefined), isMainCurrency('USD')], [true, true, true, false]);
    assert.deepEqual(distinctCurrencies(accounts), ['BRL', 'USD']);
    assert.deepEqual(distinctCurrencies([]), []);
  });

  it('contagem por moeda: maior primeiro, empate em ordem alfabética, "sem moeda" separada', () => {
    assert.deepEqual(countByCurrency(accounts), [{ code: 'BRL', accounts: 3 }, { code: 'USD', accounts: 2 }, { code: null, accounts: 1 }]);
    assert.deepEqual(countByCurrency([{ currency: 'USD' }, { currency: 'BRL' }]), [{ code: 'BRL', accounts: 1 }, { code: 'USD', accounts: 1 }]);
    assert.deepEqual(countByCurrency([]), []);
  });

  it('prefixo do campo de valor: símbolo se há uma moeda; códigos juntos se há várias; R$ sem contas', () => {
    assert.equal(moneyPrefix([]), 'R$');
    assert.equal(moneyPrefix(['BRL', 'BRL']), 'R$');
    assert.equal(moneyPrefix(['USD']), 'US$');
    assert.equal(moneyPrefix(['BRL', 'USD']), 'BRL / USD');
    assert.equal(moneyPrefix([null, undefined, 'USD']), 'US$');
  });

  it('filtro por moeda, sozinho e combinado com os outros', () => {
    const list = [{ id: 1, currency: 'BRL', label: 'agency', businessCenterStatus: 'active' }, { id: 2, currency: 'USD', label: null, businessCenterStatus: 'active' }, { id: 3, currency: 'USD', label: 'agency', businessCenterStatus: 'error' }];
    const ids = (f) => list.filter((a) => matchesAccountFilter(a, f)).map((a) => a.id);
    assert.deepEqual(ids({}), [1, 2, 3]);
    assert.deepEqual(ids({ currency: 'USD' }), [2, 3]);
    assert.deepEqual(ids({ currency: 'BRL' }), [1]);
    assert.deepEqual(ids({ currency: 'EUR' }), []);
    assert.deepEqual(ids({ currency: 'USD', kind: 'agency' }), [3]);
    assert.deepEqual(ids({ currency: 'USD', status: 'active' }), [2]);
  });
});

describe('Moeda por conexão (API)', () => {
  it('cada conexão informa as moedas das contas e quantas há em cada uma; só o que é do usuário', async () => {
    const fake = createFakeTiktok();
    const ctx = await startTestServer({ config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    try {
      const { client } = await createUser(ctx, { approve: true });
      fake.state.bcs = { 111: ['9001', '9002', '9003'], 222: ['9101'] };
      const a = (await client.post('/api/tiktok/business-centers', { name: 'Mista', bcId: '111', accessToken: GOOD_TOKEN })).json.businessCenter;
      const list = (await client.get('/api/tiktok/business-centers')).json.businessCenters;
      const mixed = list.find((b) => b.id === a.id);
      assert.ok(Array.isArray(mixed.currencies) && mixed.currencies.length >= 1);
      assert.equal(mixed.currencies.reduce((sum, c) => sum + c.accounts, 0), mixed.advertiserCount, 'a soma por moeda é o total de contas');
      assert.ok(mixed.currencies.every((c) => (c.code === null || /^[A-Z]{3}$/.test(c.code)) && Number.isInteger(c.accounts)));
      const sorted = [...mixed.currencies].sort((x, y) => y.accounts - x.accounts);
      assert.deepEqual(mixed.currencies.map((c) => c.accounts), sorted.map((c) => c.accounts), 'maior grupo primeiro');
      const accountsList = (await client.get('/api/tiktok/advertisers')).json.advertisers;
      assert.ok(accountsList.every((x) => 'currency' in x), 'cada conta traz a própria moeda');
    } finally {
      await ctx.stop();
    }
  });
});
