import { BODY_MAX, EXPIRY_DAYS, NOTIFICATION_AUDIENCES, NOTIFICATION_LEVELS, TITLE_MAX, validateNotificationInput } from '/shared/notifications.js';
import { del, get, patch, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, toast } from '../ui.js';
import { adminNav } from './admin-nav.js';
import { pageHeader } from './layout.js';
import { timeAgo } from './notifications-bell.js';

/**
 * Administração → Notificações: o admin escreve um aviso e escolhe quem recebe (todos ou uma pessoa), o tipo, um atalho para uma tela do
 * sistema e por quanto tempo vale. Cada envio aparece no sino dos usuários; aqui dá para ver quantos já leram, desativar ou excluir.
 * As mesmas regras do servidor (shared/notifications.js) validam o formulário antes de enviar; o servidor valida de novo.
 */
const LINKS = [['', 'Sem atalho'], ['/', 'Início'], ['/manager', 'Gerenciador'], ['/creatives', 'Criativos'], ['/catalog', 'Catálogo'], ['/business-centers', 'Contas TikTok'], ['/balance', 'Saldo'], ['/reports', 'Relatórios'], ['/team', 'Colaboradores']];

const stateOf = (n) => {
  if (!n.active) return ['Desativada', 'neutral'];
  if (n.expiresAt && new Date(n.expiresAt).getTime() <= Date.now()) return ['Vencida', 'warning'];
  return ['Ativa', 'success'];
};
const whenText = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function adminNotificationsView() {
  const container = h('div');
  let people = [];

  async function load() {
    const [{ notifications }, approved] = await Promise.all([get('/admin/notifications'), get('/admin/users?status=approved')]);
    people = approved.users.filter((u) => u.role !== 'admin');
    setChildren(container, draw(notifications));
  }

  async function reload() {
    try {
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- formulário ----------
  function composer() {
    const title = field('Título', { type: 'text', maxlength: TITLE_MAX, placeholder: 'Ex.: Nova função no Saldo' });
    const body = field('Mensagem', { as: 'textarea', rows: 4, maxlength: BODY_MAX, placeholder: 'O que a pessoa precisa saber.' }, { hint: `Até ${BODY_MAX} caracteres.` });
    const level = field('Tipo', { as: 'select', options: Object.entries(NOTIFICATION_LEVELS).map(([id, l]) => [id, l.label]) });
    const audience = field('Quem recebe', { as: 'select', options: Object.entries(NOTIFICATION_AUDIENCES) });
    const person = field('Pessoa', { as: 'select', options: [['', 'Escolha…'], ...people.map((u) => [String(u.id), `${u.name} · ${u.email}`])] });
    const link = field('Ao clicar, abrir', { as: 'select', options: LINKS });
    const expiry = field('Validade', { as: 'select', options: [['', 'Sem prazo'], ...EXPIRY_DAYS.map((d) => [String(d), `${d} ${d === 1 ? 'dia' : 'dias'}`])] });
    const error = h('div', { 'aria-live': 'polite' });
    const preview = h('div', { class: 'notif-preview' });
    const submit = button('Enviar notificação', { variant: 'primary', type: 'submit' });

    const read = () => ({
      title: title.control.value,
      body: body.control.value,
      level: level.control.value,
      audience: audience.control.value,
      ...(audience.control.value === 'user' ? { userId: person.control.value ? Number(person.control.value) : null } : {}),
      link: link.control.value,
      expiresInDays: expiry.control.value ? Number(expiry.control.value) : null,
    });

    function paint() {
      person.element.hidden = audience.control.value !== 'user';
      const v = read();
      const l = NOTIFICATION_LEVELS[v.level];
      setChildren(preview,
        h('p', { class: 'muted notif-preview__label' }, 'Como aparece no sino'),
        h('div', { class: 'bell__item is-unread notif-preview__item' },
          h('span', { class: `bell__dot bell__dot--${l.tone}`, 'aria-hidden': 'true' }),
          h('span', { class: 'bell__text' },
            h('span', { class: 'bell__title' }, v.title.trim() || 'Título da notificação'),
            h('span', { class: 'bell__body' }, v.body.trim() || 'A mensagem aparece aqui.'),
            h('span', { class: 'bell__meta muted' }, `${l.label} · agora`))));
    }
    // Ao mexer em qualquer campo o aviso de erro anterior some (não fica um erro velho na tela depois de corrigir).
    for (const el of [title, body, level, audience, person, link, expiry]) el.control.addEventListener('input', () => { setChildren(error); paint(); });
    paint();

    async function onSubmit(event) {
      event.preventDefault();
      setChildren(error);
      const payload = read();
      const { errors } = validateNotificationInput(payload);
      if (errors.length) return setChildren(error, alertBox(errors[0].message));
      submit.disabled = true;
      try {
        await post('/admin/notifications', payload);
        toast('Notificação enviada.');
        await reload();
      } catch (err) {
        submit.disabled = false;
        setChildren(error, alertBox(err.message));
      }
      return undefined;
    }

    return h('form', { class: 'card card--pad notif-form', novalidate: true, onSubmit },
      h('h2', { class: 'form-section__title' }, 'Nova notificação'),
      h('div', { class: 'form-grid' },
        h('div', { class: 'form-grid__wide' }, title.element),
        h('div', { class: 'form-grid__wide' }, body.element),
        level.element, audience.element, person.element, link.element, expiry.element),
      preview,
      error,
      h('div', { class: 'notif-form__actions' }, submit));
  }

  // ---------- lista ----------
  async function toggle(n) {
    try {
      await patch(`/admin/notifications/${n.id}`, { active: !n.active });
      toast(n.active ? 'Notificação desativada.' : 'Notificação reativada.');
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function remove(n) {
    const ok = await confirmDialog({ title: 'Excluir notificação', message: `Excluir "${n.title}"? Ela some do sino de todos e não dá para desfazer.`, confirmLabel: 'Excluir', danger: true });
    if (!ok) return;
    try {
      await del(`/admin/notifications/${n.id}`);
      toast('Notificação excluída.');
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function sentList(list) {
    if (!list.length) return h('div', { class: 'card' }, emptyState({ title: 'Nenhuma notificação enviada', text: 'Escreva a primeira acima: ela aparece no sino dos usuários.' }));
    return h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
      h('thead', null, h('tr', null, ['Enviada', 'Notificação', 'Para', 'Leram', 'Situação', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, list.map((n) => {
        const [label, tone] = stateOf(n);
        const l = NOTIFICATION_LEVELS[n.level] ?? NOTIFICATION_LEVELS.info;
        return h('tr', null,
          h('td', { 'data-label': 'Enviada', class: 'muted' }, whenText(n.createdAt), h('span', { class: 'acc-id' }, timeAgo(n.createdAt))),
          h('td', { 'data-label': 'Notificação' }, h('span', { class: 'cell-strong' }, n.title), h('span', { class: 'acc-id notif-body' }, n.body), badge(l.label, l.tone), n.link ? h('span', { class: 'acc-id' }, `Abre ${n.link}`) : null),
          h('td', { 'data-label': 'Para' }, n.audience === 'all' ? NOTIFICATION_AUDIENCES.all : (n.targetName ?? 'Conta removida'), n.audience === 'user' && n.targetEmail ? h('span', { class: 'acc-id' }, n.targetEmail) : null),
          h('td', { 'data-label': 'Leram', class: 'num' }, `${n.readCount} de ${n.recipients}`),
          h('td', { 'data-label': 'Situação' }, badge(label, tone), n.expiresAt ? h('span', { class: 'acc-id' }, `Vale até ${whenText(n.expiresAt)}`) : null),
          h('td', { 'data-label': 'Ações' }, h('div', { class: 'cell-actions' },
            button(n.active ? 'Desativar' : 'Reativar', { small: true, onClick: () => toggle(n) }),
            button('Excluir', { small: true, variant: 'danger-ghost', onClick: () => remove(n) }))));
      }))));
  }

  function draw(list) {
    return h('div', null,
      pageHeader('Administração', 'Envie avisos para o sino dos usuários: novidades, manutenção, recados para uma pessoa.'),
      adminNav('/admin/notifications'),
      composer(),
      h('section', { class: 'notif-sent' }, h('h2', { class: 'form-section__title' }, 'Enviadas'), sentList(list)));
  }

  await load();
  return { element: container };
}
