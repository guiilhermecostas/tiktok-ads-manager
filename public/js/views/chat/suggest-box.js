import { suggest } from '/shared/chat-suggest.js';
import { h } from '../../dom.js';

let counter = 0;

/**
 * Lista de sugestões que aparece sobre o campo do Início enquanto a pessoa digita (ou ao digitar "/"). Padrão "combobox" acessível: o campo
 * recebe role=combobox / aria-activedescendant, a lista é role=listbox, e as setas, Enter/Tab, Esc e o mouse funcionam.
 *  - `onPick(item)`: a pessoa escolheu uma sugestão (item de `SUGGESTION_POOL`).
 * Retorna { element, update(), handleKey(event) → true se a tecla foi usada, close() }. Todo texto entra como nó de texto.
 */
export function createSuggestBox({ input, onPick }) {
  counter += 1;
  const listId = `chat-suggest-${counter}`;
  const list = h('ul', { class: 'chat__suggest', id: listId, role: 'listbox', 'aria-label': 'Sugestões de pergunta', hidden: true });
  let items = [];
  let active = -1;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-expanded', 'false');

  function render() {
    const open = items.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0 && open) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    else input.removeAttribute('aria-activedescendant');
    list.replaceChildren(...items.map((item, i) => h(
      'li',
      {
        id: `${listId}-${i}`, role: 'option', class: `chat__suggest-item${i === active ? ' is-active' : ''}`, 'aria-selected': String(i === active),
        onMousedown: (event) => event.preventDefault(), // o campo não perde o foco ao clicar na sugestão
        onClick: () => pick(i),
        onMouseenter: () => { active = i; render(); },
      },
      h('strong', null, item.title),
      h('span', { class: 'muted' }, item.text),
    )));
  }

  function pick(index) {
    const item = items[index];
    close();
    if (item) onPick(item);
  }

  function close() {
    items = [];
    active = -1;
    render();
  }

  function update() {
    items = suggest(input.value);
    active = -1;
    render();
  }

  function handleKey(event) {
    if (!items.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length + (active < 0 && step < 0 ? 1 : 0)) % items.length;
      render();
      list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
      event.preventDefault();
      pick(active);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  }

  return { element: list, update, handleKey, close };
}
