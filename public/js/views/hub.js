import { h } from '../dom.js';
import { accountsTabs } from './accounts-tabs.js';

/**
 * Peças visuais ÚNICAS das telas de "Contas TikTok" (Business Centers, Contas de anúncio e Proxy): cabeçalho centralizado,
 * abas, barra de resumo/ação e cartões padronizados. Todo texto entra como nó de texto (nunca HTML).
 */

/**
 * Estrutura da página, em 3 faixas bem separadas:
 *  1) título e subtítulo centralizados;
 *  2) UMA barra com as abas à esquerda e, à direita, o resumo ("1 conexão · 7 contas") e o botão principal, na mesma linha;
 *  3) (opcional) uma linha de filtros/busca, e depois o conteúdo.
 * No celular tudo empilha com largura total. `summary`, `actions` e `filters` aceitam texto ou nós; `children` é a lista de blocos.
 */
export function hubLayout({ active, subtitle, summary, actions, filters, notice, children = [] }) {
  let summaryEl = null;
  if (summary instanceof Node) {
    summary.classList.add('hub__summary');
    summaryEl = summary;
  } else if (summary) {
    summaryEl = h('p', { class: 'hub__summary', 'aria-live': 'polite' }, summary);
  }
  const hasSide = Boolean(summaryEl || actions);
  return h(
    'div',
    { class: 'hub' },
    h('header', { class: 'hub__header' }, h('h1', { class: 'hub__title' }, 'Contas TikTok'), subtitle ? h('p', { class: 'hub__subtitle' }, subtitle) : null),
    notice,
    h('div', { class: `hub__toolbar${hasSide ? '' : ' hub__toolbar--solo'}` }, accountsTabs(active), hasSide ? h('div', { class: 'hub__side' }, summaryEl, actions) : null),
    filters ? h('div', { class: 'hub__filters' }, filters) : null,
    ...children,
  );
}

/** Grade centralizada de cartões (cada cartão tem largura fixa entre 320 e 360 px; poucos cartões ficam no centro). */
export const hubGrid = (cards) => h('div', { class: 'hub-grid' }, cards);

/**
 * Cartão padrão: título + situação, selos, aviso, números, bloco livre, ações em colunas iguais e rodapé.
 *  - tone: 'ok' (faixa ciano), 'error' (faixa vermelha), 'active' (faixa ciano→vermelho) ou nenhuma.
 *  - stats: [{ label, value (texto ou nó), big?, wide? (ocupa a linha toda) }]
 *  - note: { text, tone: 'error' | 'muted' }
 *  - actions: lista de botões (ficam em grade, todos da mesma largura e alinhados no fim do cartão)
 */
export function hubCard({ title, titleHint, status, tone, badges = [], note, stats = [], body, actions = [], footnote }) {
  const visibleStats = stats.filter(Boolean);
  const visibleActions = actions.filter(Boolean);
  return h(
    'article',
    { class: `hub-card${tone ? ` hub-card--${tone}` : ''}` },
    h('header', { class: 'hub-card__head' }, h('h2', { class: 'hub-card__title', title: titleHint ?? title }, title), status ?? null),
    badges.filter(Boolean).length ? h('div', { class: 'hub-card__badges' }, badges.filter(Boolean)) : null,
    note ? h('p', { class: `hub-card__note hub-card__note--${note.tone ?? 'muted'}` }, note.text) : null,
    visibleStats.length
      ? h('dl', { class: 'hub-card__stats' }, visibleStats.map((s) => h('div', { class: `hub-stat${s.big ? ' hub-stat--big' : ''}${s.wide ? ' hub-stat--wide' : ''}` }, h('dt', null, s.label), h('dd', null, s.value))))
      : null,
    body ?? null,
    visibleActions.length ? h('div', { class: 'hub-card__actions' }, visibleActions) : null,
    footnote ? h('p', { class: 'hub-card__footnote' }, footnote) : null,
  );
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
