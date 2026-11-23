/**
 * Moeda das contas de anúncio. Cada conta do TikTok tem a sua moeda (BRL, USD…) e o valor de orçamento/lance é enviado como o
 * MESMO número na moeda de cada conta (nada é convertido). Por isso a moeda precisa estar sempre à vista onde se escolhe conta
 * ou se digita um valor. Fonte única para servidor e telas.
 */
export const MAIN_CURRENCY = 'BRL';

const SYMBOLS = Object.freeze({ BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£', MXN: 'MX$', CAD: 'CA$', AUD: 'A$', ARS: 'AR$', CLP: 'CL$', COP: 'CO$' });

/** Símbolo para exibir ao lado de um valor (código desconhecido aparece como o próprio código). */
export const currencySymbol = (code) => SYMBOLS[code] ?? code ?? '';

/** A moeda "de sempre" do operador (BRL) ou ainda desconhecida: não precisa de destaque; qualquer outra, sim. */
export const isMainCurrency = (code) => !code || code === MAIN_CURRENCY;

/** Moedas distintas (sem vazio), na ordem em que aparecem. */
export const distinctCurrencies = (accounts) => [...new Set(accounts.map((a) => a.currency).filter(Boolean))];

/** [{ code, accounts }] da moeda com mais contas para a com menos (empate: ordem alfabética). `code` nulo = moeda não informada. */
export function countByCurrency(accounts) {
  const counts = new Map();
  for (const a of accounts) counts.set(a.currency ?? null, (counts.get(a.currency ?? null) ?? 0) + 1);
  return [...counts.entries()].map(([code, total]) => ({ code, accounts: total })).sort((x, y) => y.accounts - x.accounts || String(x.code).localeCompare(String(y.code)));
}

/** Prefixo do campo de valor: o símbolo se todas as contas têm a mesma moeda; senão os códigos juntos ("BRL / USD"). */
export function moneyPrefix(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  if (list.length === 0) return currencySymbol(MAIN_CURRENCY);
  return list.length === 1 ? currencySymbol(list[0]) : list.join(' / ');
}
