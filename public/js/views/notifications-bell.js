import { NOTIFICATION_LEVELS, badgeText } from '/shared/notifications.js';
import { get, post } from '../api.js';
import { h, icon, setChildren } from '../dom.js';
import { state } from '../state.js';

/**
 * O sino do topo: selo com quantas notificações não lidas e um painel com as mais recentes. A pessoa só vê o que é dela (o servidor decide);
 * todo texto entra como nó de texto, nunca como HTML. Atualiza sozinho a cada minuto enquanto houver um sino na tela e a aba estiver visível.
 * Quando um admin está vendo a conta de outra pessoa (somente leitura) as notificações aparecem, mas nada é marcado como lido.
 */
const POLL_MS = 60 * 1000;

// Estado compartilhado: o menu é redesenhado a cada troca de tela, mas o selo não pode "piscar" nem perder o que já foi carregado.
const store = { data: null, timer: null, listeners: new Set(), userId: null };

function publish() {
  for (const listener of store.listeners) listener();
}

async function refresh() {
  try {
    const data = await get('/notifications');
    store.data = data;
    publish();
  } catch {
    // o sino é um extra: se a consulta falhar, mantém o que já mostrava (a sessão caída é tratada pelo resto da tela)
  }
}

function ensurePolling() {
  if (store.timer) return;
  store.timer = setInterval(() => {
    if (!document.querySelector('.bell')) {
      clearInterval(store.timer);
      store.timer = null;
      return;
    }
    if (!document.hidden) refresh();
  }, POLL_MS);
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias" ou a data. */
export function timeAgo(iso, now = Date.now()) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 8) return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function createBell(ctx) {
  if (store.userId !== state.user.id) {
    store.data = null; // outra pessoa entrou neste navegador: nada da anterior fica à mostra
    store.userId = state.user.id;
  }
  let open = false;
  const readOnly = Boolean(state.impersonation);
  const badge = h('span', { class: 'bell__badge', hidden: true, 'aria-hidden': 'true' });
  const button = h('button', { type: 'button', class: 'bell__btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'bell-panel', onClick: () => toggle() }, icon('bell', 20), badge);
  const list = h('div', { class: 'bell__list' });
  const markAll = h('button', { type: 'button', class: 'bell__markall', onClick: () => markAllRead() }, 'Marcar todas como lidas');
  const panel = h('div', { id: 'bell-panel', class: 'bell__panel', role: 'dialog', 'aria-label': 'Notificações', hidden: true },
    h('div', { class: 'bell__head' }, h('strong', null, 'Notificações'), readOnly ? null : markAll),
    list);
  const root = h('div', { class: 'bell' }, button, panel);

  function paint() {
    const data = store.data;
    const unread = data?.unread ?? 0;
    badge.hidden = unread === 0;
    badge.textContent = unread ? badgeText(unread) : '';
    button.setAttribute('aria-label', unread ? `Notificações: ${unread} não lida${unread === 1 ? '' : 's'}` : 'Notificações');
    markAll.hidden = unread === 0;
    if (!open) return;
    if (!data) return setChildren(list, h('p', { class: 'bell__empty muted' }, 'Carregando…'));
    if (!data.notifications.length) return setChildren(list, h('p', { class: 'bell__empty muted' }, 'Nenhuma notificação por enquanto.'));
    return setChildren(list, data.notifications.map(item));
  }

  function item(n) {
    const level = NOTIFICATION_LEVELS[n.level] ?? NOTIFICATION_LEVELS.info;
    const inner = [
      h('span', { class: `bell__dot bell__dot--${level.tone}`, 'aria-hidden': 'true' }),
      h('span', { class: 'bell__text' },
        h('span', { class: 'bell__title' }, n.title, n.read ? null : h('span', { class: 'visually-hidden' }, ' (não lida)')),
        h('span', { class: 'bell__body' }, n.body),
        h('span', { class: 'bell__meta muted' }, `${level.label} · ${timeAgo(n.createdAt)}`)),
    ];
    return h('button', { type: 'button', class: `bell__item${n.read ? '' : ' is-unread'}`, onClick: () => select(n) }, inner);
  }

  async function select(n) {
    if (!n.read && !readOnly) {
      n.read = true; // atualiza na hora; o servidor confirma e corrige o número
      if (store.data) store.data.unread = Math.max(0, store.data.unread - 1);
      publish();
      post('/notifications/read', { ids: [n.id] }).then((r) => { if (store.data) { store.data.unread = r.unread; publish(); } }).catch(() => refresh());
    }
    if (n.link) {
      close();
      ctx.navigate(n.link);
    }
  }

  async function markAllRead() {
    if (readOnly || !store.data) return;
    for (const n of store.data.notifications) n.read = true;
    store.data.unread = 0;
    publish();
    try {
      await post('/notifications/read', { all: true });
    } catch {
      await refresh();
    }
  }

  function onDocumentClick(event) {
    if (!root.isConnected) return document.removeEventListener('click', onDocumentClick, true);
    if (open && !root.contains(event.target)) close();
    return undefined;
  }
  function onKeydown(event) {
    if (!root.isConnected) return document.removeEventListener('keydown', onKeydown);
    if (open && event.key === 'Escape') {
      close();
      button.focus();
    }
    return undefined;
  }

  function toggle() {
    if (open) close();
    else show();
  }
  function show() {
    open = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    paint();
    refresh(); // ao abrir, sempre a lista mais nova
  }
  function close() {
    open = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  const listener = () => {
    if (!root.isConnected) return store.listeners.delete(listener);
    return paint();
  };
  store.listeners.add(listener);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeydown);
  paint();
  ensurePolling();
  if (!store.data) refresh();
  return root;
}
