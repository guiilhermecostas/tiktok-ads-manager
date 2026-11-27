import { ACCOUNT_LABEL_SHORT, ACCOUNT_LABELS, KIND_FILTERS, STATUS_FILTERS, centersOf, matchesAccountFilter } from '/shared/account-labels.js';
import { countByCurrency, isMainCurrency } from '/shared/currency.js';
import { h } from '../dom.js';
import { badge } from '../ui.js';

/**
 * Peças das etiquetas e dos filtros de conta de anúncio, usadas pela aba "Contas de anúncio" e pela publicação de campanhas
 * (mesmas opções, mesmo comportamento). As regras ficam em /shared/account-labels.js, as mesmas que o servidor usa.
 */

/** Selo da moeda da conta: neutro para BRL; destacado (amarelo) para qualquer outra, para ninguém publicar em dólar sem querer. */
export const currencyBadge = (code) => (code ? badge(code, isMainCurrency(code) ? 'neutral' : 'warning') : null);

/** Selo da etiqueta (ex.: "Agência"); contas comuns não têm selo. */
export const labelBadge = (account) => (account.label ? badge(ACCOUNT_LABEL_SHORT[account.label] ?? ACCOUNT_LABELS[account.label] ?? account.label, 'agency') : null);

/**
 * Seletores: tipo (todas, comuns, agência), situação (ativas, inativas), moeda (só se houver mais de uma) e, com `byCenter`, Business Center.
 * `onChange` é chamado a cada mudança.
 * Retorna { controls, matches(conta), isActive(), reset() }.
 */
export function createAccountFilter({ onChange, accounts = [], byCenter = false }) {
  const state = { kind: 'all', status: 'all', currency: 'all', center: 'all' };
  const selects = {};
  const make = (key, options, ariaLabel, title) => {
    const select = h('select', { class: 'input input--filter', 'aria-label': ariaLabel, title }, options.map((o) => h('option', { value: o.value }, o.label)));
    select.addEventListener('change', () => {
      state[key] = select.value;
      onChange();
    });
    selects[key] = select;
    return select;
  };
  const controls = [];
  // Business Center: o seletor só existe quando há mais de uma (com uma só, filtrar não serve para nada).
  const centers = byCenter ? centersOf(accounts) : [];
  if (centers.length > 1) {
    controls.push(make('center', [{ value: 'all', label: 'Todas as Business Centers' }, ...centers.map((c) => ({ value: c.id, label: `${c.name} (${c.accounts})` }))], 'Filtrar por Business Center', 'Mostrar só as contas de uma Business Center'));
  }
  controls.push(
    make('kind', KIND_FILTERS, 'Filtrar por tipo de conta', 'Contas comuns ou contas de agência'),
    make('status', STATUS_FILTERS, 'Filtrar por situação da conta', 'Inativa = a Business Center da conta está com erro de acesso'),
  );
  // Moeda: o seletor só existe quando as contas usam mais de uma (com uma só, filtrar por moeda não serve para nada).
  const currencies = countByCurrency(accounts).filter((c) => c.code);
  if (currencies.length > 1) {
    controls.push(make('currency', [{ value: 'all', label: 'Todas as moedas' }, ...currencies.map((c) => ({ value: c.code, label: `${c.code} (${c.accounts})` }))], 'Filtrar por moeda da conta', 'Moeda em que a conta de anúncio opera'));
  }
  return {
    controls,
    matches: (account) => matchesAccountFilter(account, state),
    isActive: () => state.kind !== 'all' || state.status !== 'all' || state.currency !== 'all' || state.center !== 'all',
    reset() {
      state.kind = 'all';
      state.status = 'all';
      state.currency = 'all';
      state.center = 'all';
      for (const select of Object.values(selects)) select.value = 'all';
      onChange();
    },
  };
}
