import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';

const TTL_MS = 60_000;
let cache = null; // { at, data }

/** Catálogos de todas as BCs do usuário (o servidor também guarda em cache por 60 s). `force` ignora o cache. */
export async function loadCatalogs({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const data = await get(`/tiktok/catalogs${force ? '?refresh=1' : ''}`);
  cache = { at: Date.now(), data };
  return data;
}

const label = (c) => `${c.name || c.id} · BC ${c.bcId} · ${c.regionCode ?? '—'}/${c.currency ?? '—'}${c.adCreationEligible ? '' : ' · sem produtos disponíveis'}`;

/**
 * Campo "ID do catálogo" da campanha de catálogo: lista os catálogos das Business Centers das contas escolhidas, e ao escolher um preenche
 * também o ID da Business Center dona dele (o TikTok exige os dois). O campo para digitar o ID continua disponível. Todo texto vindo do
 * TikTok entra como texto (nunca HTML).
 *  - accounts: contas usáveis [{ id, name, businessCenterId, ownerBcId }]
 *  - onPick(catalogId | undefined, bcId | undefined)
 */
export function createCatalogPicker({ id, value, disabled = false, error = false, describedBy = null, accounts, onPick }) {
  let catalogs = [];
  let loadId = 0;
  const input = h('input', {
    id, class: `input${error ? ' input--error' : ''}`, type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 24, disabled,
    value: value ?? '', placeholder: 'ou digite o ID do catálogo', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
  });
  const select = h('select', { class: 'input pixel-picker__select', 'aria-label': 'Catálogos das suas Business Centers', disabled: true });
  const refresh = h('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled, 'aria-label': 'Atualizar a lista de catálogos' }, 'Atualizar');
  const status = h('p', { class: 'field__hint pixel-picker__status', 'aria-live': 'polite' });

  /** Só catálogos das conexões das contas escolhidas (e da BC dona da conta, quando o sistema sabe qual é). */
  const usable = (list) => {
    const connections = new Set(accounts.map((a) => a.businessCenterId));
    const bcs = new Set(accounts.map((a) => a.ownerBcId).filter(Boolean));
    return list.filter((c) => connections.has(c.connectionId) && (!bcs.size || bcs.has(c.bcId)));
  };

  function drawOptions() {
    const known = catalogs.find((c) => c.id === input.value);
    setChildren(select,
      h('option', { value: '' }, catalogs.length ? 'Escolher um catálogo existente…' : 'Nenhum catálogo encontrado'),
      catalogs.map((c) => h('option', { value: `${c.bcId}:${c.id}` }, label(c))));
    select.value = known ? `${known.bcId}:${known.id}` : '';
    select.disabled = disabled || !catalogs.length;
  }

  async function load({ force = false } = {}) {
    const current = ++loadId;
    select.disabled = true;
    setChildren(select, h('option', { value: '' }, 'Carregando catálogos…'));
    status.textContent = '';
    try {
      const data = await loadCatalogs({ force });
      if (current !== loadId) return;
      catalogs = usable(data.catalogs).sort((a, b) => Number(b.adCreationEligible) - Number(a.adCreationEligible) || a.name.localeCompare(b.name));
      drawOptions();
      status.textContent = catalogs.length
        ? 'Escolha um catálogo com produtos disponíveis. O ID da Business Center dona dele é preenchido junto.'
        : 'Nenhum catálogo nas Business Centers destas contas. Crie um no menu Catálogo ou digite o ID.';
    } catch (err) {
      if (current !== loadId) return;
      catalogs = [];
      drawOptions();
      status.textContent = `Não foi possível listar os catálogos (${err.message}). Digite o ID manualmente.`;
    }
  }

  select.addEventListener('change', () => {
    const [bcId, catalogId] = select.value ? select.value.split(':') : [undefined, undefined];
    input.value = catalogId ?? '';
    onPick(catalogId, bcId);
  });
  input.addEventListener('input', () => {
    const known = catalogs.find((c) => c.id === input.value);
    select.value = known ? `${known.bcId}:${known.id}` : '';
    onPick(input.value || undefined, known?.bcId);
  });
  refresh.addEventListener('click', () => load({ force: true }));

  load();
  return h('div', { class: 'pixel-picker' }, h('div', { class: 'pixel-picker__row' }, select, refresh), input, status);
}

/**
 * Campo "ID do conjunto de produtos": lista os conjuntos do catálogo escolhido (a conexão e a BC saem da lista de catálogos) e mantém o
 * campo para digitar o ID. Sem catálogo escolhido, explica o que fazer.
 */
export function createProductSetPicker({ id, value, catalogId, disabled = false, error = false, describedBy = null, onPick }) {
  let sets = [];
  let loadId = 0;
  const input = h('input', {
    id, class: `input${error ? ' input--error' : ''}`, type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 24, disabled,
    value: value ?? '', placeholder: 'ou digite o ID do conjunto', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
  });
  const select = h('select', { class: 'input pixel-picker__select', 'aria-label': 'Conjuntos de produtos do catálogo', disabled: true });
  const status = h('p', { class: 'field__hint pixel-picker__status', 'aria-live': 'polite' });

  function drawOptions() {
    setChildren(select, h('option', { value: '' }, sets.length ? 'Escolher um conjunto existente…' : 'Nenhum conjunto encontrado'), sets.map((s) => h('option', { value: s.id }, `${s.name} · ${s.productCount ?? '—'} produtos`)));
    select.value = sets.some((s) => s.id === input.value) ? input.value : '';
    select.disabled = disabled || !sets.length;
  }

  async function load() {
    const current = ++loadId;
    if (!catalogId) {
      status.textContent = 'Escolha o catálogo na etapa anterior (Grupo de anúncios) para listar os conjuntos.';
      drawOptions();
      return;
    }
    select.disabled = true;
    setChildren(select, h('option', { value: '' }, 'Carregando conjuntos…'));
    try {
      const { catalogs } = await loadCatalogs();
      const catalog = catalogs.find((c) => c.id === catalogId);
      if (!catalog) throw new Error('catálogo não encontrado na lista');
      const data = await get(`/tiktok/catalogs/${encodeURIComponent(catalogId)}/sets?connectionId=${catalog.connectionId}&bcId=${encodeURIComponent(catalog.bcId)}`);
      if (current !== loadId) return;
      sets = data.sets;
      drawOptions();
      status.textContent = sets.length ? '' : 'Este catálogo ainda não tem conjuntos. Crie em Catálogo → Conjuntos de produtos ou digite o ID.';
    } catch (err) {
      if (current !== loadId) return;
      sets = [];
      drawOptions();
      status.textContent = `Não foi possível listar os conjuntos (${err.message}). Digite o ID manualmente.`;
    }
  }

  select.addEventListener('change', () => { input.value = select.value; onPick(select.value || undefined); });
  input.addEventListener('input', () => { select.value = sets.some((s) => s.id === input.value) ? input.value : ''; onPick(input.value || undefined); });

  load();
  return h('div', { class: 'pixel-picker' }, h('div', { class: 'pixel-picker__row' }, select), input, status);
}
