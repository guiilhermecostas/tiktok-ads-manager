import { MAX_LINK_ADVERTISERS, normalizePixelCode } from '/shared/pixel-link.js';
import { get, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, badge, button, confirmDialog, field, openModal, toast } from '../ui.js';
import { plural } from './hub.js';

const LINK_CHECK_DELAY_MS = 400; // espera a pessoa terminar de digitar o código antes de consultar o TikTok
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Pop-up "Vincular pixel": faz o mesmo que Gerenciador de Eventos → pixel → Ativos → escolher a conta de anúncio, mas para várias contas
 * de uma vez, pela API do TikTok. A pessoa escolhe o pixel (lista dos pixels que uma conta já enxerga, ou digita o CÓDIGO) e marca as
 * contas; as que já têm o pixel aparecem como "Vinculada". Vincular e desvincular só acontecem com um clique explícito (desvincular pede
 * confirmação). Enquanto o TikTok responde, o pop-up não fecha. Todo texto vindo do TikTok entra como texto (nunca HTML).
 *  - `bc`: a conexão { id, name, bcIds }. `preset`: { advertiserId } conta já marcada e usada para listar os pixels.
 *  - `onDone()`: chamado ao fechar depois de mudar algum vínculo (a tela recarrega as listas de pixels).
 */
