import { h, setChildren } from '../../dom.js';

const CHIP_LIMIT = 6; // até este número de opções: botões lado a lado; acima: lista suspensa com busca

let counter = 0;
const nextId = () => `mc-${++counter}`;
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Mantém a ordem original das opções ao mudar a seleção (a lista de valores é sempre a mesma, sem depender de quem clicou primeiro). */
function toggled(options, current, value, on) {
  const set = new Set(current);
  if (on) set.add(value);
  else set.delete(value);
  return options.map((o) => o.value).filter((v) => set.has(v));
}

/**
 * Escolha de VÁRIAS opções de forma compacta:
 *  - até 6 opções: botões ("chips") lado a lado, um clique liga/desliga;
 *  - mais que isso: um campo com os escolhidos em "chips" removíveis e uma lista suspensa com busca, no lugar de dezenas de
 *    caixas empilhadas.
 * `maxItems` limita a seleção (as demais opções ficam desabilitadas e o contador avisa). Tudo é texto, nunca HTML.
 */
export function createMultiChoice({ options, selected, maxItems, disabled, label, onChange }) {
  return options.length <= CHIP_LIMIT ? chipGroup({ options, selected, maxItems, disabled, label, onChange }) : dropdown({ options, selected, maxItems, disabled, label, onChange });
}

function chipGroup({ options, selected, maxItems, disabled, label, onChange }) {
  let current = [...selected];
  const group = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  function draw() {
    const full = maxItems !== undefined && current.length >= maxItems;
    setChildren(
      group,
      options.map((o) => {
        const on = current.includes(o.value);
        return h('button', {
          type: 'button', class: `chip${on ? ' is-on' : ''}`, 'aria-pressed': String(on), disabled: disabled || (!on && full),
          onClick: () => {
            current = toggled(options, current, o.value, !on);
            onChange(current);
            draw();
          },
        }, on ? h('span', { class: 'chip__tick', 'aria-hidden': 'true' }, '✓') : null, o.label);
      }),
    );
  }
  draw();
  return group;
}

function dropdown({ options, selected, maxItems, disabled, label, onChange }) {
  let current = [...selected];
  let open = false;
  const labelOf = new Map(options.map((o) => [o.value, o.label]));
  const panelId = nextId();

  const chips = h('div', { class: 'multi__chips' });
  const trigger = h('button', { type: 'button', class: 'btn btn--secondary btn--sm multi__trigger', 'aria-expanded': 'false', 'aria-controls': panelId, disabled }, '+ Adicionar');
  const search = h('input', { type: 'search', class: 'input multi__search', placeholder: 'Buscar…', 'aria-label': `Buscar em ${label}`, autocomplete: 'off', maxlength: 40 });
  const list = h('div', { class: 'multi__list', role: 'group', 'aria-label': label });
  const count = h('span', { class: 'muted multi__count', 'aria-live': 'polite' });
  const clear = h('button', { type: 'button', class: 'link-btn' }, 'Limpar');
  const panel = h('div', { class: 'multi__panel', id: panelId, hidden: true }, search, list, h('div', { class: 'multi__foot' }, count, clear));
  const root = h('div', { class: 'multi' }, h('div', { class: 'multi__box' }, chips, trigger), panel);

  const commit = (next) => {
    current = next;
    onChange(current);
    drawChips();
    drawList();
  };

  function drawChips() {
    setChildren(
      chips,
      current.length ? current.map((value) => h('span', { class: 'multi__chip' }, labelOf.get(value) ?? value, h('button', { type: 'button', class: 'multi__remove', 'aria-label': `Remover ${labelOf.get(value) ?? value}`, disabled, onClick: () => commit(current.filter((v) => v !== value)) }, '×'))) : h('span', { class: 'muted multi__empty' }, 'Nenhum selecionado'),
    );
    trigger.textContent = current.length ? '+ Adicionar mais' : '+ Adicionar';
  }

  function drawList() {
    const query = normalize(search.value.trim());
    const full = maxItems !== undefined && current.length >= maxItems;
    const shown = options.filter((o) => !query || normalize(o.label).includes(query));
    setChildren(
      list,
      shown.length
        ? shown.map((o) => {
            const on = current.includes(o.value);
            return h('label', { class: 'multi__option' }, h('input', { type: 'checkbox', checked: on, disabled: disabled || (!on && full), onChange: (e) => commit(toggled(options, current, o.value, e.target.checked)) }), h('span', null, o.label));
          })
        : h('p', { class: 'muted multi__none' }, 'Nada encontrado'),
    );
    count.textContent = maxItems !== undefined ? `${current.length} de ${maxItems} (máximo)` : `${current.length} selecionados`;
    clear.disabled = disabled || current.length === 0;
  }

  function setOpen(value) {
    open = value;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      search.value = '';
      drawList();
      search.focus();
      document.addEventListener('mousedown', outside);
      document.addEventListener('keydown', onKey, true); // captura: o Esc fecha só a lista, antes do pop-up
    } else {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', onKey, true);
    }
  }
  function outside(event) {
    if (!root.contains(event.target)) setOpen(false);
  }
  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation(); // fecha só a lista, não o pop-up do assistente
      setOpen(false);
      trigger.focus();
    }
  }

  trigger.addEventListener('click', () => setOpen(!open));
  search.addEventListener('input', drawList);
  clear.addEventListener('click', () => commit([]));
  drawChips();
  drawList();
  return root;
}
