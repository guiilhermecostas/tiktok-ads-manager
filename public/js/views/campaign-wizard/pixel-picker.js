import { pixelEventLabel } from '/shared/pixel-events.js';
import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { alertBox, badge, button } from '../../ui.js';
import { linkPixelDialog } from '../link-pixel.js';
import { openPixelEventDialog } from './pixel-event-dialog.js';

const TTL_MS = 60_000;
const cache = new Map(); // ID da conta -> { at, pixels }

/** Pixels que já existem na conta (o servidor também guarda em cache por 60 s). `force` ignora o cache. */
async function loadPixels(advertiserId, { force = false } = {}) {
  const hit = cache.get(advertiserId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.pixels;
  const { pixels } = await get(`/tiktok/advertisers/${encodeURIComponent(advertiserId)}/pixels${force ? '?fresh=1' : ''}`);
  cache.set(advertiserId, { at: Date.now(), pixels });
  return pixels;
}

/**
 * Campo "ID do Pixel": lista os pixels que JÁ EXISTEM na conta de anúncio para escolher com um clique, e mantém o campo para
 * digitar o ID (caso o pixel não apareça ou a lista não carregue). Com mais de uma conta, uma lista escolhe de qual conta
 * mostrar os pixels. Todo texto vindo do TikTok entra como texto (nunca HTML).
 *  - accounts: contas usáveis [{ id, name, currency }]
 *  - getEvent(): evento de conversão escolhido na campanha (para avisar se o pixel ainda não o tem)
 *  - onPick(valor | undefined): chamado ao escolher ou digitar
 */
export function createPixelPicker({ id, value, disabled = false, error = false, describedBy = null, accounts, getEvent = () => null, onPick }) {
  let advertiserId = accounts[0].id;
  let loadId = 0;
  let pixels = [];

  const input = h('input', {
    id, class: `input${error ? ' input--error' : ''}`, type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 24, disabled,
    value: value ?? '', placeholder: 'ou digite o ID do pixel', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
  });
  const select = h('select', { class: 'input pixel-picker__select', 'aria-label': 'Pixels que já existem na conta', disabled: true });
  const refresh = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled, 'aria-label': 'Atualizar a lista de pixels' }, 'Atualizar');
  const link = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled, hidden: true, title: 'Liga um pixel da Business Center a esta conta (Gerenciador de Eventos → Ativos), sem sair daqui' }, 'Vincular pixel…');
  const status = h('p', { class: 'field__hint pixel-picker__status', 'aria-live': 'polite' });
  const eventsBox = h('div', { class: 'pixel-picker__events', 'aria-live': 'polite' });
  const accountSelect = accounts.length > 1
    ? h('select', { class: 'input pixel-picker__account', 'aria-label': 'Conta de anúncio de onde listar os pixels', disabled }, accounts.map((a) => h('option', { value: a.id }, `${a.name}${a.currency ? ` · ${a.currency}` : ''}`)))
    : null;

  function drawOptions() {
    const known = pixels.some((p) => p.id === input.value);
    setChildren(
      select,
      h('option', { value: '' }, pixels.length ? 'Escolher um pixel existente…' : 'Nenhum pixel encontrado'),
      pixels.map((p) => h('option', { value: p.id }, `${p.name || 'Pixel sem nome'} · ${p.id}`)),
    );
    select.value = known ? input.value : '';
    select.disabled = disabled || !pixels.length;
    drawEvents();
  }

  /**
   * Eventos do pixel escolhido (os que o TikTok já registrou ou que foram criados) e, se o evento de conversão da campanha não estiver entre eles, um aviso com
   * o botão para criá-lo: o TikTok recusa o grupo de anúncios quando o evento não existe no pixel. Só aparece para pixels da lista (os digitados à mão não dá para conferir).
   */
  function drawEvents() {
    const pixel = pixels.find((p) => p.id === input.value);
    if (!pixel) return eventsBox.replaceChildren();
    const wanted = getEvent();
    const has = new Set(pixel.events.map((e) => e.optimizationEvent));
    const missing = Boolean(wanted) && !has.has(wanted);
    const chips = pixel.events.map((e) => badge(pixelEventLabel(e.optimizationEvent), e.optimizationEvent === wanted ? 'success' : 'neutral'));
    const create = disabled ? null : button(missing ? `Criar “${pixelEventLabel(wanted)}” no pixel` : 'Criar evento no pixel…', {
      small: true,
      variant: missing ? 'primary' : 'secondary',
      onClick: () => openPixelEventDialog({ advertiser: selectedAccount(), pixel, suggested: wanted, existing: has, onCreated: () => load({ force: true }) }),
    });
    return setChildren(
      eventsBox,
      h('p', { class: 'field__hint' }, pixel.events.length ? 'Eventos que este pixel já tem:' : 'Este pixel ainda não tem eventos registrados (o TikTok atualiza essa lista a cada 2 a 4 horas).'),
      chips.length ? h('div', { class: 'pixel-picker__chips' }, chips) : null,
      missing ? alertBox(`O evento de conversão da campanha, “${pixelEventLabel(wanted)}”, ainda não existe neste pixel: o TikTok recusa a campanha sem ele. Crie o evento ou escolha outro evento de conversão.`, 'warning') : null,
      create,
    );
  }
  const selectedAccount = () => accounts.find((a) => a.id === advertiserId);

  /** Só quem gerencia a conexão (dono ou admin) pode vincular pixel: para os outros o botão nem aparece. */
  const syncLink = () => { link.hidden = !accounts.find((a) => a.id === advertiserId)?.businessCenterOwned; };

  async function load({ force = false } = {}) {
    const current = ++loadId;
    syncLink();
    select.disabled = true;
    setChildren(select, h('option', { value: '' }, 'Carregando pixels…'));
    status.textContent = '';
    try {
      const list = await loadPixels(advertiserId, { force });
      if (current !== loadId) return; // a pessoa trocou de conta no meio: vale a consulta mais recente
      pixels = list;
      drawOptions();
      const account = accounts.find((a) => a.id === advertiserId);
      status.textContent = pixels.length
        ? `${pixels.length === 1 ? '1 pixel' : `${pixels.length} pixels`} na conta ${account.name}. O ID do pixel vale só para a conta onde ele foi criado.`
        : `A conta ${account.name} ainda não tem pixels. Crie em Gerenciador de Eventos → Pixel, use “Vincular pixel…” se ele já existe na Business Center, ou digite o ID.`;
    } catch (err) {
      if (current !== loadId) return;
      pixels = [];
      drawOptions();
      status.textContent = `Não foi possível listar os pixels (${err.message}). Digite o ID manualmente.`;
    }
  }

  select.addEventListener('change', () => {
    input.value = select.value;
    drawEvents();
    onPick(select.value || undefined);
  });
  input.addEventListener('input', () => {
    select.value = pixels.some((p) => p.id === input.value) ? input.value : '';
    drawEvents();
    onPick(input.value || undefined);
  });
  accountSelect?.addEventListener('change', () => {
    advertiserId = accountSelect.value;
    load();
  });
  refresh.addEventListener('click', () => load({ force: true }));
  link.addEventListener('click', () => {
    const a = accounts.find((x) => x.id === advertiserId);
    if (!a) return;
    linkPixelDialog({
      bc: { id: a.businessCenterId, name: a.businessCenterName, bcIds: a.businessCenterBcId ? [a.businessCenterBcId] : [a.ownerBcId].filter(Boolean) },
      preset: { advertiserId: a.id },
      onDone: () => load({ force: true }), // o pixel recém-vinculado já aparece na lista da conta
    });
  });

  load();
  return h(
    'div',
    { class: 'pixel-picker' },
    accountSelect,
    h('div', { class: 'pixel-picker__row' }, select, refresh, link),
    input,
    status,
    eventsBox,
  );
}
