import { get, put } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatDate } from '../../format.js';
import { can } from '../../state.js';
import { alertBox, badge, button, confirmDialog, emptyState, spinner, toast } from '../../ui.js';
import { STATUS_FILTERS, bcOptions, filterCatalogs, hasActiveFilters, normalizeFilters, regionLabel, regionOptions } from '/shared/catalog-filters.js';
import { pageHeader } from '../layout.js';
import { openCreateCatalogDialog } from './create-dialog.js';
import { catalogDetail } from './detail.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const keyOf = (c) => c.id;

/**
 * Catálogo de produtos: lista os catálogos de TODAS as Business Centers do usuário, cria catálogo (em etapas) e abre o detalhe de um
 * catálogo (produtos, envio de produtos por formulário ou CSV, conjuntos de produtos). Um catálogo é obrigatório para campanhas de
 * "Vendas de produtos". Todo texto vindo do TikTok entra como nó de texto (nunca como HTML).
 *  - Filtros: Business Center (uma opção por BC), situação, país/moeda e busca.
 *  - Ocultar: tira o catálogo SÓ da lista de quem ocultou (o TikTok e as outras pessoas não mudam); "Mostrar ocultos" traz de volta.
 */
export async function catalogView(ctx) {
  const st = { data: null, loading: false, error: null, filters: normalizeFilters({}), detail: null, selected: new Set() };
  const root = h('div', { class: 'catalog' });
  const toolbar = h('div', { class: 'catalog__toolbar' });
  const selectionBar = h('div', { class: 'selection-bar', hidden: true, role: 'region', 'aria-label': 'Catálogos selecionados' });
  const body = h('div', { class: 'catalog__body' });
  const header = h('div');
  let loadId = 0;
  const canWrite = () => can('campaigns');

  const catalogs = () => st.data?.catalogs ?? [];
  const hiddenCount = () => catalogs().filter((c) => c.hidden).length;
  const byId = (id) => catalogs().find((c) => keyOf(c) === id);

  async function load({ fresh = false } = {}) {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    drawBody();
    try {
      const data = await get(`/tiktok/catalogs${fresh ? '?refresh=1' : ''}`);
      if (current !== loadId) return false;
      st.data = data;
      st.selected = new Set([...st.selected].filter((id) => byId(id)));
      return true;
    } catch (err) {
      if (current === loadId) st.error = err.message;
      return false;
    } finally {
      if (current === loadId) {
        st.loading = false;
        keepFiltersValid();
        drawHeader();
        drawToolbar();
        drawBody();
      }
    }
  }

  /** Se a BC, o país ou "mostrar ocultos" escolhidos deixaram de existir (a lista mudou), volta ao "todos" em vez de mostrar uma lista vazia sem explicação. */
  function keepFiltersValid() {
    const countHidden = st.filters.showHidden;
    if (st.filters.bcId && !bcOptions(catalogs(), { countHidden }).some((o) => o.bcId === st.filters.bcId)) st.filters.bcId = '';
    if (st.filters.region && !regionOptions(catalogs(), { countHidden }).includes(st.filters.region)) st.filters.region = '';
    if (st.filters.showHidden && !hiddenCount()) st.filters.showHidden = false;
  }

  const manageableBcs = () => (st.data?.businessCenters ?? []).filter((b) => b.canManage && b.status === 'ok');

  function create() {
    openCreateCatalogDialog({
      businessCenters: manageableBcs(),
      onCreated: async (catalog, { openAdd }) => {
        await load({ fresh: true });
        if (openAdd) openDetail({ ...catalog }, 'add');
      },
    });
  }

  function openDetail(catalog, tab = 'products') {
    st.detail = catalog;
    draw();
    setChildren(body, catalogDetail({
      ctx, catalog, tab, canWrite: canWrite() && catalog.canManage,
      onBack: () => { st.detail = null; draw(); load({ fresh: true }); },
    }));
  }

  function draw() {
    drawHeader();
    drawToolbar();
    toolbar.hidden = Boolean(st.detail);
    selectionBar.hidden = Boolean(st.detail) || !st.selected.size;
    if (!st.detail) drawBody();
  }

  function drawHeader() {
    setChildren(header, pageHeader(
      'Catálogo',
      st.detail ? null : 'Catálogos de produtos das suas Business Centers. Um catálogo é obrigatório para campanhas de Vendas de produtos.',
      st.detail ? null : (canWrite() && manageableBcs().length ? button('+ Catálogo', { variant: 'primary', onClick: create }) : null),
    ));
  }

  const visible = () => filterCatalogs(catalogs(), st.filters);

  // ---------- ocultar / mostrar ----------
  /** Aplica no que está na tela (sem buscar de novo no TikTok) depois que o servidor confirmou. */
  function applyHidden(list, hidden) {
    const ids = new Set(list.map(keyOf));
    st.data = { ...st.data, catalogs: catalogs().map((c) => (ids.has(keyOf(c)) ? { ...c, hidden } : c)) };
    st.data.hiddenCount = hiddenCount();
    st.selected = new Set();
    keepFiltersValid();
    drawToolbar();
    drawBody();
  }

  async function setHidden(list, hidden) {
    if (!list.length) return;
    if (hidden) {
      const many = list.length > 1;
      const ok = await confirmDialog({
        title: many ? `Ocultar ${list.length} catálogos` : 'Ocultar catálogo',
        message: many
          ? `Ocultar ${plural(list.length, 'catálogo', 'catálogos')} da sua lista? Eles só somem daqui e da escolha de catálogo nas campanhas: no TikTok continuam existindo, e você pode trazê-los de volta em "Mostrar ocultos".`
          : `Ocultar "${list[0].name || list[0].id}" da sua lista? Ele só some daqui e da escolha de catálogo nas campanhas: no TikTok continua existindo, e você pode trazê-lo de volta em "Mostrar ocultos".`,
        confirmLabel: many ? `Ocultar ${list.length}` : 'Ocultar',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      // o servidor aceita até 100 por pedido
      for (let i = 0; i < list.length; i += 100) {
        await put('/tiktok/catalogs/hidden', { hidden, items: list.slice(i, i + 100).map((c) => ({ bcId: c.bcId, catalogId: c.id })) });
      }
      applyHidden(list, hidden);
      toast(hidden ? `${plural(list.length, 'catálogo ocultado', 'catálogos ocultados')}. Para ver de novo, use "Mostrar ocultos".` : `${plural(list.length, 'catálogo voltou', 'catálogos voltaram')} para a lista.`);
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- filtros ----------
  function setFilter(patch) {
    st.filters = normalizeFilters({ ...st.filters, ...patch });
    st.selected = new Set([...st.selected].filter((id) => visible().some((c) => keyOf(c) === id)));
    keepFiltersValid();
    drawToolbar();
    drawBody();
  }

  function selectFilter(label, value, options, onChange) {
    const select = h('select', { class: 'input input--filter', 'aria-label': label, onChange: (e) => onChange(e.target.value) }, options.map(([v, text]) => h('option', { value: v }, text)));
    select.value = value;
    return select;
  }

  function drawToolbar() {
    const list = catalogs();
    const countHidden = st.filters.showHidden;
    const bcs = bcOptions(list, { countHidden });
    const regions = regionOptions(list, { countHidden });
    const hidden = hiddenCount();
    const clear = hasActiveFilters(st.filters)
      ? button('Limpar filtros', { small: true, onClick: () => setFilter({ bcId: '', status: '', region: '', q: '' }) })
      : null;
    clear?.setAttribute('data-clear', '1');
    setChildren(toolbar,
      h('input', {
        class: 'input toolbar__search', type: 'search', maxlength: 100, placeholder: 'Buscar catálogo por nome ou ID…', 'aria-label': 'Buscar catálogos', value: st.filters.q,
        onInput: (e) => {
          st.filters.q = e.target.value.slice(0, 100);
          drawBody();
          if ((hasActiveFilters(st.filters)) !== Boolean(toolbar.querySelector('[data-clear]'))) drawToolbarKeepingSearch(e.target);
        },
      }),
      bcs.length > 1 ? selectFilter('Business Center', st.filters.bcId, [['', `Todas as Business Centers (${bcs.length})`], ...bcs.map((o) => [o.bcId, `${o.name} · ${plural(o.count, 'catálogo', 'catálogos')}`])], (value) => setFilter({ bcId: value })) : null,
      list.length ? selectFilter('Situação', st.filters.status, STATUS_FILTERS, (value) => setFilter({ status: value })) : null,
      regions.length > 1 ? selectFilter('País e moeda', st.filters.region, [['', 'Todos os países'], ...regions.map((r) => [r, r])], (value) => setFilter({ region: value })) : null,
      clear,
      hidden ? h('button', { type: 'button', class: `btn btn--secondary btn--sm${st.filters.showHidden ? ' is-on' : ''}`, 'aria-pressed': String(st.filters.showHidden), onClick: () => setFilter({ showHidden: !st.filters.showHidden }) }, st.filters.showHidden ? `Esconder ocultos (${hidden})` : `Mostrar ocultos (${hidden})`) : null,
      button('Atualizar', { small: true, onClick: async () => { if (await load({ fresh: true })) toast('Catálogos atualizados.'); } }));
  }

  /** O botão "Limpar filtros" aparece/some ao digitar, sem recriar a caixa de busca (o foco e o cursor ficam onde estão). */
  function drawToolbarKeepingSearch(input) {
    const caret = input.selectionStart;
    drawToolbar();
    const fresh = toolbar.querySelector('input[type=search]');
    fresh.focus();
    fresh.setSelectionRange(caret, caret);
  }

  // ---------- seleção ----------
  function drawSelection() {
    const chosen = [...st.selected].map(byId).filter(Boolean);
    selectionBar.hidden = Boolean(st.detail) || !chosen.length;
    const toHide = chosen.filter((c) => !c.hidden);
    const toShow = chosen.filter((c) => c.hidden);
    setChildren(selectionBar,
      h('strong', null, `${chosen.length} ${chosen.length === 1 ? 'selecionado' : 'selecionados'}`),
      toHide.length ? button(`Ocultar${toHide.length > 1 ? ` ${toHide.length}` : ''}`, { small: true, variant: 'danger-ghost', onClick: () => setHidden(toHide, true) }) : null,
      toShow.length ? button(`Mostrar de volta${toShow.length > 1 ? ` ${toShow.length}` : ''}`, { small: true, variant: 'primary', onClick: () => setHidden(toShow, false) }) : null,
      button('Limpar seleção', { small: true, onClick: () => { st.selected = new Set(); drawBody(); } }));
  }

  function toggle(c, on) {
    if (on) st.selected.add(keyOf(c));
    else st.selected.delete(keyOf(c));
    drawSelection();
    const all = visible();
    const head = body.querySelector('input[data-all]');
    if (head) {
      head.checked = all.length > 0 && all.every((x) => st.selected.has(keyOf(x)));
      head.indeterminate = !head.checked && all.some((x) => st.selected.has(keyOf(x)));
    }
    body.querySelector(`tr[data-catalog="${keyOf(c)}"]`)?.classList.toggle('is-selected', on);
  }

  function row(c) {
    const ready = c.adCreationEligible;
    const picked = st.selected.has(keyOf(c));
    return h('tr', { 'data-catalog': keyOf(c), class: `${c.hidden ? 'is-hidden-row' : ''}${picked ? ' is-selected' : ''}`.trim() || null },
      h('td', { class: 'catalog__check', 'data-label': 'Selecionar' }, h('input', { type: 'checkbox', checked: picked, 'aria-label': `Selecionar ${c.name || c.id}`, onChange: (e) => toggle(c, e.target.checked) })),
      h('td', { 'data-label': 'Catálogo' }, h('span', { class: 'cell-strong', title: c.name }, c.name || c.id), c.hidden ? badge('Oculto', 'neutral') : null, h('span', { class: 'acc-id' }, `ID ${c.id}`)),
      h('td', { 'data-label': 'Business Center' }, c.bcName || `BC ${c.bcId}`, h('span', { class: 'acc-id' }, `${c.bcId} · ${c.connectionName}`)),
      h('td', { 'data-label': 'País · moeda' }, regionLabel(c) || '—'),
      h('td', { 'data-label': 'Anúncios' }, ready ? badge('Pronto para anúncios', 'success') : badge('Sem produtos disponíveis', 'warning')),
      h('td', { class: 'muted', 'data-label': 'Atualizado' }, c.updatedAt ? formatDate(`${c.updatedAt.replace(' ', 'T')}Z`) : '—'),
      h('td', { class: 'catalog__actions' },
        button('Abrir', { small: true, onClick: () => openDetail(c) }),
        ' ',
        c.hidden
          ? button('Mostrar', { small: true, ariaLabel: `Mostrar ${c.name || c.id} na lista`, onClick: () => setHidden([c], false) })
          : button('Ocultar', { small: true, variant: 'danger-ghost', ariaLabel: `Ocultar ${c.name || c.id} da lista`, onClick: () => setHidden([c], true) })));
  }

  function drawBody() {
    if (st.detail) return undefined;
    drawSelection();
    if (st.loading && !st.data) return setChildren(body, spinner());
    if (st.error) return setChildren(body, alertBox(st.error), h('p', null, button('Tentar de novo', { onClick: () => load() })));
    if (!st.data) return setChildren(body, spinner());
    if (!st.data.totalConnections) {
      return setChildren(body, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Os catálogos ficam dentro de uma Business Center. Conecte uma para criar e gerenciar catálogos aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
    }
    const failed = st.data.businessCenters.filter((b) => b.status === 'error');
    const notices = failed.map((b) => alertBox(`${b.bcId ? `BC ${b.bcId}` : b.connectionName}: ${b.error}`, 'warning'));
    const list = visible();
    const total = catalogs().length;
    const hidden = hiddenCount();
    const allHidden = total > 0 && hidden === total && !st.filters.showHidden;
    const allChecked = list.length > 0 && list.every((c) => st.selected.has(keyOf(c)));
    const someChecked = !allChecked && list.some((c) => st.selected.has(keyOf(c)));
    const headBox = h('input', { type: 'checkbox', 'data-all': '1', checked: allChecked, 'aria-label': 'Selecionar todos os catálogos da lista', onChange: (e) => {
      st.selected = e.target.checked ? new Set(list.map(keyOf)) : new Set();
      drawBody();
    } });
    headBox.indeterminate = someChecked;
    setChildren(body,
      ...notices,
      st.loading ? h('p', { class: 'muted' }, 'Atualizando…') : null,
      list.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'catalog__check' }, headBox), ...['Catálogo', 'Business Center', 'País · moeda', 'Anúncios', 'Atualizado', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, list.map(row))))
        : h('div', { class: 'card' }, emptyState(
          allHidden
            ? { title: 'Todos os catálogos estão ocultos', text: 'Eles só ficam escondidos da sua lista. Use "Mostrar ocultos" para trazê-los de volta.', action: button(`Mostrar ocultos (${hidden})`, { variant: 'primary', onClick: () => setFilter({ showHidden: true }) }) }
            : total
              ? { title: 'Nenhum catálogo com esses filtros', text: 'Mude a Business Center, a situação ou a busca.', action: hasActiveFilters(st.filters) ? button('Limpar filtros', { onClick: () => setFilter({ bcId: '', status: '', region: '', q: '' }) }) : null }
              : { title: 'Você ainda não tem catálogos', text: 'Crie o primeiro catálogo, adicione seus produtos e use-o em campanhas de Vendas de produtos.', action: canWrite() && manageableBcs().length ? button('+ Criar catálogo', { variant: 'primary', onClick: create }) : null },
        )),
      total ? h('p', { class: 'muted catalog__count' }, `${list.length === total ? plural(total, 'catálogo', 'catálogos') : `${list.length} de ${plural(total, 'catálogo', 'catálogos')}`}${hidden && !st.filters.showHidden ? ` · ${plural(hidden, 'oculto', 'ocultos')}` : ''}`) : null);
    return undefined;
  }

  setChildren(root, header, toolbar, selectionBar, body);
  drawHeader();
  drawToolbar();
  drawBody();
  load();
  return { element: root, cleanup: () => { loadId += 1; } };
}
