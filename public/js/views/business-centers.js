import { del, get, patch, post } from '../api.js';
import { h, icon } from '../dom.js';
import { formatDate } from '../format.js';
import { state } from '../state.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, toast } from '../ui.js';
import { accountsTabs } from './accounts-tabs.js';
import { connectByLink } from './connect-link.js';
import { pageHeader } from './layout.js';

const isAdmin = () => state.user.role === 'admin';

/**
 * Modal de cadastro/edição. Na edição, o token só é enviado se o campo for preenchido (rotação).
 * O compartilhamento com a equipe só aparece (e só é aceito pelo servidor) para administradores.
 */
function businessCenterForm(existing, onSaved, oauth = { available: false }) {
  const byLink = existing?.authType === 'oauth'; // conexão feita por link: não tem ID de BC nem token para editar
  const name = field('Nome interno', { type: 'text', required: true, maxlength: 80, value: existing?.name ?? '', placeholder: 'Ex.: Loja Principal' });
  const bcId = byLink ? { element: null } : field('ID da Business Center', { type: 'text', inputmode: 'numeric', required: true, maxlength: 24, value: existing?.bcId ?? '', disabled: Boolean(existing), autocomplete: 'off' }, {
    hint: 'Encontre em TikTok Business Center → Configurações → Informações da empresa.',
  });
  const token = byLink ? { element: null, control: { value: '' } } : field(existing ? 'Novo token de acesso (opcional)' : 'Token de acesso', { type: 'password', autocomplete: 'off', required: !existing, maxlength: 512, spellcheck: 'false' }, {
    hint: existing
      ? 'Deixe em branco para manter o token atual. O token salvo nunca é exibido.'
      : 'Token da Marketing API com acesso a esta Business Center. Fica criptografado no servidor e só você (e o administrador) pode gerenciá-lo.',
  });
  const sharedBox = h('input', { type: 'checkbox', checked: existing?.shared === true });
  const sharedField = isAdmin()
    ? h('label', { class: 'check' }, sharedBox, h('span', null, 'Compartilhar com toda a equipe (todos os usuários aprovados poderão ver os dados desta BC)'))
    : null;
  // Sem o app do TikTok configurado no servidor, o token manual é o único caminho: explica o motivo.
  const notice = !existing && !oauth.available
    ? alertBox(
        isAdmin()
          ? `A conexão por link ainda não está habilitada. Para ativá-la, cadastre o app do TikTok no .env (TIKTOK_APP_ID, TIKTOK_APP_SECRET) e registre no app a URI de retorno ${oauth.redirectUri ?? '(…/api/tiktok/callback)'}.`
          : 'A conexão por link ainda não foi habilitada neste servidor. Use o token de acesso ou peça ao administrador para ativá-la.',
        'warning',
      )
    : null;
  const errorSlot = h('div');
  const submit = button(existing ? 'Salvar' : 'Validar e conectar', { variant: 'primary', type: 'submit' });
  const form = h(
    'form',
    {
      class: 'form modal__body',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        errorSlot.replaceChildren();
        submit.disabled = true;
        submit.textContent = 'Validando com o TikTok…';
        try {
          if (existing) {
            const payload = { name: name.control.value };
            if (!byLink && token.control.value) payload.accessToken = token.control.value;
            if (isAdmin()) payload.shared = sharedBox.checked;
            await patch(`/tiktok/business-centers/${existing.id}`, payload);
          } else {
            const payload = { name: name.control.value, bcId: bcId.control.value, accessToken: token.control.value };
            if (isAdmin()) payload.shared = sharedBox.checked;
            await post('/tiktok/business-centers', payload);
          }
          token.control.value = '';
          modal.close();
          toast(existing ? 'Business Center atualizada.' : 'Business Center conectada e sincronizada.');
          await onSaved();
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
          submit.disabled = false;
          submit.textContent = existing ? 'Salvar' : 'Validar e conectar';
        }
      },
    },
    notice,
    errorSlot,
    byLink ? h('p', { class: 'muted' }, 'Esta conexão foi feita por link de autorização. Para renovar o acesso, use “Reautorizar” na lista.') : null,
    name.element,
    bcId.element,
    token.element,
    sharedField,
    h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
  );
  const modal = openModal({ title: existing ? 'Editar Business Center' : 'Conectar com token de acesso', body: form });
}

