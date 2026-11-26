import { isProblem, statusInfo } from '/shared/ad-status.js';
import { DATE_PRESETS, MAX_CUSTOM_DAYS, MAX_VIEW_NAME, STATUS_FILTERS, appliesTo, columnLabel, columnOf, defaultViewConfig, normalizeViewConfig } from '/shared/manager-columns.js';
import { DEFAULT_LEVEL, LEVEL_IDS, MANAGER_LEVELS, budgetLabel, goalLabel, objectiveLabel } from '/shared/manager-levels.js';
import { del, get, patch, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { formatCurrency, formatDate, formatNumber, formatPercent } from '../format.js';
import { can } from '../state.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, spinner, toast } from '../ui.js';
import { pageHeader } from './layout.js';
import { popover } from './popover.js';

/**
 * Gerenciador: campanhas, grupos de anúncios e anúncios de TODAS as contas, cada nível na sua aba (clicar numa campanha abre os grupos dela; num
 * grupo, os anúncios dele), com status, data de publicação, resultado, gasto, CPC e cliques no link, CTR, ativar/pausar, colunas que se movem
 * (arrastando ou pelos botões), filtros (o período começa em HOJE) e visualizações salvas por pessoa. O período vai ao servidor (uma consulta por
 * nível, guardada enquanto a pessoa troca de aba); busca, situação, conta e ordenação são feitos aqui (instantâneo).
 * Todo texto (nomes de anúncio, campanhas, mensagens do TikTok) entra como nó de texto, nunca como HTML.
 */

const STATUS_LABELS = { '': 'Todas as situações', active: 'Ativos', paused: 'Pausados', delivering: 'Em veiculação', problem: 'Com problema' };
const money = (value, currency) => (value === null || value === undefined ? '—' : formatCurrency(value, currency));
const num = (value) => (value === null || value === undefined ? '—' : formatNumber(Math.round(value * 100) / 100));
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const canChange = () => can('campaigns');
const isNumeric = (col) => ['money', 'number', 'percent', 'budget'].includes(col.type);

export async function managerView() {
  const defaults = defaultViewConfig();
  const st = {
    config: structuredClone(defaults), // visualização em uso (colunas, ordem, ordenação, filtros, período, tamanho da página)
    views: [], currentViewId: null, baseConfig: JSON.stringify(defaults), // a visualização salva escolhida e como ela estava ao ser carregada
    custom: { from: '', to: '' }, search: '', page: 1, selected: new Set(),
    level: DEFAULT_LEVEL, parent: null, // aba aberta e filtro vindo de um clique em campanha/grupo: { level, id, name }
    cache: {}, // nível -> última resposta do servidor (ao trocar de aba, não consulta de novo o que já carregou no mesmo período)
    data: null, loading: false, error: null,
  };
  const root = h('div', { class: 'manager' });
  let loadId = 0;
  const levelDef = () => MANAGER_LEVELS[st.level];
  const rowsOf = (data = st.data) => data?.[st.level] ?? [];
  const periodParams = () => {
    const params = new URLSearchParams({ preset: st.config.datePreset });
    if (st.config.datePreset === 'custom') {
      params.set('from', st.custom.from);
      params.set('to', st.custom.to);
    }
    return params;
  };

  // ---------- dados ----------
  async function load({ fresh = false, reset = false } = {}) {
    const current = ++loadId;
    const level = st.level;
    if (fresh || reset) st.cache = {}; // "Atualizar" e a troca de período descartam o que estava guardado; cada aba busca de novo ao abrir
    st.loading = true;
    st.error = null;
    if (fresh || reset) drawTabs(); // as contagens das abas saem junto com o cache
    drawBody();
    try {
      const params = periodParams();
      if (fresh) params.set('refresh', '1');
      const data = await get(`/tiktok/manager/${level}?${params}`);
      if (current !== loadId) return false;
      st.data = data;
      st.cache[level] = data;
      drawTabs();
      st.selected.clear();
      st.page = 1;
      return true;
    } catch (err) {
      if (current === loadId) st.error = err.message;
      return false;
    } finally {
      if (current === loadId) {
        st.loading = false;
        drawToolbar();
        drawBody();
      }
    }
  }

  // ---------- derivados ----------
  const statusOf = (row) => statusInfo(st.level, row.status);
  const columnsHere = () => st.config.columns.filter((c) => appliesTo(columnOf(c.key), st.level));
  /** Ordenação válida neste nível (uma coluna que só existe em outro nível volta para "Valor gasto"). */
  const sortKeyHere = () => (appliesTo(columnOf(st.config.sort.key), st.level) ? st.config.sort.key : 'spend');
  function visibleRows() {
    if (!st.data) return [];
    const { status, accountId, onlySpent } = st.config.filters;
    const q = normalize(st.search);
    const parent = st.parent;
    return rowsOf().filter((a) => {
      if (parent?.level === 'campaigns' && a.campaignId !== parent.id) return false;
      if (parent?.level === 'adgroups' && a.adgroupId !== parent.id) return false;
      if (accountId && a.advertiserId !== accountId) return false;
      if (onlySpent && !(a.spend > 0)) return false;
      if (status === 'active' && a.operationStatus !== 'ENABLE') return false;
      if (status === 'paused' && a.operationStatus !== 'DISABLE') return false;
      if (status === 'delivering' && a.status !== levelDef().enabledStatus) return false;
      if (status === 'problem' && !isProblem(st.level, a.status)) return false;
      if (q && !normalize(`${a.name} ${a.id} ${a.campaignName ?? ''} ${a.adgroupName ?? ''} ${a.accountName}`).includes(q)) return false;
      return true;
    });
  }

  const sortValue = (ad, key) => {
    switch (key) {
      case 'name': return normalize(ad.name);
      case 'status': return statusOf(ad).label;
      case 'toggle': return ad.operationStatus === 'ENABLE' ? 1 : 0;
      case 'account': return normalize(ad.accountName);
      case 'campaign': return normalize(ad.campaignName);
      case 'adgroup': return normalize(ad.adgroupName);
      case 'objective': return normalize(objectiveLabel(ad.objectiveType));
      case 'goal': return normalize(goalLabel(ad.optimizationGoal));
      case 'budget': return ad.budgetMode === 'BUDGET_MODE_INFINITE' ? 0 : (ad.budget ?? null);
      default: return ad[key] ?? null;
    }
  };
  function sorted(list) {
    const { dir } = st.config.sort;
    const key = sortKeyHere();
    const sign = dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // vazios sempre no fim
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.id.localeCompare(b.id);
    });
  }

  // ---------- ativar / pausar ----------
  function announce(results, status, levelId) {
    const level = MANAGER_LEVELS[levelId];
    const updated = results.reduce((n, r) => n + r.updated.length, 0);
    const failed = results.reduce((n, r) => n + r.failed.length, 0);
    const failure = results.find((r) => r.failure)?.failure;
    if (failed) return toast(`${updated} alterado(s); ${failed} não mudaram${failure ? `: ${failure}` : '.'}`, 'danger');
    const on = status === 'ENABLE';
    const fem = level.article === 'a';
    if (updated === 1) return toast(`${level.singular.charAt(0).toUpperCase()}${level.singular.slice(1)} ${on ? 'ativ' : 'paus'}${fem ? 'ada' : 'ado'}.`);
    return toast(`${updated} ${level.plural} ${on ? 'ativ' : 'paus'}${fem ? 'adas' : 'ados'}.`);
  }

  /** Ativa/pausa itens do nível aberto, de UMA conta. `silent`: quem chama junta os avisos (ação em massa). Sempre devolve { updated, failed, failure }. */
  async function changeStatus(advertiserId, rows, status, { silent = false } = {}) {
    const levelId = st.level;
    const level = MANAGER_LEVELS[levelId];
    const ids = rows.map((r) => r.id);
    const before = new Map(rows.map((r) => [r.id, { op: r.operationStatus, status: r.status }]));
    const restore = (list) => { for (const r of list) Object.assign(r, { operationStatus: before.get(r.id).op, status: before.get(r.id).status }); };
    for (const r of rows) { // otimista: o interruptor responde na hora; volta se der erro
      r.operationStatus = status === 'ENABLE' ? 'ENABLE' : 'DISABLE';
      r.status = status === 'ENABLE' ? level.enabledStatus : level.disabledStatus;
    }
    drawBody();
    let result;
    try {
      result = await post(`/tiktok/manager/${levelId}/status`, { advertiserId, [level.idsField]: ids, status });
      const done = new Set(result.updated);
      restore(rows.filter((r) => !done.has(r.id)));
    } catch (err) {
      restore(rows);
      result = { updated: [], failed: ids, failure: err.message };
    }
    if (result.updated.length) st.cache = { [levelId]: st.data }; // pausar uma campanha muda o status dos grupos e anúncios dela: as outras abas buscam de novo
    drawBody();
    if (!silent) {
      announce([result], status, levelId);
      refreshQuietly(); // o status exato (ex.: "em análise") vem do TikTok: busca de novo sem perder o que a pessoa está vendo
    }
    return result;
  }
  async function refreshQuietly() {
    const levelId = st.level;
    try {
      const params = periodParams();
      params.set('refresh', '1');
      const data = await get(`/tiktok/manager/${levelId}?${params}`);
      if (st.level !== levelId) return; // a pessoa já trocou de aba: essa aba busca de novo ao abrir
      st.data = data;
      st.cache[levelId] = data;
      drawBody();
    } catch {
      /* mantém o que está na tela */
    }
  }

  async function bulk(status) {
    const levelId = st.level;
    const level = MANAGER_LEVELS[levelId];
    const rows = rowsOf().filter((r) => st.selected.has(r.key) && r.operationStatus !== 'FROZEN');
    if (!rows.length) return toast(`Nenhum${level.article === 'a' ? 'a' : ''} ${level.singular} selecionável (itens encerrados não podem ser ativados).`, 'danger');
    const ok = await confirmDialog({
      title: status === 'ENABLE' ? `Ativar ${rows.length} ${rows.length === 1 ? level.singular : level.plural}?` : `Pausar ${rows.length} ${rows.length === 1 ? level.singular : level.plural}?`,
      message: ((fem) => {
        const subject = `${level.article === 'a' ? 'As' : 'Os'} ${level.plural} selecionad${fem ? 'as' : 'os'}`;
        if (levelId === 'ads') return status === 'ENABLE' ? 'Os anúncios selecionados voltam a veicular e a gastar.' : 'Os anúncios selecionados deixam de veicular.';
        return status === 'ENABLE' ? `${subject} voltam a veicular (só gastam os anúncios que estiverem ativos dentro ${fem ? 'delas' : 'deles'}).` : `${subject} e tudo o que está dentro ${fem ? 'delas' : 'deles'} deixam de veicular.`;
      })(level.article === 'a'),
      confirmLabel: status === 'ENABLE' ? 'Ativar' : 'Pausar',
      danger: status !== 'ENABLE',
    });
    if (!ok) return undefined;
    const byAccount = new Map();
    for (const r of rows) byAccount.set(r.advertiserId, [...(byAccount.get(r.advertiserId) ?? []), r]);
    st.selected.clear();
    const results = await Promise.all([...byAccount.entries()].map(([advertiserId, list]) => changeStatus(advertiserId, list, status, { silent: true })));
    announce(results, status, levelId);
    refreshQuietly();
    return undefined;
  }

  // ---------- visualizações salvas ----------
  const currentConfigJson = () => JSON.stringify(st.config);
  const isDirty = () => currentConfigJson() !== st.baseConfig;
  const currentView = () => st.views.find((v) => v.id === st.currentViewId) ?? null;

  function applyConfig(config, viewId) {
    st.config = structuredClone(normalizeViewConfig(config) ?? defaults);
    st.currentViewId = viewId;
    st.baseConfig = currentConfigJson();
  }

  async function loadViews() {
    try {
      const data = await get('/tiktok/manager/views');
      st.views = data.views;
      const initial = st.views.find((v) => v.isDefault);
      if (initial) applyConfig(initial.config, initial.id);
    } catch {
      st.views = []; // sem as visualizações, usa a padrão do sistema
    }
  }

  function nameDialog({ title, initial = '', makeDefault = false, onSubmit }) {
    const name = field('Nome da visualização', { type: 'text', required: true, maxlength: MAX_VIEW_NAME, value: initial, placeholder: 'Ex.: Só com gasto, por CTR', autocomplete: 'off' });
    const star = h('input', { type: 'checkbox', checked: makeDefault });
    const errorSlot = h('div');
    const submit = button('Salvar', { variant: 'primary', type: 'submit' });
    const modal = openModal({
      title,
      body: h(
        'form',
        {
          class: 'form modal__body',
          novalidate: true,
          onSubmit: async (event) => {
            event.preventDefault();
            errorSlot.replaceChildren();
            submit.disabled = true;
            try {
              await onSubmit(name.control.value.trim(), star.checked);
              modal.close();
            } catch (err) {
              errorSlot.replaceChildren(alertBox(err.message));
              submit.disabled = false;
            }
          },
        },
        errorSlot,
        name.element,
        h('label', { class: 'check' }, star, h('span', null, 'Abrir sempre com esta visualização')),
        h('p', { class: 'field__hint' }, 'Guarda as colunas (e a ordem delas), a ordenação, os filtros e o período. O período personalizado e a busca não são salvos.'),
        h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
      ),
    });
    name.control.select();
  }

  const configToSave = () => ({ ...st.config, datePreset: st.config.datePreset === 'custom' ? 'today' : st.config.datePreset });

  function saveAsNew() {
    nameDialog({
      title: 'Salvar visualização',
      onSubmit: async (name, makeDefault) => {
        const { view } = await post('/tiktok/manager/views', { name, config: configToSave(), isDefault: makeDefault });
        await loadViews();
        applyConfig(view.config, view.id);
        toast('Visualização salva.');
        drawToolbar();
      },
    });
  }
  async function saveChanges() {
    const view = currentView();
    if (!view) return saveAsNew();
    try {
      const { view: updated } = await patch(`/tiktok/manager/views/${view.id}`, { config: configToSave() });
      await loadViews();
      applyConfig(updated.config, updated.id);
      toast('Visualização atualizada.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    drawToolbar();
    return undefined;
  }
  async function toggleDefault() {
    const view = currentView();
    if (!view) return;
    try {
      await patch(`/tiktok/manager/views/${view.id}`, { isDefault: !view.isDefault });
      await loadViews();
      toast(view.isDefault ? 'Não abre mais por padrão.' : 'Esta visualização abrirá por padrão.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    drawToolbar();
  }
  async function removeView() {
    const view = currentView();
    if (!view) return;
    const ok = await confirmDialog({ title: 'Excluir visualização', message: `Excluir a visualização "${view.name}"? Os anúncios não são afetados.`, confirmLabel: 'Excluir', danger: true });
    if (!ok) return;
    try {
      await del(`/tiktok/manager/views/${view.id}`);
      await loadViews();
      applyConfig(defaults, null);
      toast('Visualização excluída.');
      await load({ reset: true });
    } catch (err) {
      toast(err.message, 'danger');
    }
  }
  function chooseView(value) {
    const view = st.views.find((v) => String(v.id) === value);
    const presetBefore = st.config.datePreset;
    applyConfig(view ? view.config : defaults, view ? view.id : null);
    st.page = 1;
    drawToolbar();
    if (st.config.datePreset !== presetBefore) load({ reset: true });
    else drawBody();
  }

  // ---------- colunas ----------
  function moveColumn(key, targetKey) {
    const cols = st.config.columns;
    const from = cols.findIndex((c) => c.key === key);
    const to = cols.findIndex((c) => c.key === targetKey);
    if (from < 0 || to < 0 || from === to) return;
    const [item] = cols.splice(from, 1);
    cols.splice(to, 0, item);
    drawToolbar();
    drawBody();
  }

  function columnsDialog() {
    const list = h('ul', { class: 'manager-cols' });
    function paint() {
      const here = columnsHere(); // só as colunas que existem neste nível (as outras ficam como estão)
      setChildren(
        list,
        here.map((c, i) => {
          const def = columnOf(c.key);
          const locked = c.key === 'name';
          return h(
            'li',
            { class: 'manager-cols__item' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.visible, disabled: locked, onChange: (e) => { c.visible = e.target.checked; drawToolbar(); drawBody(); } }), h('span', null, columnLabel(def, st.level), locked ? ' (sempre visível)' : '')),
            h('span', { class: 'manager-cols__move' },
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Mover ${columnLabel(def, st.level)} para cima`, disabled: i === 0, onClick: () => { moveColumn(c.key, here[i - 1].key); paint(); } }, '↑'),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Mover ${columnLabel(def, st.level)} para baixo`, disabled: i === here.length - 1, onClick: () => { moveColumn(c.key, here[i + 1].key); paint(); } }, '↓')),
          );
        }),
      );
    }
    paint();
    const modal = openModal({
      title: 'Colunas',
      body: h('div', { class: 'modal__body' }, h('p', { class: 'muted' }, 'Marque as colunas que quer ver e use as setas para mudar a ordem. Também dá para arrastar o título da coluna na tabela.'), list,
        h('div', { class: 'modal__footer' }, button('Restaurar padrão', { onClick: () => { st.config.columns = structuredClone(defaults.columns); paint(); drawToolbar(); drawBody(); } }), button('Pronto', { variant: 'primary', onClick: () => modal.close() }))),
    });
  }

  // ---------- abas (campanhas > grupos de anúncios > anúncios) ----------
  const tabs = h('div', { class: 'tabs tabs--hub manager__tabs', role: 'tablist', 'aria-label': 'Nível do Gerenciador' });
  function drawTabs() {
    setChildren(tabs, LEVEL_IDS.map((id) => {
      const count = st.cache[id]?.[id]?.length;
      return h('button', { type: 'button', role: 'tab', class: `tab${st.level === id ? ' is-active' : ''}`, 'aria-selected': String(st.level === id), onClick: () => openLevel(id) },
        MANAGER_LEVELS[id].tab, count === undefined ? null : h('span', { class: 'tab__count' }, formatNumber(count)));
    }));
  }

  /** Abre uma aba. Já carregada neste período = aparece na hora; senão consulta o TikTok. `parent`: veio de um clique em campanha/grupo. */
  function openLevel(id, { parent = null } = {}) {
    if (id === st.level && !parent && !st.parent) return;
    loadId += 1; // descarta a resposta de uma consulta ainda em andamento (de outra aba)
    st.level = id;
    st.parent = parent;
    st.selected.clear();
    st.search = '';
    st.page = 1;
    st.error = null;
    const cached = st.cache[id];
    st.data = cached ?? null;
    st.loading = !cached;
    drawTabs();
    drawToolbar();
    if (cached) drawBody();
    else load();
  }

  // ---------- desenho: barra de ferramentas ----------
  // Poucos controles à vista: busca, período, Filtros, a visualização em uso (um menu), Colunas e Atualizar. Conta, situação e "só com gasto"
  // ficam dentro de "Filtros" (com o número de filtros ligados) e aparecem como chips removíveis quando estão em uso.
  const toolbar = h('div', { class: 'manager__toolbar' });
  const ui = { open: null }; // painel aberto ('filters' | 'views' | null): guardado aqui para a barra poder ser redesenhada sem fechá-lo
  const remember = (name) => (isOpen) => { ui.open = isOpen ? name : (ui.open === name ? null : ui.open); };

  function refreshAction(event) {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    load({ fresh: true }).then((done) => { if (done) toast('Lista atualizada.'); else trigger.disabled = false; });
  }

  function filtersSummary(accounts) {
    const f = st.config.filters;
    const chips = [];
    if (f.accountId) chips.push({ text: `Conta: ${accounts.find((a) => a.id === f.accountId)?.name ?? f.accountId}`, clear: () => { f.accountId = ''; } });
    if (f.status) chips.push({ text: `Situação: ${STATUS_LABELS[f.status]}`, clear: () => { f.status = ''; } });
    if (f.onlySpent) chips.push({ text: 'Só com gasto', clear: () => { f.onlySpent = false; } });
    return chips;
  }

  function drawToolbar() {
    const view = currentView();
    const dirty = isDirty();
    const accounts = st.data?.accounts ?? [];
    const chips = filtersSummary(accounts);
    const refilter = () => { st.page = 1; drawToolbar(); drawBody(); };

    const search = h('input', { class: 'input toolbar__search manager__search', type: 'search', maxlength: 100, placeholder: levelDef().searchHint, 'aria-label': `Buscar ${levelDef().plural}`, value: st.search,
      onInput: (e) => { st.search = e.target.value; st.page = 1; drawBody(); } });

    const preset = h('select', { class: 'input input--filter manager__period', 'aria-label': 'Período', onChange: (e) => { st.config.datePreset = e.target.value; drawToolbar(); if (e.target.value !== 'custom') load({ reset: true }); } },
      DATE_PRESETS.map((p) => h('option', { value: p.id }, p.label)), h('option', { value: 'custom' }, 'Personalizado…'));
    preset.value = st.config.datePreset;

    // ----- Filtros (painel) -----
    const accountSelect = h('select', { class: 'input input--filter', id: 'manager-filter-account', 'aria-label': 'Conta de anúncio', onChange: (e) => { st.config.filters.accountId = e.target.value; refilter(); } },
      h('option', { value: '' }, `Todas as contas${accounts.length ? ` (${accounts.length})` : ''}`),
      accounts.map((a) => h('option', { value: a.id }, `${a.name}${a.status === 'error' ? ' · erro' : ''}`)));
    accountSelect.value = st.config.filters.accountId;
    const statusSelect = h('select', { class: 'input input--filter', id: 'manager-filter-status', 'aria-label': 'Situação', onChange: (e) => { st.config.filters.status = e.target.value; refilter(); } },
      STATUS_FILTERS.map((v) => h('option', { value: v }, STATUS_LABELS[v])));
    statusSelect.value = st.config.filters.status;
    const filtersPanel = h('div', { class: 'manager__panel' },
      h('label', { class: 'manager__panel-field', for: 'manager-filter-account' }, h('span', { class: 'field__label' }, 'Conta de anúncio'), accountSelect),
      h('label', { class: 'manager__panel-field', for: 'manager-filter-status' }, h('span', { class: 'field__label' }, 'Situação'), statusSelect),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.config.filters.onlySpent, onChange: (e) => { st.config.filters.onlySpent = e.target.checked; refilter(); } }), h('span', null, 'Só com gasto no período')),
      chips.length ? h('button', { type: 'button', class: 'manager__linkbtn', onClick: () => { for (const chip of chips) chip.clear(); refilter(); } }, 'Limpar filtros') : null);
    const filters = popover({
      label: ['Filtros', chips.length ? h('span', { class: 'manager__count' }, String(chips.length)) : null],
      ariaLabel: chips.length ? `Filtros: ${chips.length} em uso` : 'Filtros', content: filtersPanel, open: ui.open === 'filters', onToggle: remember('filters'),
    });

    // ----- Visualização (menu) -----
    const viewName = view ? `${view.isDefault ? '★ ' : ''}${view.name}` : 'Padrão do sistema';
    const choose = (id) => () => { ui.open = null; chooseView(id === null ? '' : String(id)); };
    const item = (label, onClick, { danger = false, checked = false } = {}) => h('button', { type: 'button', role: 'menuitem', class: `manager__menuitem${checked ? ' is-checked' : ''}${danger ? ' is-danger' : ''}`, onClick }, label);
    const act = (fn) => () => { ui.open = null; fn(); };
    const viewsPanel = h('div', { class: 'manager__menu', role: 'menu', 'aria-label': 'Visualizações' },
      h('p', { class: 'manager__menu-title' }, 'Visualizações'),
      item('Padrão do sistema', choose(null), { checked: st.currentViewId === null }),
      st.views.map((v) => item(`${v.isDefault ? '★ ' : ''}${v.name}`, choose(v.id), { checked: v.id === st.currentViewId })),
      h('hr', { class: 'manager__menu-sep' }),
      view ? item(dirty ? 'Salvar alterações' : 'Salvar alterações (nada mudou)', act(saveChanges)) : item('Salvar como visualização…', act(saveAsNew)),
      view ? item('Salvar como nova…', act(saveAsNew)) : null,
      view ? item(view.isDefault ? 'Não abrir mais por padrão' : 'Abrir sempre com esta', act(toggleDefault)) : null,
      view ? item('Excluir esta visualização', act(removeView), { danger: true }) : null);
    const views = popover({
      label: [h('span', { class: 'manager__viewlabel' }, 'Visualização'), h('strong', { class: 'manager__viewname' }, viewName), dirty ? h('span', { class: 'manager__dirty', title: 'Você mudou colunas, filtros ou ordem desde que abriu esta visualização' }, 'alterada') : null],
      ariaLabel: `Visualização: ${viewName}${dirty ? ' (alterada)' : ''}`, content: viewsPanel, open: ui.open === 'views', onToggle: remember('views'), align: 'right',
    });

    const customBox = st.config.datePreset === 'custom'
      ? h('div', { class: 'manager__row manager__custom' },
        h('input', { class: 'input input--filter', type: 'date', 'aria-label': 'Data inicial', value: st.custom.from, onChange: (e) => { st.custom.from = e.target.value; } }),
        h('span', { class: 'muted' }, 'até'),
        h('input', { class: 'input input--filter', type: 'date', 'aria-label': 'Data final', value: st.custom.to, onChange: (e) => { st.custom.to = e.target.value; } }),
        button('Aplicar', { small: true, variant: 'primary', onClick: () => {
          if (!st.custom.from || !st.custom.to || st.custom.from > st.custom.to) return toast('Informe as duas datas (a inicial não pode ser depois da final).', 'danger');
          return load({ reset: true });
        } }),
        h('span', { class: 'muted manager__hint' }, `até ${MAX_CUSTOM_DAYS} dias`))
      : null;

    const chipRow = chips.length
      ? h('div', { class: 'manager__row manager__chips', 'aria-label': 'Filtros em uso' },
        chips.map((chip) => h('span', { class: 'manager__chip' }, chip.text, h('button', { type: 'button', class: 'manager__chip-x', 'aria-label': `Remover filtro: ${chip.text}`, onClick: () => { chip.clear(); refilter(); } }, '×'))))
      : null;

    setChildren(
      toolbar,
      h('div', { class: 'manager__row manager__main' },
        search, preset, filters,
        h('div', { class: 'manager__actions' }, views, button('Colunas', { small: true, onClick: columnsDialog }), button('Atualizar', { small: true, ariaLabel: `Atualizar ${levelDef().plural}`, onClick: refreshAction }))),
      customBox,
      chipRow,
    );
  }

  // ---------- desenho: tabela ----------
  const body = h('div', { class: 'manager__body' });

  /** Clicar numa campanha abre os grupos dela; num grupo, os anúncios dele. */
  function drill(row) {
    if (st.level === 'campaigns') openLevel('adgroups', { parent: { level: 'campaigns', id: row.id, name: row.name } });
    else if (st.level === 'adgroups') openLevel('ads', { parent: { level: 'adgroups', id: row.id, name: row.name } });
  }
  const DRILL_HINT = { campaigns: 'Ver os grupos de anúncios desta campanha', adgroups: 'Ver os anúncios deste grupo' };

  function cell(col, row) {
    const label = columnLabel(col, st.level);
    switch (col.key) {
      case 'name': {
        const title = row.name || row.id;
        const sub = st.level === 'campaigns' ? `ID ${row.id}` : `ID ${row.id} · ${row.campaignName || 'sem campanha'}`;
        const name = st.level === 'ads'
          ? h('span', { class: 'cell-strong manager__ad', title }, title)
          : h('button', { type: 'button', class: 'manager__drill cell-strong manager__ad', title: DRILL_HINT[st.level], onClick: () => drill(row) }, title);
        return h('td', { class: 'manager__name', 'data-label': label }, name, h('span', { class: 'acc-id' }, sub));
      }
      case 'status': { const info = statusOf(row); return h('td', { 'data-label': label }, badge(info.label, info.tone)); }
      case 'toggle': {
        const on = row.operationStatus === 'ENABLE';
        const locked = row.operationStatus === 'FROZEN' || !canChange();
        const sw = h('button', {
          type: 'button', class: `switch-ad${on ? ' is-on' : ''}`, role: 'switch', 'aria-checked': String(on), disabled: locked,
          'aria-label': `${on ? 'Pausar' : 'Ativar'} ${row.name}`,
          title: row.operationStatus === 'FROZEN' ? 'Encerrado: não pode ser ativado' : !canChange() ? 'Sem permissão para ativar/pausar' : on ? 'Clique para pausar' : 'Clique para ativar',
          onClick: () => changeStatus(row.advertiserId, [row], on ? 'DISABLE' : 'ENABLE'),
        }, h('span', { class: 'switch-ad__thumb' }));
        return h('td', { 'data-label': label }, sw);
      }
      case 'objective': return h('td', { 'data-label': label }, objectiveLabel(row.objectiveType));
      case 'goal': return h('td', { 'data-label': label }, goalLabel(row.optimizationGoal));
      case 'budget': return h('td', { class: 'num', 'data-label': label }, budgetLabel(row, st.level, money));
      case 'createdAt': return h('td', { class: 'muted manager__date', 'data-label': label }, row.createdAt ? formatDate(row.createdAt) : '—');
      case 'modifiedAt': return h('td', { class: 'muted manager__date', 'data-label': label }, row.modifiedAt ? formatDate(row.modifiedAt) : '—');
      case 'account': return h('td', { 'data-label': label }, row.accountName);
      case 'campaign': return h('td', { 'data-label': label }, row.campaignName || '—');
      case 'adgroup': return h('td', { 'data-label': label }, row.adgroupName || '—');
      case 'spend': return h('td', { class: 'num', 'data-label': label }, money(row.hasMetrics ? row.spend : null, row.currency));
      case 'cpc': case 'costPerResult': case 'costPerConversion': return h('td', { class: 'num', 'data-label': label }, money(row.hasMetrics ? row[col.key] : null, row.currency));
      case 'ctr': return h('td', { class: 'num', 'data-label': label }, row.hasMetrics ? formatPercent(row.ctr) : '—');
      default: return h('td', { class: 'num', 'data-label': label }, row.hasMetrics ? num(row[col.key]) : '—'); // result, clicks, impressions, conversions
    }
  }

  /** Totais por moeda dos anúncios filtrados (moedas diferentes nunca se somam). */
  function totalsRows(list, columns) {
    const byCurrency = new Map();
    for (const a of list) {
      if (!a.hasMetrics) continue;
      const t = byCurrency.get(a.currency ?? '—') ?? { currency: a.currency, spend: 0, impressions: 0, clicks: 0, result: 0, hasResult: true, conversions: 0 };
      t.spend += a.spend; t.impressions += a.impressions; t.clicks += a.clicks; t.conversions += a.conversions;
      if (a.result === null) t.hasResult = false; else t.result += a.result;
      byCurrency.set(a.currency ?? '—', t);
    }
    return [...byCurrency.values()].map((t) => {
      const values = { spend: money(t.spend, t.currency), impressions: num(t.impressions), clicks: num(t.clicks), ctr: t.impressions ? formatPercent((t.clicks / t.impressions) * 100) : '—', cpc: t.clicks ? money(t.spend / t.clicks, t.currency) : '—', result: t.hasResult ? num(t.result) : '—', conversions: num(t.conversions), costPerResult: t.hasResult && t.result ? money(t.spend / t.result, t.currency) : '—', costPerConversion: t.conversions ? money(t.spend / t.conversions, t.currency) : '—' };
      return h('tr', { class: 'manager__total' }, h('td', null), columns.map((c) => h('td', { class: isNumeric(c) ? 'num' : '', 'data-label': columnLabel(c, st.level) }, c.key === 'name' ? `Total${byCurrency.size > 1 ? ` (${t.currency ?? '—'})` : ''}` : (values[c.key] ?? ''))));
    });
  }

  function drawBody() {
    if (st.loading) {
      const n = st.data?.totalAccounts;
      return setChildren(body, h('div', { class: 'card manager__loading' }, spinner(), h('p', { class: 'muted' }, `Buscando ${levelDef().plural}${n ? ` de ${n} contas` : ' de todas as contas'} no TikTok… isso pode levar alguns segundos.`)));
    }
    if (st.error) return setChildren(body, alertBox(st.error), h('p', null, button('Tentar de novo', { onClick: () => load() })));
    if (!st.data) return setChildren(body, spinner());
    if (!st.data.totalAccounts) {
      return setChildren(body, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Conecte uma Business Center para ver e gerenciar as campanhas, os grupos e os anúncios de todas as suas contas aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
    }
    const list = sorted(visibleRows());
    const columns = columnsHere().filter((c) => c.visible).map((c) => columnOf(c.key));
    const pageSize = st.config.pageSize;
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    st.page = Math.min(st.page, pages);
    const pageRows = list.slice((st.page - 1) * pageSize, st.page * pageSize);

    const failed = st.data.accounts.filter((a) => a.status === 'error');
    const noMetrics = st.data.accounts.filter((a) => a.status === 'ok' && a.metricsError);
    const notices = [
      failed.length ? alertBox(`${failed.length} conta(s) não carregaram ${levelDef().plural}: ${failed.slice(0, 3).map((a) => `${a.name} (${a.error})`).join(' · ')}${failed.length > 3 ? '…' : ''}`, 'warning') : null,
      noMetrics.length ? alertBox(`Sem o desempenho de ${noMetrics.length} conta(s) (${levelDef().plural} aparecem sem números): ${noMetrics[0].metricsError}`, 'warning') : null,
      st.data.truncated ? alertBox(`Há mais ${levelDef().plural} do que o limite exibido. Use os filtros ou o período para refinar.`, 'warning') : null,
    ];

    const selectedHere = pageRows.filter((a) => st.selected.has(a.key));
    const headCheck = h('input', { type: 'checkbox', 'aria-label': 'Selecionar todos desta página', checked: pageRows.length > 0 && selectedHere.length === pageRows.length, onChange: (e) => { for (const a of pageRows) { if (e.target.checked) st.selected.add(a.key); else st.selected.delete(a.key); } drawBody(); } });

    const dragState = { key: null };
    const heads = columns.map((c) => {
      const sortedBy = sortKeyHere() === c.key;
      const th = h('th', { scope: 'col', class: `manager__th${isNumeric(c) ? ' num' : ''}`, draggable: 'true', 'aria-sort': sortedBy ? (st.config.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none', title: 'Arraste para mover a coluna' },
        h('button', { type: 'button', class: 'th-sort', disabled: !c.sortable, onClick: () => { st.config.sort = { key: c.key, dir: sortedBy && st.config.sort.dir === 'desc' ? 'asc' : 'desc' }; st.page = 1; drawToolbar(); drawBody(); } }, columnLabel(c, st.level), sortedBy ? (st.config.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''));
      th.addEventListener('dragstart', (e) => { dragState.key = c.key; e.dataTransfer.setData('application/x-manager-col', c.key); e.dataTransfer.effectAllowed = 'move'; th.classList.add('is-dragging'); });
      th.addEventListener('dragend', () => th.classList.remove('is-dragging'));
      th.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-manager-col')) { e.preventDefault(); th.classList.add('is-drop'); } });
      th.addEventListener('dragleave', () => th.classList.remove('is-drop'));
      th.addEventListener('drop', (e) => { e.preventDefault(); th.classList.remove('is-drop'); const from = e.dataTransfer.getData('application/x-manager-col'); if (from && from !== c.key) moveColumn(from, c.key); });
      return th;
    });

    const bulkBar = st.selected.size
      ? h('div', { class: 'selection-bar', role: 'region', 'aria-label': `${levelDef().tab} selecionados` },
        h('strong', null, `${st.selected.size} ${st.selected.size === 1 ? 'selecionado' : 'selecionados'}`),
        canChange() ? button('Ativar', { small: true, variant: 'primary', onClick: () => bulk('ENABLE') }) : null,
        canChange() ? button('Pausar', { small: true, onClick: () => bulk('DISABLE') }) : null,
        button('Limpar seleção', { small: true, onClick: () => { st.selected.clear(); drawBody(); } }))
      : null;

    const range = st.data.accounts.find((a) => a.status === 'ok');
    const rangeText = range ? (range.from === range.to ? `Dados de ${range.from.split('-').reverse().join('/')}` : `Dados de ${range.from.split('-').reverse().join('/')} a ${range.to.split('-').reverse().join('/')}`) : '';
    const summary = h('p', { class: 'muted manager__summary', 'aria-live': 'polite' }, `${list.length} ${list.length === 1 ? levelDef().singular : levelDef().plural}${list.length !== rowsOf().length ? ` de ${rowsOf().length}` : ''} · ${st.data.accounts.length} contas · ${rangeText}${st.config.datePreset === 'today' ? ' (hoje, no fuso de cada conta)' : ''} · atualizado às ${new Date(st.data.fetchedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);

    const pager = pages > 1
      ? h('div', { class: 'manager__pager' },
        button('‹ Anterior', { small: true, disabled: st.page <= 1, onClick: () => { st.page -= 1; drawBody(); } }),
        h('span', { class: 'muted' }, `Página ${st.page} de ${pages}`),
        button('Próxima ›', { small: true, disabled: st.page >= pages, onClick: () => { st.page += 1; drawBody(); } }))
      : null;
    const sizeSelect = h('select', { class: 'input input--filter manager__size', 'aria-label': 'Itens por página', onChange: (e) => { st.config.pageSize = Number(e.target.value); st.page = 1; drawToolbar(); drawBody(); } }, [50, 100, 200].map((n) => h('option', { value: String(n) }, `${n} por página`)));
    sizeSelect.value = String(pageSize);

    setChildren(
      body,
      ...notices,
      st.parent ? h('div', { class: 'manager__parent', role: 'status' },
        h('span', null, `Mostrando só ${levelDef().plural} ${st.parent.level === 'campaigns' ? 'da campanha' : 'do grupo'} `, h('strong', null, st.parent.name || st.parent.id)),
        button(`Ver todos ${levelDef().article === 'a' ? 'as' : 'os'} ${levelDef().plural}`, { small: true, onClick: () => { st.parent = null; st.page = 1; drawBody(); } })) : null,
      summary,
      bulkBar,
      list.length
        ? h('div', { class: 'card table-wrap manager__table' },
          h('table', { class: 'table table--stack' },
            h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'manager__check' }, headCheck), heads)),
            h('tbody', null, pageRows.map((ad) => h('tr', { class: st.selected.has(ad.key) ? 'is-selected' : null },
              h('td', { class: 'manager__check', 'data-label': 'Selecionar' }, h('input', { type: 'checkbox', 'aria-label': `Selecionar ${ad.name}`, checked: st.selected.has(ad.key), onChange: (e) => { if (e.target.checked) st.selected.add(ad.key); else st.selected.delete(ad.key); drawBody(); } })),
              columns.map((c) => cell(c, ad))))),
            h('tfoot', null, totalsRows(list, columns))))
        : h('div', { class: 'card' }, emptyState({ title: rowsOf().length ? `Nenhum${levelDef().article === 'a' ? 'a' : ''} ${levelDef().singular} com esses filtros` : `Nenhum${levelDef().article === 'a' ? 'a' : ''} ${levelDef().singular} nas suas contas`, text: rowsOf().length ? 'Mude o período, a situação, a busca ou o filtro.' : levelDef().emptyHint })),
      h('div', { class: 'manager__footer' }, sizeSelect, pager),
    );
    return undefined;
  }

  setChildren(root, pageHeader('Gerenciador', 'Campanhas, grupos de anúncios e anúncios de todas as suas contas.'), tabs, toolbar, body);
  drawTabs();
  drawBody();
  await loadViews();
  drawToolbar();
  load(); // não bloqueia a abertura da tela: mostra "carregando" enquanto o TikTok responde
  return { element: root, cleanup: () => { loadId += 1; } };
}
