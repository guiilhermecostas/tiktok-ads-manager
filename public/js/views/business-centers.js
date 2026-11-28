import { del, get, patch, post } from '../api.js';
import { h, icon } from '../dom.js';
import { formatDate } from '../format.js';
import { state } from '../state.js';
import { alertBox, button, confirmDialog, emptyState, field, openModal, toast } from '../ui.js';
import { openContextMenu } from './context-menu.js';
import { connectByLink } from './connect-link.js';
import { createAdvertisersDialog } from './create-advertisers.js';
import { linkPixelDialog } from './link-pixel.js';
import { hubLayout, plural } from './hub.js';

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
      toast(`${bc.name}: contas atualizadas.`);
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

  /** Copia o ID para a área de transferência (e avisa). */
  async function copyId(id) {
    try {
      await navigator.clipboard.writeText(id);
      toast('ID copiado.');
    } catch {
      toast('Não foi possível copiar. Selecione o número e copie manualmente.', 'danger');
    }
  }

  const visibilityLabel = (bc) => (bc.shared ? 'Compartilhada' : bc.owned ? 'Só você' : 'Privada');

  /** Moeda(s) das contas em texto simples ("USD"; com mais de uma, "USD (20) · BRL (12)"). */
  function currencyText(bc) {
    const list = bc.currencies ?? [];
    if (!list.length) return null;
    return list.map((c) => `${c.code ?? 'sem moeda'}${list.length > 1 ? ` (${c.accounts})` : ''}`).join(' · ');
  }

  /**
   * Business Centers do TikTok desta conexão, em fichinhas (ID + quantas contas; clique copia o ID). Uma conexão por link pode cobrir várias BCs:
   * a primeira aparece e o resto fica atrás de "+N" (sem ocupar espaço).
   */
  function bcChips(bc) {
    const groups = bc.bcGroups ?? [];
    if (!groups.length) return h('p', { class: 'bc-card__hint' }, bc.authType === 'oauth' ? 'O TikTok ainda não informou o ID. Use “Atualizar” para buscar de novo.' : 'ID da BC não informado.');
    const known = groups.reduce((sum, g) => sum + g.accounts, 0);
    const unknown = Math.max(0, bc.advertiserCount - known);
    const chip = (g) => h('button', { type: 'button', class: 'bc-chip', title: 'Clique para copiar o ID', 'aria-label': `Copiar o ID ${g.id} (${plural(g.accounts, 'conta', 'contas')})`, onClick: () => copyId(g.id) }, h('span', { class: 'bc-chip__id' }, g.id), h('span', { class: 'bc-chip__n' }, String(g.accounts)));
    const chips = groups.map(chip);
    if (unknown > 0) chips.push(h('span', { class: 'bc-chip bc-chip--muted', title: 'Contas sem Business Center informada' }, h('span', { class: 'bc-chip__id' }, 'Sem BC'), h('span', { class: 'bc-chip__n' }, String(unknown))));
    const VISIBLE = 1; // uma fichinha à vista: a altura dos cartões não depende de quantas BCs a conexão tem
    return h(
      'div',
      { class: 'bc-chips', role: 'group', 'aria-label': groups.length === 1 ? 'Business Center do TikTok' : `Business Centers do TikTok (${groups.length})` },
      chips.slice(0, VISIBLE),
      chips.length > VISIBLE ? h('details', { class: 'bc-more' }, h('summary', { 'aria-label': `Ver mais ${chips.length - VISIBLE} Business Centers` }, `+${chips.length - VISIBLE}`), h('div', { class: 'bc-chips bc-chips--inner' }, chips.slice(VISIBLE))) : null,
    );
  }

  /**
   * Cartão compacto de uma conexão: situação (bolinha), nome e nº de contas; uma linha de detalhes; as BCs em fichinhas; e só duas ações à
   * vista (a principal e "Atualizar"), com o resto no menu "⋯". Com erro, a ação principal vira a que resolve (renovar o acesso ou editar).
   */
  function businessCenterCard(bc, oauth) {
    const active = bc.status === 'active';
    const details = [bc.authType === 'oauth' ? 'Por link' : 'Por token', visibilityLabel(bc), bc.viaProxy ? 'Via proxy' : null, isAdmin() && !bc.owned ? `Dono: ${bc.ownerName ?? '—'}` : null].filter(Boolean).join(' · ');
    const updated = [currencyText(bc), bc.lastSyncedAt ? `Atualizado ${formatDate(bc.lastSyncedAt)}` : 'Ainda não atualizado'].filter(Boolean).join(' · ');
    const canRenew = bc.authType === 'oauth' && oauth.available;
    const renew = () => connectByLink({ initialName: bc.name, onDone: reload });
    const edit = () => businessCenterForm(bc, reload, oauth);

    let foot = null;
    if (bc.canManage) {
      const primary = active
        ? button('+ CA', { small: true, variant: 'primary', ariaLabel: `Criar novas contas de anúncio em ${bc.name}`, onClick: () => createAdvertisersDialog({ bc, onDone: reload }) })
        : button(canRenew ? 'Renovar acesso' : 'Editar', { small: true, variant: 'primary', ariaLabel: `${canRenew ? 'Renovar acesso de' : 'Editar'} ${bc.name}`, onClick: canRenew ? renew : edit });
      const more = h('button', { type: 'button', class: 'icon-btn bc-more-btn', 'aria-haspopup': 'menu', title: 'Mais ações', 'aria-label': `Mais ações de ${bc.name}`, onClick: (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        openContextMenu({
          x: rect.right - 210,
          y: rect.bottom + 4,
          label: `Ações de ${bc.name}`,
          items: [
            ...(active ? [{ label: 'Vincular pixel…', icon: 'link', onClick: () => linkPixelDialog({ bc, onDone: reload }) }] : []),
            ...(canRenew && active ? [{ label: 'Renovar acesso', icon: 'link', onClick: renew }] : []),
            ...(active || canRenew ? [{ label: 'Editar', icon: 'edit', onClick: edit }] : []),
            'separator',
            { label: 'Remover', icon: 'trash', danger: true, onClick: () => remove(bc) },
          ].filter((item, i, all) => !(item === 'separator' && (i === 0 || all[i - 1] === 'separator'))),
        });
      } }, '⋯');
      foot = h('div', { class: 'bc-card__foot' }, primary, button('Atualizar', { small: true, ariaLabel: `Atualizar contas de ${bc.name}`, onClick: (e) => sync(bc, e.currentTarget) }), more);
    }
    return h(
      'article',
      { class: `bc-card${active ? '' : ' bc-card--error'}` },
      h('header', { class: 'bc-card__head' },
        h('span', { class: `bc-dot bc-dot--${active ? 'ok' : 'error'}`, role: 'img', 'aria-label': active ? 'Funcionando' : 'Com erro', title: active ? 'Funcionando' : 'Com erro' }),
        h('h2', { class: 'bc-card__name', title: bc.name }, bc.name),
        h('span', { class: 'bc-count', title: 'Contas de anúncio nesta conexão' }, h('strong', null, String(bc.advertiserCount)), bc.advertiserCount === 1 ? ' conta' : ' contas')),
      h('p', { class: 'bc-card__meta' }, details),
      h('p', { class: 'bc-card__meta' }, updated),
      bc.lastError ? h('p', { class: 'bc-card__note', role: 'alert' }, bc.lastError) : null,
      bcChips(bc),
      foot,
      bc.canManage ? null : h('p', { class: 'bc-card__hint' }, 'Gerenciada pelo administrador'),
    );
  }

  /** Legenda curta do que cada botão faz (para quem nunca usou). */
  const legend = h(
    'dl',
    { class: 'hub-legend' },
    h('div', null, h('dt', null, '+ CA'), h('dd', null, 'cria novas contas de anúncio dentro da Business Center, no TikTok.')),
    h('div', null, h('dt', null, 'Atualizar'), h('dd', null, 'busca de novo, no TikTok, a lista de contas de anúncio.')),
    h('div', null, h('dt', null, '⋯ Vincular pixel'), h('dd', null, 'liga um pixel a várias contas de anúncio de uma vez (Gerenciador de Eventos → Ativos).')),
    h('div', null, h('dt', null, '⋯ Renovar acesso'), h('dd', null, 'refaz a autorização pelo link (use se aparecer “Com erro”).')),
    h('div', null, h('dt', null, '⋯ Editar'), h('dd', null, 'muda o nome (e, na conexão por token, o token).')),
    h('div', null, h('dt', null, '⋯ Remover'), h('dd', null, 'apaga esta conexão do sistema. Nada é apagado no TikTok.')),
  );

  function draw(configured, oauth, businessCenters) {
    // Com o app do TikTok configurado: pop-up do link (padrão). Sem ele: formulário com token.
    const startConnect = () => (oauth.available ? connectByLink({ onDone: reload, onUseToken: () => businessCenterForm(null, reload, oauth) }) : businessCenterForm(null, reload, oauth));
    const connectButton = button([icon('plus', 16), ' Conectar Business Center'], { variant: 'primary', disabled: !configured, onClick: startConnect });
    const subtitle = 'Aqui ficam as conexões com o TikTok. Conecte uma vez e depois é só usar: ver relatórios e publicar campanhas.';
    const notice = configured
      ? null
      : alertBox('O servidor ainda não tem a TOKEN_ENCRYPTION_KEY configurada (arquivo .env). Peça ao administrador para defini-la e reiniciar o sistema: ela protege os tokens salvos.');

    if (!businessCenters.length) {
      return hubLayout({
        active: '/business-centers',
        subtitle,
        notice,
        children: [
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
        ],
      });
    }

    const accounts = businessCenters.reduce((sum, bc) => sum + bc.advertiserCount, 0);
    return hubLayout({
      active: '/business-centers',
      subtitle,
      notice,
      summary: `${plural(businessCenters.length, 'conexão', 'conexões')} · ${plural(accounts, 'conta de anúncio', 'contas de anúncio')}`,
      actions: connectButton,
      children: [
        h('div', { class: 'bc-grid' }, businessCenters.map((bc) => businessCenterCard(bc, oauth))),
        businessCenters.some((bc) => bc.canManage) ? legend : null,
        isAdmin() ? h('p', { class: 'hub__note' }, 'Como administrador você vê as Business Centers de todos os usuários e pode compartilhar uma BC com a equipe em Editar. Os dados de BCs privadas de outros usuários não aparecem nas suas telas.') : null,
      ],
    });
  }

  await load();
  return { element: container };
}
