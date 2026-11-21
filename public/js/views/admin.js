import { get, patch } from '../api.js';
import { h } from '../dom.js';
import { formatDate, USER_STATUS } from '../format.js';
import { badge, button, confirmDialog, emptyState, toast } from '../ui.js';
import { pageHeader } from './layout.js';

const FILTERS = [
  ['pending', 'Pendentes'],
  ['approved', 'Aprovadas'],
  ['rejected', 'Rejeitadas'],
  ['blocked', 'Bloqueadas'],
  ['all', 'Todas'],
];

export async function adminView() {
  let filter = 'pending';
  const container = h('div');

  async function load() {
    const [{ counts }, { users }] = await Promise.all([
      get('/admin/stats'),
      get(`/admin/users${filter === 'all' ? '' : `?status=${filter}`}`),
    ]);
    container.replaceChildren(draw(counts, users));
  }

  async function reload() {
    try {
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function setStatus(user, status, { confirm } = {}) {
    if (confirm) {
      const ok = await confirmDialog({ title: confirm.title, message: confirm.message, confirmLabel: confirm.label, danger: true });
      if (!ok) return;
    }
    try {
      await patch(`/admin/users/${user.id}/status`, { status });
      toast(`${user.name}: ${USER_STATUS[status].label.toLowerCase()}.`);
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function actionsFor(user) {
    if (user.role === 'admin') return h('span', { class: 'muted' }, '—');
    const approve = button('Aprovar', { small: true, variant: 'primary', onClick: () => setStatus(user, 'approved') });
    const reject = button('Rejeitar', {
      small: true,
      onClick: () => setStatus(user, 'rejected', { confirm: { title: 'Rejeitar cadastro', message: `Rejeitar o cadastro de ${user.name}?`, label: 'Rejeitar' } }),
    });
    const block = button('Bloquear', {
      small: true,
      variant: 'danger-ghost',
      onClick: () => setStatus(user, 'blocked', { confirm: { title: 'Bloquear conta', message: `Bloquear ${user.name}? O acesso será encerrado imediatamente.`, label: 'Bloquear' } }),
    });
    const byStatus = {
      pending: [approve, reject],
      approved: [block],
      rejected: [approve],
      blocked: [button('Reativar', { small: true, variant: 'primary', onClick: () => setStatus(user, 'approved') })],
    };
    return h('div', { class: 'cell-actions' }, byStatus[user.status]);
  }

  function draw(counts, users) {
    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist' },
      FILTERS.map(([key, label]) => {
        const count = key === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[key];
        return h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(filter === key),
            class: `tab${filter === key ? ' is-active' : ''}`,
            onClick: () => {
              filter = key;
              reload();
            },
          },
          label,
          h('span', { class: `tab__count${key === 'pending' && count > 0 ? ' tab__count--alert' : ''}` }, String(count)),
        );
      }),
    );

    const rows = users.map((u) => {
      const status = USER_STATUS[u.status];
      return h(
        'tr',
        null,
        h('td', { class: 'cell-strong' }, u.name, u.role === 'admin' ? h('span', { class: 'chip' }, 'admin') : null),
        h('td', null, u.email),
        h('td', null, u.company ?? '—'),
        h('td', { class: 'muted' }, formatDate(u.createdAt)),
        h('td', null, badge(status.label, status.tone)),
        h('td', null, actionsFor(u)),
      );
    });

    const list = users.length
      ? h(
          'div',
          { class: 'card table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('thead', null, h('tr', null, ['Nome', 'E-mail', 'Empresa', 'Cadastro', 'Status', 'Ações'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, rows),
          ),
        )
      : h('div', { class: 'card' }, emptyState({ title: 'Nada por aqui', text: filter === 'pending' ? 'Nenhuma conta aguardando aprovação.' : 'Nenhuma conta neste filtro.' }));

    return h('div', null, pageHeader('Administração', 'Aprove, rejeite ou bloqueie contas de usuários.'), tabs, list);
  }

  await load();
  return { element: container };
}
