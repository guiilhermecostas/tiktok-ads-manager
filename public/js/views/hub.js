import { h } from '../dom.js';
import { accountsTabs } from './accounts-tabs.js';

/**
 * Peças visuais ÚNICAS das telas de "Contas TikTok" (Business Centers, Contas de anúncio e Proxy): cabeçalho centralizado,
 * abas, barra de resumo/ação e cartões padronizados. Todo texto entra como nó de texto (nunca HTML).
 */

/**
 * Estrutura da página: título e subtítulo centralizados, abas, aviso opcional, barra (resumo à esquerda, ações à direita)
 * e o conteúdo, tudo numa coluna central.
 * `summary` e `actions` aceitam texto ou nós; `children` é a lista de blocos da página.
 */
export function hubLayout({ active, subtitle, summary, actions, notice, children = [] }) {
  let summaryEl = null;
  if (summary instanceof Node) {
    summary.classList.add('hub__summary');
    summaryEl = summary;
  } else if (summary) {
    summaryEl = h('p', { class: 'hub__summary', 'aria-live': 'polite' }, summary);
  }
  return h(
    'div',
    { class: 'hub' },
    h('header', { class: 'hub__header' }, h('h1', { class: 'hub__title' }, 'Contas TikTok'), subtitle ? h('p', { class: 'hub__subtitle' }, subtitle) : null),
    accountsTabs(active),
    notice,
    summaryEl || actions ? h('div', { class: 'hub__bar' }, summaryEl ?? h('span'), actions ? h('div', { class: 'hub__actions' }, actions) : null) : null,
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
