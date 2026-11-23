import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';

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
 *  - onPick(valor | undefined): chamado ao escolher ou digitar
 */
export function createPixelPicker({ id, value, disabled = false, error = false, describedBy = null, accounts, onPick }) {
  let advertiserId = accounts[0].id;
  let loadId = 0;
  let pixels = [];

  const input = h('input', {
    id, class: `input${error ? ' input--error' : ''}`, type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 24, disabled,
    value: value ?? '', placeholder: 'ou digite o ID do pixel', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
  });
  const select = h('select', { class: 'input pixel-picker__select', 'aria-label': 'Pixels que já existem na conta', disabled: true });
  const refresh = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled, 'aria-label': 'Atualizar a lista de pixels' }, 'Atualizar');
  const status = h('p', { class: 'field__hint pixel-picker__status', 'aria-live': 'polite' });
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
  }

  async function load({ force = false } = {}) {
    const current = ++loadId;
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
        : `A conta ${account.name} ainda não tem pixels. Crie em Gerenciador de Eventos → Pixel ou digite o ID.`;
    } catch (err) {
      if (current !== loadId) return;
      pixels = [];
      drawOptions();
      status.textContent = `Não foi possível listar os pixels (${err.message}). Digite o ID manualmente.`;
    }
  }

  select.addEventListener('change', () => {
    input.value = select.value;
    onPick(select.value || undefined);
  });
  input.addEventListener('input', () => {
    select.value = pixels.some((p) => p.id === input.value) ? input.value : '';
    onPick(input.value || undefined);
  });
  accountSelect?.addEventListener('change', () => {
    advertiserId = accountSelect.value;
    load();
  });
  refresh.addEventListener('click', () => load({ force: true }));

  load();
  return h(
    'div',
    { class: 'pixel-picker' },
    accountSelect,
    h('div', { class: 'pixel-picker__row' }, select, refresh),
    input,
    status,
  );
}
