import { h } from '../dom.js';

let counter = 0;

/**
 * Sub-abas (botões em pílula) no padrão visual da plataforma: acessíveis (role=tablist, setas ←/→, Home/End) e reutilizáveis.
 *  - `items`: [{ id, label, count? }] (`count` aparece num selinho ao lado do nome; 0 também aparece, `undefined` não);
 *  - `active`: id da aba aberta; `onChange(id)`: chamado quando a pessoa escolhe outra;
 *  - `label`: nome do grupo de abas para leitores de tela.
 * Retorna { element, select(id), setCount(id, n), active() }. Todo texto entra como nó de texto.
 */
export function subTabs({ items, active, onChange, label = 'Seções' }) {
  counter += 1;
  const prefix = `subtab-${counter}`;
  let current = active ?? items[0].id;
  const counts = new Map(items.map((item) => [item.id, item.count]));
  const element = h('div', { class: 'tabs tabs--hub subtabs', role: 'tablist', 'aria-label': label });

  function draw() {
    element.replaceChildren(...items.map((item) => {
      const on = item.id === current;
      const count = counts.get(item.id);
      return h(
        'button',
        {
          type: 'button', role: 'tab', id: `${prefix}-${item.id}`, class: `tab${on ? ' is-active' : ''}`, 'aria-selected': String(on), tabindex: on ? '0' : '-1', 'data-tab': item.id,
          onClick: () => select(item.id),
        },
        item.label,
        count === undefined || count === null ? null : h('span', { class: 'tab__count' }, String(count)),
      );
    }));
  }

  function select(id, { focus = false } = {}) {
    if (!items.some((item) => item.id === id)) return;
    const changed = id !== current;
    current = id;
    draw();
    if (focus) element.querySelector(`[data-tab="${id}"]`)?.focus();
    if (changed) onChange?.(id);
  }

  element.addEventListener('keydown', (event) => {
    const index = items.findIndex((item) => item.id === current);
    const target = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(items[(target + items.length) % items.length].id, { focus: true });
  });

  draw();
  return {
    element,
    select,
    active: () => current,
    setCount(id, n) {
      counts.set(id, n);
      draw();
    },
  };
}

/** Título e explicação curta que abrem cada aba/etapa: "o que é isto" em uma frase, para ninguém ficar perdido. */
export const tabIntro = (title, text) => h('header', { class: 'tab-intro' }, h('h2', { class: 'tab-intro__title' }, title), text ? h('p', { class: 'tab-intro__text' }, text) : null);
