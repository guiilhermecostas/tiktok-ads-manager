import { AREAS, hasFullAccess } from '/shared/permissions.js';
import { del, get, patch, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, badge, button, confirmDialog, emptyState, openModal, toast, field } from '../ui.js';
import { createAreaPicker } from './area-picker.js';
import { avatarEl } from './avatar.js';
import { pageHeader } from './layout.js';

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const formatDate = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const expired = (invite) => new Date(invite.expiresAt).getTime() <= Date.now();

/** Selos das áreas liberadas (ou um só, "Acesso total"). */
function accessBadges(areas) {
  if (hasFullAccess(areas)) return badge('Acesso total', 'success');
  return h('span', { class: 'team__areas' }, areas.map((id) => badge(AREA_LABEL[id] ?? id, 'neutral')));
}

/**
 * Colaboradores: o dono convida pessoas por e-mail e escolhe o que cada uma acessa. Cada colaborador entra com o PRÓPRIO
 * e-mail e senha (ninguém compartilha login). Só o dono da conta vê esta tela (o servidor também exige).
 */
export async function teamView() {
  const data = await get('/team');
  const body = h('div');
  let busy = false;

  async function reload() {
    Object.assign(data, await get('/team'));
    draw();
  }

  /** Executa uma ação, avisa o resultado e atualiza a lista; erros viram aviso (nunca derrubam a tela). */
  async function run(action, success) {
    if (busy) return;
    busy = true;
    draw();
    try {
      const result = await action();
      if (success) toast(typeof success === 'function' ? success(result) : success);
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      busy = false;
      draw();
    }
  }

  // ---------- convidar ----------
  function inviteForm() {
    const name = field('Nome da pessoa', { name: 'name', required: true, maxlength: 80, autocomplete: 'off' });
    const email = field('E-mail dela', { type: 'email', name: 'email', required: true, maxlength: 254, autocomplete: 'off' }, { hint: 'O convite com o link para criar a senha é enviado para este e-mail.' });
    const picker = createAreaPicker({ initial: [] });
    const errorSlot = h('div');
    const submit = button('Enviar convite', { variant: 'primary', type: 'submit' });
    const form = h(
      'form',
      {
        class: 'form',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          errorSlot.replaceChildren();
          if (!picker.get().length) {
            errorSlot.replaceChildren(alertBox('Escolha ao menos uma área de acesso.'));
            return;
          }
          submit.disabled = true;
          try {
            const result = await post('/team/invites', { name: name.control.value, email: email.control.value, areas: picker.get() });
            modal.close();
            if (result.emailSent) toast(`Convite enviado para ${result.invite.email}.`);
            else toast('Convite criado, mas o e-mail não pôde ser enviado agora. Use “Reenviar” na lista.', 'danger');
            await reload();
          } catch (err) {
            errorSlot.replaceChildren(alertBox(err.message));
            submit.disabled = false;
          }
        },
      },
      errorSlot,
      name.element,
      email.element,
      picker.element,
      h('div', { class: 'modal__actions' }, button('Cancelar', { onClick: () => modal.close() }), submit),
    );
    const modal = openModal({ title: 'Convidar colaborador', body: form, size: 'md', dismissOnOverlay: false });
    name.control.focus();
  }

  // ---------- editar acesso ----------
  function editAccess(member) {
    const picker = createAreaPicker({ initial: member.areas });
    const errorSlot = h('div');
    const save = button('Salvar acesso', { variant: 'primary', type: 'submit' });
    const form = h(
      'form',
      {
        class: 'form',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          errorSlot.replaceChildren();
          if (!picker.get().length) {
            errorSlot.replaceChildren(alertBox('Escolha ao menos uma área. Para tirar todo o acesso, remova o colaborador.'));
            return;
          }
          save.disabled = true;
          try {
            await patch(`/team/members/${member.id}`, { areas: picker.get() });
            modal.close();
            toast(`Acesso de ${member.name} atualizado.`);
            await reload();
          } catch (err) {
            errorSlot.replaceChildren(alertBox(err.message));
            save.disabled = false;
          }
        },
      },
      errorSlot,
      h('p', { class: 'muted' }, `${member.name} · ${member.email}. A mudança vale na hora, sem precisar entrar de novo.`),
      picker.element,
      h('div', { class: 'modal__actions' }, button('Cancelar', { onClick: () => modal.close() }), save),
    );
    const modal = openModal({ title: 'Editar acesso', body: form, size: 'md', dismissOnOverlay: false });
  }

  async function removeMember(member) {
    const ok = await confirmDialog({
      title: 'Remover colaborador',
      message: `${member.name} perde o acesso na hora e a conta dele é apagada. Os criativos, campanhas e contas que ele usou continuam com você. Você pode convidar de novo depois.`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (ok) await run(() => del(`/team/members/${member.id}`), `${member.name} foi removido(a).`);
  }

  async function cancelInvite(invite) {
    const ok = await confirmDialog({ title: 'Cancelar convite', message: `O link enviado para ${invite.email} deixa de funcionar.`, confirmLabel: 'Cancelar convite', danger: true });
    if (ok) await run(() => del(`/team/invites/${invite.id}`), 'Convite cancelado.');
  }

  // ---------- lista ----------
  const head = (...labels) => h('thead', null, h('tr', null, labels.map((t) => h('th', { scope: 'col' }, t))));
  // Colaborador ativo: com a foto que ele configurou; convite pendente: só as iniciais (a pessoa ainda não tem conta).
  const person = (p) =>
    h('div', { class: 'team__person' }, avatarEl({ id: p.userId, name: p.name, avatarVersion: p.avatarVersion ?? null }, { size: 'md' }), h('div', null, h('span', { class: 'cell-strong' }, p.name), h('span', { class: 'hub-meta' }, p.email)));

  function draw() {
    const { members, invites } = data;
    if (!members.length && !invites.length) {
      setChildren(body, h('div', { class: 'card' }, emptyState({
        title: 'Nenhum colaborador ainda',
        text: 'Convide alguém pelo e-mail e escolha o que a pessoa pode acessar (criativos, campanhas, relatórios, contas ou tudo). Ela entra com o próprio e-mail e senha: você nunca precisa compartilhar o seu login.',
        action: data.emailEnabled ? button('Convidar colaborador', { variant: 'primary', onClick: inviteForm }) : null,
      })));
      return;
    }
    setChildren(
      body,
      members.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' }, head('Colaborador', 'Acesso', 'Desde', 'Ações'), h('tbody', null, members.map((m) =>
            h('tr', null,
              h('td', { 'data-label': 'Colaborador' }, person(m)),
              h('td', { 'data-label': 'Acesso' }, accessBadges(m.areas)),
              h('td', { class: 'muted', 'data-label': 'Desde' }, formatDate(m.createdAt)),
              h('td', { 'data-label': 'Ações' }, h('div', { class: 'team__actions' },
                button('Editar acesso', { small: true, disabled: busy, ariaLabel: `Editar acesso de ${m.name}`, onClick: () => editAccess(m) }),
                button('Remover', { small: true, variant: 'danger-ghost', disabled: busy, ariaLabel: `Remover ${m.name}`, onClick: () => removeMember(m) }),
              )),
            )))))
        : null,
      invites.length ? h('h2', { class: 'card__title section-title' }, 'Convites pendentes') : null,
      invites.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' }, head('Convidado', 'Acesso', 'Situação', 'Ações'), h('tbody', null, invites.map((i) =>
            h('tr', null,
              h('td', { 'data-label': 'Convidado' }, person(i)),
              h('td', { 'data-label': 'Acesso' }, accessBadges(i.areas)),
              h('td', { 'data-label': 'Situação' }, expired(i) ? badge('Expirado', 'danger') : badge(`Vale até ${formatDate(i.expiresAt)}`, 'warning')),
              h('td', { 'data-label': 'Ações' }, h('div', { class: 'team__actions' },
                button('Reenviar', { small: true, disabled: busy || !data.emailEnabled, ariaLabel: `Reenviar convite para ${i.email}`, onClick: () => run(() => post(`/team/invites/${i.id}/resend`), `Convite reenviado para ${i.email}.`) }),
                button('Cancelar', { small: true, variant: 'danger-ghost', disabled: busy, ariaLabel: `Cancelar convite de ${i.email}`, onClick: () => cancelInvite(i) }),
              )),
            )))))
        : null,
    );
  }

  draw();
  return {
    element: h(
      'div',
      null,
      pageHeader('Colaboradores', 'Dê acesso à sua conta para outras pessoas, só ao que cada uma precisa. Cada colaborador entra com o próprio e-mail e senha.', data.emailEnabled ? button('Convidar colaborador', { variant: 'primary', onClick: inviteForm }) : null),
      data.emailEnabled ? null : alertBox('O envio de e-mails não está configurado neste servidor, por isso não é possível convidar agora. Peça ao administrador para configurar o Resend (RESEND_API_KEY e APP_URL).', 'warning'),
      body,
    ),
  };
}
