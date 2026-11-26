import { h, icon } from '../dom.js';

let current = null;

/** Fecha o menu aberto, se houver. */
export function closeContextMenu() {
  current?.close();
}

/**
 * Menu que abre ao clicar com o botão direito (ou com a tecla de menu) sobre um item. Fecha ao clicar fora, rolar a página, redimensionar
 * a janela ou apertar Esc; setas navegam e Enter aciona. Só um menu fica aberto por vez. Todo texto entra como nó de texto.
 * `items`: [{ label, icon?, onClick, danger?, disabled? }] ou 'separator'.
 */
export function openContextMenu({ x, y, items, label = 'Ações' }) {
  closeContextMenu();
  const previouslyFocused = document.activeElement;
  const menu = h('div', { class: 'context-menu', role: 'menu', 'aria-label': label });
  const buttons = [];
  let closed = false;

  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div', { class: 'context-menu__sep', role: 'separator' }));
      continue;
    }
    const btn = h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: `context-menu__item${item.danger ? ' is-danger' : ''}`,
        disabled: item.disabled === true,
        onClick: () => {
          close({ restoreFocus: false });
          item.onClick();
        },
      },
      item.icon ? icon(item.icon, 16) : h('span', { class: 'context-menu__noicon' }),
      h('span', null, item.label),
    );
    buttons.push(btn);
    menu.append(btn);
  }

  const outside = (event) => {
    if (!menu.contains(event.target)) close({ restoreFocus: false });
  };
  const onKey = (event) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const index = enabled.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!enabled.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      enabled[(index + step + enabled.length) % enabled.length].focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      enabled.at(event.key === 'Home' ? 0 : -1)?.focus();
    } else if (event.key === 'Tab') {
      close({ restoreFocus: false }); // Tab sai do menu, como em qualquer menu nativo
    }
  };
  const dismiss = () => close({ restoreFocus: false });

  function close({ restoreFocus }) {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', dismiss);
    window.removeEventListener('blur', dismiss);
    document.removeEventListener('scroll', dismiss, true);
    menu.remove();
    if (current?.menu === menu) current = null;
    if (restoreFocus) previouslyFocused?.focus?.();
  }

  document.body.append(menu);
  // posição: junto do ponteiro, sem sair da tela
  const margin = 8;
  const left = Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('blur', dismiss);
  document.addEventListener('scroll', dismiss, true);
  buttons.find((b) => !b.disabled)?.focus();

  current = { menu, close: () => close({ restoreFocus: false }) };
  return current;
}
