import { ALL_AREAS, AREAS, hasFullAccess } from '/shared/permissions.js';
import { h } from '../dom.js';

let pickerCounter = 0;

/**
 * Escolha das áreas liberadas a um colaborador, compacta: um interruptor "Acesso total" e as áreas em cartões de 2 colunas
 * (clique no cartão liga/desliga). Marcar "Acesso total" marca todas; desmarcar uma área desliga o "total". O contador resume a
 * escolha. `get()` devolve a lista de áreas escolhidas, na ordem do sistema.
 */
export function createAreaPicker({ initial = [], onChange } = {}) {
  const prefix = `area-${++pickerCounter}`;
  const boxes = new Map();
  const cards = new Map();

  const full = h('input', { type: 'checkbox', role: 'switch', id: `${prefix}-full`, class: 'switch__input' });
  const summary = h('span', { class: 'area-picker__summary', 'aria-live': 'polite' });

  function get() {
    return ALL_AREAS.filter((id) => boxes.get(id)?.checked);
  }
  function sync() {
    const picked = get();
    full.checked = hasFullAccess(picked);
    cards.forEach((card, id) => card.classList.toggle('is-on', picked.includes(id)));
    summary.textContent = picked.length === 0 ? 'Nenhuma área escolhida' : hasFullAccess(picked) ? 'Todas as áreas' : `${picked.length} de ${ALL_AREAS.length} áreas`;
  }
  const changed = () => { sync(); onChange?.(get()); };

  full.addEventListener('change', () => {
    boxes.forEach((box) => { box.checked = full.checked; });
    changed();
  });

  const grid = h(
    'div',
    { class: 'area-grid' },
    AREAS.map((area) => {
      const box = h('input', { type: 'checkbox', id: `${prefix}-${area.id}`, class: 'area-card__input', checked: initial.includes(area.id) });
      box.addEventListener('change', changed);
      boxes.set(area.id, box);
      const card = h('label', { class: 'area-card', for: box.id }, box, h('span', { class: 'area-card__tick', 'aria-hidden': 'true' }, '✓'), h('strong', { class: 'area-card__title' }, area.label), h('span', { class: 'area-card__text' }, area.description));
      cards.set(area.id, card);
      return card;
    }),
  );

  sync();
  const element = h(
    'fieldset',
    { class: 'area-picker' },
    h('legend', { class: 'field__label' }, 'O que esta pessoa pode acessar'),
    h(
      'label',
      { class: 'switch', for: full.id },
      full,
      h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' })),
      h('span', { class: 'switch__text' }, h('strong', null, 'Acesso total'), h('small', { class: 'muted' }, 'Todas as áreas. Sem gerenciar colaboradores nem a administração.')),
    ),
    grid,
    summary,
  );
  return { element, get };
}
