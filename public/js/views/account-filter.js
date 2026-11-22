import { ACCOUNT_LABEL_SHORT, ACCOUNT_LABELS, KIND_FILTERS, STATUS_FILTERS, matchesAccountFilter } from '/shared/account-labels.js';
import { h } from '../dom.js';
import { badge } from '../ui.js';

/**
 * Peças das etiquetas e dos filtros de conta de anúncio, usadas pela aba "Contas de anúncio" e pela publicação de campanhas
 * (mesmas opções, mesmo comportamento). As regras ficam em /shared/account-labels.js, as mesmas que o servidor usa.
 */

/** Selo da etiqueta (ex.: "Agência"); contas comuns não têm selo. */
export const labelBadge = (account) => (account.label ? badge(ACCOUNT_LABEL_SHORT[account.label] ?? ACCOUNT_LABELS[account.label] ?? account.label, 'agency') : null);

/**
 * Dois seletores: tipo (todas, comuns, agência) e situação (ativas, inativas). `onChange` é chamado a cada mudança.
 * Retorna { controls, matches(conta), isActive(), reset() }.
 */
export function createAccountFilter({ onChange }) {
  const state = { kind: 'all', status: 'all' };
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
  const controls = [
    make('kind', KIND_FILTERS, 'Filtrar por tipo de conta', 'Contas comuns ou contas de agência'),
    make('status', STATUS_FILTERS, 'Filtrar por situação da conta', 'Inativa = a Business Center da conta está com erro de acesso'),
  ];
  return {
    controls,
    matches: (account) => matchesAccountFilter(account, state),
    isActive: () => state.kind !== 'all' || state.status !== 'all',
    reset() {
      state.kind = 'all';
      state.status = 'all';
      selects.kind.value = 'all';
      selects.status.value = 'all';
      onChange();
    },
  };
}