export function linkPixelDialog({ bc, preset = {}, onDone }) {
  const bcIds = bc.bcIds ?? [];
  let busy = false;
  let changed = false;
  let accounts = []; // contas de anúncio desta conexão
  let pixels = []; // pixels que a conta de origem enxerga
  let linked = new Set(); // contas que já têm o pixel digitado/escolhido
  let linksRequest = 0;
  let pixelsRequest = 0;
  let linksTimer;
  const selected = new Set();

  const body = h('div', { class: 'modal__body link-pixel' });
  const modal = openModal({
    title: 'Vincular pixel a contas de anúncio',
    size: 'md',
    body,
    dismissOnOverlay: false,
    canClose: () => !busy,
    onClose: () => {
      clearTimeout(linksTimer);
      if (changed) onDone?.();
    },
  });

  if (!bcIds.length) {
    body.append(
      alertBox('O sistema ainda não sabe o ID da Business Center desta conexão. Clique em “Atualizar” no cartão da conexão e tente de novo.', 'warning'),
      h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() })),
    );
    return;
  }

  // ----- campos -----
  const bcSelect = bcIds.length > 1 ? field('Business Center do TikTok dona do pixel', { as: 'select', options: bcIds.map((id) => [id, id]) }, { hint: 'O pixel e as contas precisam estar na mesma Business Center.' }) : null;
  const source = field('Listar os pixels da conta', { as: 'select', options: [['', 'Carregando contas…']], disabled: true });
  const pixelSelect = field('Pixel', { as: 'select', options: [['', 'Escolha uma conta primeiro']], disabled: true });
  const code = field('Código do pixel', { type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: 'Ex.: CABC123XYZ789', required: true }, { hint: 'É o código que aparece no Gerenciador de Eventos do TikTok, embaixo do nome do pixel. Escolher na lista acima já preenche.' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Buscar conta por nome ou ID…', 'aria-label': 'Buscar conta de anúncio', autocomplete: 'off', maxlength: 100 });
  const list = h('div', { class: 'link-pixel__list', role: 'group', 'aria-label': 'Contas de anúncio' });
  const counter = h('p', { class: 'link-pixel__counter muted', 'aria-live': 'polite' });
  const status = h('p', { class: 'field__hint link-pixel__status', 'aria-live': 'polite' });
  const errorSlot = h('div');
  const markMissing = button('Marcar as sem vínculo', { small: true, onClick: () => markVisible((a) => !linked.has(a.id)) });
  const markAll = button('Marcar todas', { small: true, onClick: () => markVisible(() => true) });
  const clear = button('Limpar', { small: true, onClick: () => { selected.clear(); draw(); } });
  const doLink = button('Vincular', { variant: 'primary', onClick: () => run('LINK') });
  const doUnlink = button('Desvincular', { variant: 'danger-ghost', onClick: () => run('UNLINK') });

  const currentBc = () => (bcSelect ? bcSelect.control.value : bcIds[0]);
  const currentCode = () => normalizePixelCode(code.control.value);
  const visibleAccounts = () => {
    const term = normalize(search.value.trim());
    return accounts.filter((a) => !term || normalize(`${a.name} ${a.id}`).includes(term));
  };

  // ----- lista de contas -----
  function draw() {
    const rows = visibleAccounts();
    setChildren(
      list,
      rows.length
        ? rows.map((a) => h(
          'label',
          { class: `link-pixel__row${selected.has(a.id) ? ' is-selected' : ''}` },
          h('input', { type: 'checkbox', value: a.id, checked: selected.has(a.id), disabled: busy, 'aria-label': `${a.name}, ID ${a.id}` }),
          h('span', { class: 'link-pixel__name' }, h('strong', null, a.name || 'Conta sem nome'), h('span', { class: 'acc-id' }, a.id)),
          linked.has(a.id) ? badge('Vinculada', 'success') : null,
        ))
        : h('p', { class: 'muted link-pixel__empty' }, accounts.length ? 'Nenhuma conta com esta busca.' : 'Esta conexão não tem contas de anúncio.'),
    );
    syncButtons();
  }

  function syncButtons() {
    const n = selected.size;
    const ready = Boolean(currentCode()) && n > 0 && n <= MAX_LINK_ADVERTISERS && !busy;
    counter.textContent = `${plural(n, 'conta marcada', 'contas marcadas')} (máximo ${MAX_LINK_ADVERTISERS} por vez)${linked.size ? ` · ${plural(linked.size, 'já vinculada', 'já vinculadas')}` : ''}`;
    doLink.textContent = `Vincular${n ? ` (${n})` : ''}`;
    doUnlink.textContent = `Desvincular${n ? ` (${n})` : ''}`;
    doLink.disabled = !ready;
    doUnlink.disabled = !ready;
    for (const control of [markMissing, markAll, clear, search, code.control, ...(bcSelect ? [bcSelect.control] : [])]) control.disabled = busy;
    source.control.disabled = busy || !accounts.length;
    pixelSelect.control.disabled = busy || !pixels.length;
  }

  function markVisible(predicate) {
    for (const a of visibleAccounts()) {
      if (!predicate(a)) continue;
      if (selected.size >= MAX_LINK_ADVERTISERS) {
        status.textContent = `O limite é ${MAX_LINK_ADVERTISERS} contas por vez: as demais ficam para o próximo pedido.`;
        break;
      }
      selected.add(a.id);
    }
    draw();
  }

  list.addEventListener('change', (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox') return;
    if (box.checked && selected.size >= MAX_LINK_ADVERTISERS) {
      box.checked = false;
      status.textContent = `O limite é ${MAX_LINK_ADVERTISERS} contas por vez.`;
      return;
    }
    if (box.checked) selected.add(box.value);
    else selected.delete(box.value);
    box.closest('.link-pixel__row')?.classList.toggle('is-selected', box.checked);
    syncButtons();
  });
  search.addEventListener('input', draw);

  // ----- pixels da conta de origem -----
  async function loadPixels() {
    const current = ++pixelsRequest;
    const advertiserId = source.control.value;
    if (!advertiserId) return;
    setChildren(pixelSelect.control, h('option', { value: '' }, 'Carregando pixels…'));
    pixelSelect.control.disabled = true;
    try {
      const data = await get(`/tiktok/advertisers/${encodeURIComponent(advertiserId)}/pixels?fresh=1`);
      if (current !== pixelsRequest) return;
      pixels = data.pixels.filter((p) => normalizePixelCode(p.code));
      setChildren(
        pixelSelect.control,
        h('option', { value: '' }, pixels.length ? 'Escolher um pixel…' : 'Nenhum pixel nesta conta (digite o código abaixo)'),
        pixels.map((p) => h('option', { value: p.code }, `${p.name || 'Pixel sem nome'} · ${p.code}`)),
      );
      pixelSelect.control.value = pixels.some((p) => p.code === code.control.value.trim()) ? code.control.value.trim() : '';
      pixelSelect.control.disabled = !pixels.length;
    } catch (err) {
      if (current !== pixelsRequest) return;
      pixels = [];
      setChildren(pixelSelect.control, h('option', { value: '' }, 'Não foi possível listar os pixels'));
      status.textContent = `Não foi possível listar os pixels (${err.message}). Digite o código do pixel.`;
    }
  }

  pixelSelect.control.addEventListener('change', () => {
    const pixel = pixels.find((p) => p.code === pixelSelect.control.value);
    if (!pixel) return;
    code.control.value = pixel.code;
    if (bcSelect && pixel.ownerBcId && bcIds.includes(pixel.ownerBcId)) bcSelect.control.value = pixel.ownerBcId; // a BC dona do pixel
    checkLinks();
  });
  source.control.addEventListener('change', loadPixels);

  // ----- quais contas já têm o pixel -----
  async function checkLinks() {
    clearTimeout(linksTimer);
    const current = ++linksRequest;
    const pixelCode = currentCode();
    status.textContent = '';
    if (!pixelCode) {
      linked = new Set();
      draw();
      return;
    }
    try {
      const data = await get(`/tiktok/business-centers/${bc.id}/pixel-links?bcId=${encodeURIComponent(currentBc())}&pixelCode=${encodeURIComponent(pixelCode)}`);
      if (current !== linksRequest) return;
      linked = new Set(data.advertiserIds);
      status.textContent = linked.size ? '' : 'Nenhuma conta desta conexão tem este pixel vinculado ainda.';
    } catch (err) {
      if (current !== linksRequest) return;
      linked = new Set();
      status.textContent = `Não foi possível conferir os vínculos agora (${err.message}). Você ainda pode vincular.`;
    }
    draw();
  }
  code.control.addEventListener('input', () => {
    pixelSelect.control.value = pixels.some((p) => p.code === code.control.value.trim()) ? code.control.value.trim() : '';
    syncButtons();
    clearTimeout(linksTimer);
    linksTimer = setTimeout(checkLinks, LINK_CHECK_DELAY_MS);
  });
  bcSelect?.control.addEventListener('change', checkLinks);

  // ----- vincular / desvincular -----
  async function run(action) {
    const pixelCode = currentCode();
    const ids = [...selected];
    if (!pixelCode || !ids.length || busy) return;
    if (action === 'UNLINK') {
      const ok = await confirmDialog({
        title: 'Desvincular pixel',
        message: `Desvincular o pixel ${pixelCode} de ${plural(ids.length, 'conta de anúncio', 'contas de anúncio')}? Campanhas dessas contas que usam este pixel deixam de medir conversões por ele até você vincular de novo.`,
        confirmLabel: 'Desvincular',
        danger: true,
      });
      if (!ok) return;
    }
    errorSlot.replaceChildren();
    busy = true;
    syncButtons();
    draw();
    try {
      const result = await post(`/tiktok/business-centers/${bc.id}/pixel-links`, { bcId: currentBc(), pixelCode, advertiserIds: ids, action });
      changed = true;
      selected.clear();
      if (Array.isArray(result.advertiserIds)) linked = new Set(result.advertiserIds);
      toast(action === 'LINK' ? `Pixel vinculado a ${plural(ids.length, 'conta', 'contas')}. Ele já aparece na lista de pixels delas.` : `Pixel desvinculado de ${plural(ids.length, 'conta', 'contas')}.`);
      if (!Array.isArray(result.advertiserIds)) await checkLinks();
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    } finally {
      busy = false;
      draw();
    }
  }

  setChildren(
    body,
    errorSlot,
    h('p', { class: 'muted' }, `Conexão: ${bc.name}. É o mesmo que abrir o pixel no Gerenciador de Eventos, ir em Ativos e escolher a conta de anúncio, só que para várias contas de uma vez.`),
    bcSelect?.element,
    source.element,
    pixelSelect.element,
    code.element,
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Contas de anúncio'), search, h('div', { class: 'link-pixel__tools' }, markMissing, markAll, clear), list, counter),
    status,
    h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.requestClose() }), doUnlink, doLink),
  );
  draw();

  // ----- carga inicial: contas desta conexão -----
  get('/tiktok/advertisers').then((data) => {
    accounts = data.advertisers
      .filter((a) => a.businessCenterId === bc.id)
      .map((a) => ({ id: a.id, name: a.name, ownerBcId: a.ownerBcId ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    setChildren(source.control, accounts.length ? accounts.map((a) => h('option', { value: a.id }, `${a.name} · ${a.id}`)) : h('option', { value: '' }, 'Nenhuma conta nesta conexão'));
    const start = accounts.find((a) => a.id === preset.advertiserId) ?? accounts[0];
    if (start) {
      source.control.value = start.id;
      if (preset.advertiserId === start.id) selected.add(start.id);
      if (bcSelect && start.ownerBcId && bcIds.includes(start.ownerBcId)) bcSelect.control.value = start.ownerBcId;
    }
    draw();
    return loadPixels();
  }).catch((err) => {
    errorSlot.replaceChildren(alertBox(`Não foi possível carregar as contas (${err.message}).`));
  });
}
