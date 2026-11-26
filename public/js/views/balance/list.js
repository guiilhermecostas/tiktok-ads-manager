import { situationOf } from '/shared/balance-list.js';
import { h, icon } from '../../dom.js';
import { formatCurrency } from '../../format.js';
import { button, toast } from '../../ui.js';

/**
 * Lista compacta de Saldo: UMA linha por Business Center (aba "Business Centers") ou por conta de anúncio (aba "Contas de anúncio"):
 *   nome · ID · saldo · total gasto · [Depósitos]
 * Só mostra o que é daquele tipo (BC não mostra contas, conta não mostra BC). Todo texto (nomes, IDs, mensagens do TikTok) entra como nó de texto.
 */

export const money = (value, currency) => (value === null || value === undefined ? '—' : formatCurrency(value, currency && currency !== 'UNKNOWN' ? currency : undefined));

/** De onde vem o "saldo disponível" quando não é o saldo da própria conta (curto, para caber ao lado do valor). */
const SOURCE_TAG = {
  portfolio: ['portfólio', 'Saldo compartilhado: todas as contas ligadas ao mesmo portfólio de pagamento gastam dele (ele é somado uma única vez).'],
  budget: ['orçamento', 'Orçamento restante: esta conta gasta do saldo da Business Center, dentro de um orçamento.'],
};

/** Texto do balãozinho do saldo: todos os valores que o TikTok devolveu (o que antes ficava em "Detalhes"). */
function amountsTitle(row) {
  const lines = row.amounts.map((a) => `${a.label}: ${money(a.value, row.currency)}`);
  if (row.portfolio?.amounts?.length) lines.push('', `Portfólio de pagamento${row.portfolio.name ? ` (${row.portfolio.name})`: ''}:`, ...row.portfolio.amounts.map((a) => `${a.label}: ${money(a.value, row.currency)}`));
  if (SOURCE_TAG[row.mainSource]) lines.push('', SOURCE_TAG[row.mainSource][1]);
  return lines.join('\n');
}

function balanceCell(row) {
  const kind = situationOf(row);
  const label = kind === 'with' ? 'com saldo' : kind === 'without' ? 'sem saldo' : 'sem informação';
  const value = h('strong', { class: `bal-amount bal-amount--${kind}`, title: kind === 'unknown' ? (row.error ?? 'O TikTok não informou o saldo.') : amountsTitle(row) || undefined }, kind === 'unknown' ? '—' : money(row.main, row.currency));
  const tag = SOURCE_TAG[row.mainSource];
  return h('td', { class: 'num', 'data-label': 'Saldo' }, value, h('span', { class: 'visually-hidden' }, ` (${label})`), kind === 'unknown' ? h('span', { class: 'bal-flag', title: row.error ?? 'O TikTok não informou o saldo.' }, icon('ban', 13)) : null, tag && kind !== 'unknown' ? h('span', { class: 'bal-tag', title: tag[1] }, tag[0]) : null);
}

/**
 * Célula do total gasto. `spend` = { state: 'loading' | 'ok' | 'error', parts: [{ currency, spend }], error, failed }.
 * Enquanto carrega mostra reticências (a lista já está útil sem esperar); uma BC com contas que falharam mostra "*" e o motivo no balãozinho.
 */
function spendCell(spend) {
  const cell = (...children) => h('td', { class: 'num', 'data-label': 'Total gasto' }, ...children);
  if (spend.state === 'loading') return cell(h('span', { class: 'bal-loading', role: 'status', 'aria-label': 'Carregando o total gasto' }, '···'));
  if (spend.state === 'error') return cell(h('span', { class: 'bal-flag', title: spend.error ?? 'Não foi possível carregar o gasto.' }, '—', icon('ban', 13)));
  const text = spend.parts.length ? spend.parts.map((p) => money(p.spend, p.currency)).join(' + ') : money(0, undefined);
  return cell(h('span', { class: 'bal-spend', title: spend.failed ? `Faltam ${spend.failed} ${spend.failed === 1 ? 'conta' : 'contas'} que o TikTok não deixou consultar: o valor é parcial.` : undefined }, text, spend.failed ? h('span', { class: 'bal-partial', 'aria-label': 'valor parcial' }, '*') : null));
}

/** Botão que copia o ID (clique) em vez de obrigar a selecionar o número. */
function idButton(id) {
  if (!id) return h('span', { class: 'muted' }, '—');
  return h('button', {
    type: 'button', class: 'bal-id', title: 'Clique para copiar o ID', 'aria-label': `Copiar o ID ${id}`,
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(id);
        toast('ID copiado.');
      } catch {
        toast('Não foi possível copiar. Selecione o número e copie manualmente.', 'danger');
      }
    },
  }, id);
}

/**
 * Tabela. `rows`: linhas do servidor. `view`: { name(row), id(row), spend(row), historyLabel(row), onHistory(row), extra(row)? }.
 * Os títulos Nome, Saldo e Total gasto ordenam (botão `aria-sort`).
 */
export function balanceTable({ rows, sort, dir, onSort, view, emptyText }) {
  const sortable = (key, label) => {
    const on = sort === key;
    return h('th', { scope: 'col', class: `bal-th bal-th--${key}`, 'aria-sort': on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', class: 'bal-th__btn', title: `Ordenar por ${label.toLowerCase()}`, onClick: () => onSort(key) }, h('span', null, label), on ? icon(dir === 'asc' ? 'arrow-up' : 'arrow-down', 13) : null));
  };
  const body = rows.length
    ? rows.map((row) => h('tr', { class: `bal-row bal-row--${situationOf(row)}` },
      h('td', { 'data-label': view.nameLabel }, h('span', { class: 'bal-name', title: view.name(row) }, view.name(row))),
      h('td', { 'data-label': 'ID' }, idButton(view.id(row))),
      balanceCell(row),
      spendCell(view.spend(row)),
      h('td', { class: 'bal-actions', 'data-label': 'Ações' }, h('div', { class: 'bal-actions__row' }, view.extra?.(row) ?? null, button([icon('clock', 14), ' Depósitos'], { small: true, ariaLabel: view.historyLabel(row), onClick: () => view.onHistory(row) })))))
    : [h('tr', null, h('td', { colspan: 5, class: 'muted bal-empty' }, emptyText))];
  return h('div', { class: 'card table-wrap bal-card' }, h('table', { class: 'table table--stack bal-table' },
    h('thead', null, h('tr', null, sortable('name', view.nameLabel), h('th', { scope: 'col' }, 'ID'), sortable('balance', 'Saldo'), sortable('spend', 'Total gasto'), h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Ações')))),
    h('tbody', null, body)));
}