export async function businessCentersView() {
  const container = h('div');

  async function load() {
    const { configured, oauth, businessCenters } = await get('/tiktok/business-centers');
    container.replaceChildren(draw(configured, oauth ?? { available: false }, businessCenters));
  }
  const reload = async () => {
    try {
      await load();
    } catch (err) {
      container.replaceChildren(alertBox(err.message));
    }
  };

  async function sync(bc, trigger) {
    trigger.disabled = true;
    try {
      await post(`/tiktok/business-centers/${bc.id}/sync`);
      toast(`${bc.name}: contas sincronizadas.`);
    } catch (err) {
      toast(err.message, 'danger');
    }
    await reload();
  }

  async function remove(bc) {
    const ok = await confirmDialog({
      title: 'Remover Business Center',
      message: `Remover "${bc.name}"? O token será apagado do servidor e as contas de anúncio dela deixam de aparecer no sistema${bc.shared ? ' para toda a equipe' : ''}.`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/tiktok/business-centers/${bc.id}`);
      toast('Business Center removida.');
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function visibilityBadge(bc) {
    if (bc.shared) return badge('Compartilhada', 'success');
    return badge(bc.owned ? 'Só você' : 'Privada', 'neutral');
  }

  function draw(configured, oauth, businessCenters) {
    // Com o app do TikTok configurado: pop-up do link (padrão). Sem ele: formulário com token.
    const startConnect = () => (oauth.available ? connectByLink({ onDone: reload, onUseToken: () => businessCenterForm(null, reload, oauth) }) : businessCenterForm(null, reload, oauth));
    const connectButton = button([icon('plus', 16), ' Conectar Business Center'], { variant: 'primary', disabled: !configured, onClick: startConnect });
    const header = pageHeader('Contas TikTok', 'Conecte suas Business Centers. Os dados delas alimentam o Início, TikTok Ads e Campanhas.', connectButton);
    const notice = configured
      ? null
      : alertBox('O servidor ainda não tem a TOKEN_ENCRYPTION_KEY configurada (arquivo .env). Peça ao administrador para defini-la e reiniciar o sistema: ela protege os tokens salvos.');

    if (!businessCenters.length) {
      return h(
        'div',
        null,
        header,
        accountsTabs('/business-centers'),
        notice,
        h(
          'div',
          { class: 'card' },
          emptyState({
            title: 'Nenhuma Business Center conectada',
            text: oauth.available
              ? 'Gere um link, abra no navegador em que você está logado na Business Center do TikTok e libere o acesso. Sem copiar tokens. O acesso fica criptografado e é usado só para ler suas contas e publicar campanhas pausadas.'
              : 'Informe o ID da sua Business Center e um token de acesso da Marketing API. O token é validado no TikTok, guardado criptografado e usado só para ler suas contas e publicar campanhas pausadas.',
            action: configured ? button([icon('plus', 16), ' Conectar Business Center'], { variant: 'primary', onClick: startConnect }) : null,
          }),
        ),
      );
    }

    const admin = isAdmin();
    const rows = businessCenters.map((bc) => {
      const actions = bc.canManage
        ? h(
            'div',
            { class: 'cell-actions' },
            button('Sincronizar', { small: true, onClick: (e) => sync(bc, e.currentTarget) }),
            bc.authType === 'oauth' && oauth.available ? button('Reautorizar', { small: true, onClick: () => connectByLink({ initialName: bc.name, onDone: reload }) }) : null,
            button('Editar', { small: true, onClick: () => businessCenterForm(bc, reload, oauth) }),
            button('Remover', { small: true, variant: 'danger-ghost', onClick: () => remove(bc) }),
          )
        : h('span', { class: 'muted' }, 'Gerenciada pelo administrador');
      return h(
        'tr',
        null,
        h('td', { class: 'cell-strong' }, bc.name, bc.lastError ? h('p', { class: 'muted cell-note' }, bc.lastError) : null),
        h('td', null, bc.bcId ? h('span', { class: 'code' }, bc.bcId) : h('span', { class: 'muted' }, '—'), ' ', badge(bc.authType === 'oauth' ? 'Por link' : 'Token', 'neutral'), bc.viaProxy ? ' ' : null, bc.viaProxy ? badge('Via proxy', 'success') : null),
        admin ? h('td', null, bc.owned ? 'Você' : (bc.ownerName ?? '—')) : null,
        h('td', null, visibilityBadge(bc)),
        h('td', null, bc.status === 'active' ? badge('Ativa', 'success') : badge('Acesso com erro', 'danger')),
        h('td', null, String(bc.advertiserCount)),
        h('td', { class: 'muted' }, bc.lastSyncedAt ? formatDate(bc.lastSyncedAt) : '—'),
        h('td', null, actions),
      );
    });

    const heads = ['Nome', 'ID da BC', admin ? 'Dono' : null, 'Visibilidade', 'Status', 'Contas de anúncio', 'Última sincronização', ''].filter((t) => t !== null);
    return h(
      'div',
      null,
      header,
      accountsTabs('/business-centers'),
      notice,
      h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, heads.map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows))),
      admin ? h('p', { class: 'muted section-note' }, 'Como administrador você vê as Business Centers de todos os usuários e pode compartilhar uma BC com a equipe em Editar. Os dados de BCs privadas de outros usuários não aparecem nas suas telas.') : null,
    );
  }

  await load();
  return { element: container };
}
