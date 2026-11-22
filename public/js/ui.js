import { h } from './dom.js';

export function toast(message, tone = 'success') {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast toast--${tone}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), 4000);
}

export const badge = (label, tone = 'neutral') => h('span', { class: `badge badge--${tone}` }, label);

/** `ariaLabel` desambigua botões repetidos em listas (ex.: "Editar" em cada cartão vira "Editar Loja Principal"). */
export function button(label, { variant = 'secondary', type = 'button', onClick, disabled = false, small = false, ariaLabel } = {}) {
  return h(
    'button',
    { type, class: `btn btn--${variant}${small ? ' btn--sm' : ''}`, onClick, disabled, 'aria-label': ariaLabel },
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

/** Pilha de pop-ups abertos: só o do TOPO reage ao teclado (ex.: confirmação aberta sobre o assistente). */
const modalStack = [];

/**
 * Modal com foco preso, fechamento por Esc e (opcionalmente) clique no fundo. Retorna { close, requestClose }.
 *  - `canClose()` (pode ser assíncrona) é consultada ao fechar pelo ✕, Esc ou clique no fundo; `false` mantém aberto
 *    (ex.: alterações não salvas). `close()` fecha sempre.
 *  - `dismissOnOverlay: false` impede fechar por um clique acidental fora da janela (formulários longos).
 */
export function openModal({ title, body, onClose, size, canClose, dismissOnOverlay = true }) {
  const previouslyFocused = document.activeElement;
  const entry = {};
  let closed = false;
  const dialog = h(
    'div',
    { class: `modal${size ? ` modal--${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'modal__header' },
      h('h2', { class: 'modal__title' }, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fechar', onClick: () => requestClose() }, '✕'),
    ),
    body,
  );
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => dismissOnOverlay && e.target === overlay && requestClose() }, dialog);

  async function requestClose() {
    if (closed) return;
    if (canClose && (await canClose()) === false) return;
    close();
  }

  function onKey(event) {
    if (modalStack.at(-1) !== entry) return; // há outro pop-up por cima: ele é quem responde
    if (event.key === 'Escape') return requestClose();
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
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
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    modalStack.splice(modalStack.indexOf(entry), 1);
    if (!modalStack.length) document.body.classList.remove('modal-open');
    overlay.remove();
    previouslyFocused?.focus?.();
    onClose?.();
  }

  modalStack.push(entry);
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  dialog.querySelector('input, select, textarea, button.btn')?.focus();
  return { close, requestClose };
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
