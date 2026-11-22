import { ALL_AREAS, AREAS, hasFullAccess } from '/shared/permissions.js';
import { h } from '../dom.js';

let pickerCounter = 0;

/**
 * Escolha das áreas liberadas a um colaborador: "Acesso total" + uma caixa por área (com a explicação de cada uma).
 * Marcar "Acesso total" marca todas; desmarcar uma área desmarca o "total". `get()` devolve a lista de áreas escolhidas.
 */
export function createAreaPicker({ initial = [], onChange } = {}) {
  const prefix = `area-${++pickerCounter}`;
  const boxes = new Map();
  const full = h('input', { type: 'checkbox', id: `${prefix}-full` });

  const syncFull = () => { full.checked = hasFullAccess(get()); };
  const changed = () => { syncFull(); onChange?.(get()); };
  full.addEventListener('change', () => {
    boxes.forEach((box) => { box.checked = full.checked; });
    onChange?.(get());
  });

  const rows = AREAS.map((area) => {
    const box = h('input', { type: 'checkbox', id: `${prefix}-${area.id}`, checked: initial.includes(area.id) });
    box.addEventListener('change', changed);
    boxes.set(area.id, box);
    return h('label', { class: 'area-option', for: box.id }, box, h('span', null, h('strong', null, area.label), h('small', { class: 'muted' }, area.description)));
  });

  function get() {
    return ALL_AREAS.filter((id) => boxes.get(id)?.checked);
  }
  syncFull();

  const element = h(
    'fieldset',
    { class: 'area-picker' },
    h('legend', { class: 'field__label' }, 'O que esta pessoa pode acessar'),
    h('label', { class: 'area-option area-option--full', for: full.id }, full, h('span', null, h('strong', null, 'Acesso total'), h('small', { class: 'muted' }, 'Todas as áreas abaixo. Não inclui gerenciar colaboradores nem a administração.'))),
    ...rows,
  );
  return { element, get };
}
