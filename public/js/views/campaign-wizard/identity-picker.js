import { LISTABLE_IDENTITY_TYPES } from '/shared/identity.js';
import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { toast } from '../../ui.js';
import { openIdentityDialog } from './identity-dialog.js';

const TTL_MS = 60_000;
const cache = new Map(); // "conta:tipo" -> { at, identities }

const TYPE_NOUN = { CUSTOMIZED_USER: 'identidade personalizada', TT_USER: 'conta do TikTok vinculada', BC_AUTH_TT: 'conta do TikTok da Business Center' };

/** Identidades do tipo escolhido que já existem na conta (o servidor também guarda em cache por 60 s). `force` ignora o cache. */
async function loadIdentities(advertiserId, type, { force = false } = {}) {
  const key = `${advertiserId}:${type}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.identities;
  const { identities } = await get(`/tiktok/advertisers/${encodeURIComponent(advertiserId)}/identities?type=${encodeURIComponent(type)}${force ? '&fresh=1' : ''}`);
  cache.set(key, { at: Date.now(), identities });
  return identities;
}

/** "Dona Now · 7123…" ou, para contas do TikTok, "Nome (@usuario) · 7123…". Texto puro. */
const labelOf = (identity) => `${identity.name || 'Sem nome'}${identity.username ? ` (@${identity.username})` : ''} · ${identity.id}`;

/**
 * Campo "ID da identidade": lista as identidades que JÁ EXISTEM na conta de anúncio (do tipo escolhido) para escolher com um clique,
 * deixa CRIAR uma identidade personalizada (nome + foto) sem sair do assistente, e mantém o campo para digitar o ID. Com mais de uma
 * conta, uma lista escolhe em qual conta listar/criar. Todo texto vindo do TikTok entra como texto (nunca HTML).
 *  - accounts: contas usáveis [{ id, name, currency }]
 *  - identityType: tipo escolhido no campo "Tipo de identidade"
 *  - onPick(valor | undefined): chamado ao escolher, criar ou digitar
 */
export function createIdentityPicker({ id, value, disabled = false, error = false, describedBy = null, accounts, identityType, onPick }) {
  const listable = LISTABLE_IDENTITY_TYPES.includes(identityType);
  const canCreate = identityType === 'CUSTOMIZED_USER';
  let advertiserId = accounts[0].id;
  let loadId = 0;
  let identities = [];

  const input = h('input', {
    id, class: `input${error ? ' input--error' : ''}`, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 100, disabled,
    value: value ?? '', placeholder: listable ? 'ou digite o ID da identidade' : 'Cole aqui o código de autorização', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
  });
  const select = h('select', { class: 'input pixel-picker__select', 'aria-label': 'Identidades que já existem na conta', disabled: true });
  const refresh = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled, 'aria-label': 'Atualizar a lista de identidades' }, 'Atualizar');
  const create = canCreate ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', disabled }, 'Criar identidade') : null;
  const status = h('p', { class: 'field__hint pixel-picker__status', 'aria-live': 'polite' });
  const accountSelect = accounts.length > 1
    ? h('select', { class: 'input pixel-picker__account', 'aria-label': 'Conta de anúncio onde listar e criar identidades', disabled }, accounts.map((a) => h('option', { value: a.id }, `${a.name}${a.currency ? ` · ${a.currency}` : ''}`)))
    : null;
  const account = () => accounts.find((a) => a.id === advertiserId);

  function drawOptions() {
    const known = identities.some((i) => i.id === input.value);
    setChildren(
      select,
      h('option', { value: '' }, identities.length ? 'Escolher uma identidade existente…' : 'Nenhuma identidade encontrada'),
      identities.map((i) => h('option', { value: i.id, disabled: i.available === false }, `${labelOf(i)}${i.available === false ? ' (indisponível)' : ''}`)),
    );
    select.value = known ? input.value : '';
    select.disabled = disabled || !identities.length;
  }

  async function load({ force = false } = {}) {
    const current = ++loadId;
    select.disabled = true;
    setChildren(select, h('option', { value: '' }, 'Carregando identidades…'));
    status.textContent = '';
    try {
      identities = await loadIdentities(advertiserId, identityType, { force });
      if (current !== loadId) return; // a pessoa trocou de conta no meio: vale a consulta mais recente
      drawOptions();
      const noun = TYPE_NOUN[identityType];
      status.textContent = identities.length
        ? `${identities.length === 1 ? '1 identidade' : `${identities.length} identidades`} (${noun}) na conta ${account().name}. O ID da identidade vale só para a conta onde ela foi criada.`
        : canCreate
          ? `A conta ${account().name} ainda não tem identidade personalizada. Use “Criar identidade”: só precisa de um nome e, se quiser, uma foto.`
          : `A conta ${account().name} não tem nenhuma (${noun}) disponível para anunciar. Escolha outro tipo ou digite o ID.`;
    } catch (err) {
      if (current !== loadId) return;
      identities = [];
      drawOptions();
      status.textContent = `Não foi possível listar as identidades (${err.message}). Digite o ID manualmente.`;
    }
  }

  select.addEventListener('change', () => {
    input.value = select.value;
    onPick(select.value || undefined);
  });
  input.addEventListener('input', () => {
    select.value = identities.some((i) => i.id === input.value) ? input.value : '';
    onPick(input.value || undefined);
  });
  accountSelect?.addEventListener('change', () => {
    advertiserId = accountSelect.value;
    load();
  });
  refresh.addEventListener('click', () => load({ force: true }));
  create?.addEventListener('click', () => openIdentityDialog({
    advertiser: account(),
    onCreated: async (identity) => {
      toast(`Identidade “${identity.name}” criada na conta ${account().name}.`);
      input.value = identity.id;
      onPick(identity.id);
      await load({ force: true });
    },
  }));

  if (listable) load();
  else status.textContent = 'O código de autorização é gerado no TikTok pela conta que vai assinar o anúncio.';
  return h(
    'div',
    { class: 'pixel-picker' },
    listable ? accountSelect : null,
    listable ? h('div', { class: 'pixel-picker__row' }, select, refresh, create) : null,
    input,
    status,
  );
}
