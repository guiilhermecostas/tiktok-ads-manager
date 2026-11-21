import { h } from './dom.js';

export function toast(message, tone = 'success') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast--${tone}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), 4000);
}

export const badge = (label, tone = 'neutral') => h('span', { class: `badge badge--${tone}` }, label);

export function button(label, { variant = 'secondary', type = 'button', onClick, disabled = false, small = false } = {}) {
  return h(
    'button',
    { type, class: `btn btn--${variant}${small ? ' btn--sm' : ''}`, onClick, disabled },
    label,
  );
}

let fieldCounter = 0;
/** Campo de formulário acessível (label associado ao input). */
export function field(label, inputProps = {}, { hint } = {}) {
  const id = `field-${++fieldCounter}`;
  const tag = inputProps.as ?? 'input';
  const { options, ...rest } = inputProps;
  delete rest.as;
  const control =
    tag === 'select'
      ? h('select', { id, class: 'input', ...rest }, options.map(([value, text]) => h('option', { value }, text)))
      : h(tag, { id, class: 'input', ...rest });
  if (tag === 'select' && rest.value !== undefined) control.value = rest.value;
  return {
    control,
    element: h(
      'div',
      { class: 'field' },
      h('label', { for: id, class: 'field__label' }, label),
      control,
      hint ? h('p', { class: 'field__hint' }, hint) : null,
    ),
  };
}

export const alertBox = (message, tone = 'danger') => h('div', { class: `alert alert--${tone}`, role: 'alert' }, message);

/** Modal com foco preso, fechamento por Esc e clique no fundo. Retorna { close }. */
export function openModal({ title, body, onClose, size }) {
  const previouslyFocused = document.activeElement;
  const dialog = h(
    'div',
    { class: `modal${size ? ` modal--${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'modal__header' },
      h('h2', { class: 'modal__title' }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fechar', onClick: () => close() }, '✕'),
    ),
    body,
  );
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && close() }, dialog);

  function onKey(event) {
    if (event.key === 'Escape') return close();
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter((n) => !n.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    previouslyFocused?.focus?.();
    onClose?.();
  }

  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  dialog.querySelector('input, select, textarea, button.btn')?.focus();
  return { close };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };
    const body = h(
      'div',
      { class: 'modal__body' },
      h('p', null, message),
      h(
        'div',
        { class: 'modal__footer' },
        button('Cancelar', { onClick: () => finish(false) }),
        button(confirmLabel, { variant: danger ? 'danger' : 'primary', onClick: () => finish(true) }),
      ),
    );
    const modal = openModal({ title, body, onClose: () => finish(false) });
  });
}

export function emptyState({ title, text, action }) {
  return h('div', { class: 'empty' }, h('h3', { class: 'empty__title' }, title), h('p', { class: 'empty__text' }, text), action);
}

export const spinner = () => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), 'Carregando…');
