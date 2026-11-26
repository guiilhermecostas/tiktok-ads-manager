import { get, patch, post } from '../api.js';
import { h } from '../dom.js';
import { setSession } from '../state.js';
import { formatDate, USER_STATUS } from '../format.js';
import { badge, button, confirmDialog, emptyState, toast } from '../ui.js';
import { adminNav } from './admin-nav.js';
import { pageHeader } from './layout.js';

const FILTERS = [
  ['pending', 'Pendentes'],
  ['approved', 'Aprovadas'],
  ['rejected', 'Rejeitadas'],
  ['blocked', 'Bloqueadas'],
  ['all', 'Todas'],
];

const AUDIT_ACTIONS = { impersonation_start: 'Entrou na conta', impersonation_end: 'Saiu da conta', status_change: 'Mudou o status', notification_send: 'Enviou notificação', notification_change: 'Mudou notificação' };
const whenText = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function adminView(ctx) {
  let filter = 'pending';
  const container = h('div');

  async function load() {
    const [{ counts }, { users }, audit] = await Promise.all([
      get('/admin/stats'),
      get(`/admin/users${filter === 'all' ? '' : `?status=${filter}`}`),
      get('/admin/audit').catch(() => ({ entries: [] })), // o histórico é um extra: se falhar, a tela segue
    ]);
    container.replaceChildren(draw(counts, users, audit.entries));
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

  /** Um clique: abre a conta da pessoa (somente leitura, até 1 hora) e leva para o início dela; a faixa do topo traz o "Voltar ao admin". */
  async function enterAccount(user, trigger) {
    trigger.disabled = true;
    try {
      setSession(await post(`/admin/users/${user.id}/impersonate`));
      ctx.navigate('/');
    } catch (err) {
      trigger.disabled = false;
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
    const access = button('Acessar conta', { small: true, onClick: (e) => enterAccount(user, e.currentTarget) });
    access.title = `Ver a conta de ${user.name} como ela vê (somente leitura)`;
    const byStatus = {
      pending: [approve, reject],
      approved: [access, block],
      rejected: [approve],
      blocked: [button('Reativar', { small: true, variant: 'primary', onClick: () => setStatus(user, 'approved') })],
    };
    return h('div', { class: 'cell-actions' }, byStatus[user.status]);
  }

  function draw(counts, users, auditEntries = []) {
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

    const audit = auditEntries.length
      ? h(
          'section',
          { class: 'admin__audit' },
          h('h2', { class: 'form-section__title' }, 'Registro de ações'),
          h('p', { class: 'muted' }, 'As últimas ações do administrador: quem entrou na conta de quem e as mudanças de status.'),
          h(
            'div',
            { class: 'card table-wrap' },
            h(
              'table',
              { class: 'table table--stack' },
              h('thead', null, h('tr', null, ['Quando', 'Administrador', 'Ação', 'Detalhe'].map((t) => h('th', { scope: 'col' }, t)))),
              h('tbody', null, auditEntries.map((e) => h('tr', null,
                h('td', { 'data-label': 'Quando', class: 'muted' }, whenText(e.createdAt)),
                h('td', { 'data-label': 'Administrador' }, e.adminName ?? '—'),
                h('td', { 'data-label': 'Ação' }, AUDIT_ACTIONS[e.action] ?? e.action),
                h('td', { 'data-label': 'Detalhe' }, e.detail ?? '—'),
              ))),
            ),
          ),
        )
      : null;

    return h('div', null, pageHeader('Administração', 'Aprove, rejeite ou bloqueie contas e entre na conta de um usuário para ver o que ele vê.'), adminNav('/admin'), tabs, list, audit);
  }

  await load();
  return { element: container };
}
