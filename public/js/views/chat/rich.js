import { h } from '../../dom.js';

const itemEl = (item) => (typeof item === 'string' ? h('li', null, item) : h('li', null, h('strong', null, `${item.title}:`), ' ', item.text));

/**
 * Desenha os blocos de uma resposta do assistente. Todo texto entra como nó de texto (nunca HTML), inclusive o que vem do TikTok
 * (nomes de conta). Botões: `href` (navegação interna, tratada pelo roteador), `wizard` (abre o assistente de campanha) e `ask` (envia uma pergunta).
 */
export function renderBlocks(blocks, { openWizard, ask }) {
  return h('div', { class: 'rich' }, blocks.map((block) => {
    switch (block.type) {
      case 'h': return h('h4', { class: 'rich__h' }, block.text);
      case 'p': return h('p', { class: 'rich__p' }, block.text);
      case 'ul': return h('ul', { class: 'rich__list' }, block.items.map(itemEl));
      case 'ol': return h('ol', { class: 'rich__list rich__list--steps' }, block.items.map(itemEl));
      case 'note': return h('p', { class: `rich__note rich__note--${block.tone ?? 'info'}` }, block.text);
      case 'kpis':
        return h('div', { class: 'rich__kpis' }, block.items.map((k) => h('div', { class: 'rich__kpi' },
          h('span', { class: 'rich__kpi-label' }, k.label), h('strong', { class: 'rich__kpi-value' }, k.value), k.delta ? h('span', { class: 'rich__kpi-delta' }, k.delta) : null)));
      case 'table':
        return h('div', { class: 'rich__table-wrap' }, h('table', { class: 'rich__table' },
          h('thead', null, h('tr', null, block.head.map((t, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, t)))),
          h('tbody', null, block.rows.map((row) => h('tr', null, row.map((cell, i) => h('td', { class: i ? 'num' : '' }, cell)))))));
      case 'actions':
        return h('div', { class: 'rich__actions' }, block.items.map((a) => {
          if (a.href) return h('a', { href: a.href, 'data-link': true, class: 'btn btn--secondary btn--sm' }, a.label);
          return h('button', { type: 'button', class: `btn btn--${a.wizard ? 'primary' : 'secondary'} btn--sm`, onClick: () => (a.wizard ? openWizard() : ask(a.ask)) }, a.label);
        }));
      default: return null;
    }
  }));
}
