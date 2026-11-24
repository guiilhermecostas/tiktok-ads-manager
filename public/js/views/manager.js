import { DATE_PRESETS, MAX_CUSTOM_DAYS, MAX_VIEW_NAME, STATUS_FILTERS, columnOf, defaultViewConfig, normalizeViewConfig } from '/shared/manager-columns.js';
import { adStatusInfo, isAdProblem } from '/shared/ad-status.js';
import { del, get, patch, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { formatCurrency, formatDate, formatNumber, formatPercent } from '../format.js';
import { can } from '../state.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, spinner, toast } from '../ui.js';
import { pageHeader } from './layout.js';

/**
 * Gerenciador de anúncios: TODOS os anúncios de TODAS as contas em uma tabela, com status, data de publicação, resultado, gasto, CPC e
 * cliques no link, CTR, ativar/pausar, colunas que se movem (arrastando ou pelos botões), filtros (o período começa em HOJE) e
 * visualizações salvas por pessoa. O período vai ao servidor; busca, situação, conta e ordenação são feitos aqui (instantâneo).
 * Todo texto (nomes de anúncio, campanhas, mensagens do TikTok) entra como nó de texto, nunca como HTML.
 */

const STATUS_LABELS = { '': 'Todas as situações', active: 'Ativos', paused: 'Pausados', delivering: 'Em veiculação', problem: 'Com problema' };
const money = (value, currency) => (value === null || value === undefined ? '—' : formatCurrency(value, currency));
const num = (value) => (value === null || value === undefined ? '—' : formatNumber(Math.round(value * 100) / 100));
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const canChange = () => can('campaigns');
const isNumeric = (col) => ['money', 'number', 'percent'].includes(col.type);

export async function managerView() {
  const defaults = defaultViewConfig();
  const st = {
    config: structuredClone(defaults), // visualização em uso (colunas, ordem, ordenação, filtros, período, tamanho da página)
    views: [], currentViewId: null, baseConfig: JSON.stringify(defaults), // a visualização salva escolhida e como ela estava ao ser carregada
    custom: { from: '', to: '' }, search: '', page: 1, selected: new Set(),
    data: null, loading: false, error: null,
  };
  const root = h('div', { class: 'manager' });
  let loadId = 0;

  // ---------- dados ----------
  async function load({ fresh = false } = {}) {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    drawBody();
    try {
      const params = new URLSearchParams({ preset: st.config.datePreset });
      if (st.config.datePreset === 'custom') {
        params.set('from', st.custom.from);
        params.set('to', st.custom.to);
      }
      if (fresh) params.set('refresh', '1');
      const data = await get(`/tiktok/manager/ads?${params}`);
      if (current !== loadId) return false;
      st.data = data;
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
  const statusOf = (ad) => adStatusInfo(ad.status);
  function visibleAds() {
    if (!st.data) return [];
    const { status, accountId, onlySpent } = st.config.filters;
    const q = normalize(st.search);
    return st.data.ads.filter((a) => {
      if (accountId && a.advertiserId !== accountId) return false;
      if (onlySpent && !(a.spend > 0)) return false;
      if (status === 'active' && a.operationStatus !== 'ENABLE') return false;
      if (status === 'paused' && a.operationStatus !== 'DISABLE') return false;
      if (status === 'delivering' && a.status !== 'AD_STATUS_DELIVERY_OK') return false;
      if (status === 'problem' && !isAdProblem(a.status)) return false;
      if (q && !normalize(`${a.name} ${a.adId} ${a.campaignName} ${a.adgroupName} ${a.accountName}`).includes(q)) return false;
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
      default: return ad[key] ?? null;
    }
  };
  function sorted(list) {
    const { key, dir } = st.config.sort;
    const sign = dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // vazios sempre no fim
      if (y === null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.adId.localeCompare(b.adId);
    });
  }

  // ---------- ativar / pausar ----------
  function announce(results, status) {
    const updated = results.reduce((n, r) => n + r.updated.length, 0);
    const failed = results.reduce((n, r) => n + r.failed.length, 0);
    const failure = results.find((r) => r.failure)?.failure;
    if (failed) return toast(`${updated} alterado(s); ${failed} não mudaram${failure ? `: ${failure}` : '.'}`, 'danger');
    const on = status === 'ENABLE';
    if (updated === 1) return toast(on ? 'Anúncio ativado.' : 'Anúncio pausado.');
    return toast(`${updated} anúncios ${on ? 'ativados' : 'pausados'}.`);
  }

  /** Ativa/pausa anúncios de UMA conta. `silent`: quem chama junta os avisos (ação em massa). Sempre devolve { updated, failed, failure }. */
  async function changeStatus(advertiserId, ads, status, { silent = false } = {}) {
    const ids = ads.map((a) => a.adId);
    const before = new Map(ads.map((a) => [a.adId, { op: a.operationStatus, status: a.status }]));
    const restore = (list) => { for (const a of list) Object.assign(a, { operationStatus: before.get(a.adId).op, status: before.get(a.adId).status }); };
    for (const a of ads) { // otimista: o interruptor responde na hora; volta se der erro
      a.operationStatus = status === 'ENABLE' ? 'ENABLE' : 'DISABLE';
      a.status = status === 'ENABLE' ? 'AD_STATUS_DELIVERY_OK' : 'AD_STATUS_DISABLE';
    }
    drawBody();
    let result;
    try {
      result = await post('/tiktok/manager/ads/status', { advertiserId, adIds: ids, status });
      const done = new Set(result.updated);
      restore(ads.filter((a) => !done.has(a.adId)));
    } catch (err) {
      restore(ads);
      result = { updated: [], failed: ids, failure: err.message };
    }
    drawBody();
    if (!silent) {
      announce([result], status);
      refreshQuietly(); // o status exato (ex.: "em análise") vem do TikTok: busca de novo sem perder o que a pessoa está vendo
    }
    return result;
  }
  async function refreshQuietly() {
    try {
      const params = new URLSearchParams({ preset: st.config.datePreset, refresh: '1' });
      if (st.config.datePreset === 'custom') {
        params.set('from', st.custom.from);
        params.set('to', st.custom.to);
      }
      const data = await get(`/tiktok/manager/ads?${params}`);
      st.data = data;
      drawBody();
    } catch {
      /* mantém o que está na tela */
    }
  }

  async function bulk(status) {
    const ads = st.data.ads.filter((a) => st.selected.has(a.key) && a.operationStatus !== 'FROZEN');
    if (!ads.length) return toast('Nenhum anúncio selecionável (anúncios encerrados não podem ser ativados).', 'danger');
    const ok = await confirmDialog({
      title: status === 'ENABLE' ? `Ativar ${ads.length} anúncio(s)?` : `Pausar ${ads.length} anúncio(s)?`,
      message: status === 'ENABLE' ? 'Os anúncios selecionados voltam a veicular e a gastar.' : 'Os anúncios selecionados deixam de veicular.',
      confirmLabel: status === 'ENABLE' ? 'Ativar' : 'Pausar',
      danger: status !== 'ENABLE',
    });
    if (!ok) return undefined;
    const byAccount = new Map();
    for (const a of ads) byAccount.set(a.advertiserId, [...(byAccount.get(a.advertiserId) ?? []), a]);
    st.selected.clear();
    const results = await Promise.all([...byAccount.entries()].map(([advertiserId, list]) => changeStatus(advertiserId, list, status, { silent: true })));
    announce(results, status);
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
      await load();
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
    if (st.config.datePreset !== presetBefore) load();
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
      setChildren(
        list,
        st.config.columns.map((c, i) => {
          const def = columnOf(c.key);
          const locked = c.key === 'name';
          return h(
            'li',
            { class: 'manager-cols__item' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.visible, disabled: locked, onChange: (e) => { c.visible = e.target.checked; drawToolbar(); drawBody(); } }), h('span', null, def.label, locked ? ' (sempre visível)' : '')),
            h('span', { class: 'manager-cols__move' },
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Mover ${def.label} para cima`, disabled: i === 0, onClick: () => { moveColumn(c.key, st.config.columns[i - 1].key); paint(); } }, '↑'),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Mover ${def.label} para baixo`, disabled: i === st.config.columns.length - 1, onClick: () => { moveColumn(c.key, st.config.columns[i + 1].key); paint(); } }, '↓')),
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

  // ---------- desenho: barra de ferramentas ----------
  const toolbar = h('div', { class: 'manager__toolbar' });
  function drawToolbar() {
    const view = currentView();
    const viewSelect = h('select', { class: 'input input--filter', 'aria-label': 'Visualização', onChange: (e) => chooseView(e.target.value) },
      h('option', { value: '' }, 'Visualização padrão do sistema'),
      st.views.map((v) => h('option', { value: String(v.id) }, `${v.isDefault ? '★ ' : ''}${v.name}`)));
    viewSelect.value = st.currentViewId === null ? '' : String(st.currentViewId);
    const dirty = isDirty();

    const preset = h('select', { class: 'input input--filter', 'aria-label': 'Período', onChange: (e) => { st.config.datePreset = e.target.value; drawToolbar(); if (e.target.value !== 'custom') load(); } },
      DATE_PRESETS.map((p) => h('option', { value: p.id }, p.label)), h('option', { value: 'custom' }, 'Personalizado…'));
    preset.value = st.config.datePreset;
    const customBox = st.config.datePreset === 'custom'
      ? h('span', { class: 'manager__custom' },
        h('input', { class: 'input', type: 'date', 'aria-label': 'Data inicial', value: st.custom.from, onChange: (e) => { st.custom.from = e.target.value; } }),
        h('span', { class: 'muted' }, 'até'),
        h('input', { class: 'input', type: 'date', 'aria-label': 'Data final', value: st.custom.to, onChange: (e) => { st.custom.to = e.target.value; } }),
        button('Aplicar', { small: true, variant: 'primary', onClick: () => {
          if (!st.custom.from || !st.custom.to || st.custom.from > st.custom.to) return toast('Informe as duas datas (a inicial não pode ser depois da final).', 'danger');
          return load();
        } }),
        h('span', { class: 'muted manager__hint' }, `até ${MAX_CUSTOM_DAYS} dias`))
      : null;

    const accounts = st.data?.accounts ?? [];
    const accountSelect = h('select', { class: 'input input--filter', 'aria-label': 'Conta de anúncio', onChange: (e) => { st.config.filters.accountId = e.target.value; st.page = 1; drawToolbar(); drawBody(); } },
      h('option', { value: '' }, `Todas as contas${accounts.length ? ` (${accounts.length})` : ''}`),
      accounts.map((a) => h('option', { value: a.id }, `${a.name}${a.status === 'error' ? ' · erro' : ''}`)));
    accountSelect.value = st.config.filters.accountId;
    const statusSelect = h('select', { class: 'input input--filter', 'aria-label': 'Situação', onChange: (e) => { st.config.filters.status = e.target.value; st.page = 1; drawToolbar(); drawBody(); } },
      STATUS_FILTERS.map((v) => h('option', { value: v }, STATUS_LABELS[v])));
    statusSelect.value = st.config.filters.status;
    const search = h('input', { class: 'input toolbar__search', type: 'search', maxlength: 100, placeholder: 'Buscar anúncio, campanha, grupo, conta ou ID…', 'aria-label': 'Buscar anúncios', value: st.search,
      onInput: (e) => { st.search = e.target.value; st.page = 1; drawBody(); } });

    setChildren(
      toolbar,
      h('div', { class: 'manager__row' },
        h('div', { class: 'manager__views' }, h('span', { class: 'field__label' }, 'Visualização'), viewSelect,
          dirty ? badge('alterada', 'warning') : null,
          button(view ? 'Salvar alterações' : 'Salvar visualização', { small: true, variant: dirty || !view ? 'primary' : 'secondary', onClick: saveChanges }),
          view ? button('Salvar como nova…', { small: true, onClick: saveAsNew }) : null,
          view ? button(view.isDefault ? '★ Padrão' : '☆ Tornar padrão', { small: true, onClick: toggleDefault }) : null,
          view ? button('Excluir', { small: true, variant: 'danger-ghost', onClick: removeView }) : null),
        h('div', { class: 'manager__actions' }, button('Colunas', { small: true, onClick: columnsDialog }), button('Atualizar', { small: true, onClick: async (e) => { const t = e.currentTarget; t.disabled = true; if (await load({ fresh: true })) toast('Anúncios atualizados.'); } }))),
      h('div', { class: 'manager__row manager__filters' }, preset, customBox, accountSelect, statusSelect,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.config.filters.onlySpent, onChange: (e) => { st.config.filters.onlySpent = e.target.checked; st.page = 1; drawToolbar(); drawBody(); } }), h('span', null, 'Só com gasto no período')),
        search),
    );
  }

  // ---------- desenho: tabela ----------
  const body = h('div', { class: 'manager__body' });

  function cell(col, ad) {
    switch (col.key) {
      case 'name': return h('td', { class: 'manager__name', 'data-label': col.label }, h('span', { class: 'cell-strong manager__ad', title: ad.name }, ad.name || ad.adId), h('span', { class: 'acc-id' }, `ID ${ad.adId} · ${ad.campaignName || 'sem campanha'}`));
      case 'status': { const info = statusOf(ad); return h('td', { 'data-label': col.label }, badge(info.label, info.tone)); }
      case 'toggle': {
        const on = ad.operationStatus === 'ENABLE';
        const locked = ad.operationStatus === 'FROZEN' || !canChange();
        const sw = h('button', {
          type: 'button', class: `switch-ad${on ? ' is-on' : ''}`, role: 'switch', 'aria-checked': String(on), disabled: locked,
          'aria-label': `${on ? 'Pausar' : 'Ativar'} ${ad.name}`,
          title: ad.operationStatus === 'FROZEN' ? 'Anúncio encerrado: não pode ser ativado' : !canChange() ? 'Sem permissão para ativar/pausar' : on ? 'Clique para pausar' : 'Clique para ativar',
          onClick: () => changeStatus(ad.advertiserId, [ad], on ? 'DISABLE' : 'ENABLE'),
        }, h('span', { class: 'switch-ad__thumb' }));
        return h('td', { 'data-label': col.label }, sw);
      }
      case 'createdAt': return h('td', { class: 'muted manager__date', 'data-label': col.label }, ad.createdAt ? formatDate(ad.createdAt) : '—');
      case 'modifiedAt': return h('td', { class: 'muted manager__date', 'data-label': col.label }, ad.modifiedAt ? formatDate(ad.modifiedAt) : '—');
      case 'account': return h('td', { 'data-label': col.label }, ad.accountName);
      case 'campaign': return h('td', { 'data-label': col.label }, ad.campaignName || '—');
      case 'adgroup': return h('td', { 'data-label': col.label }, ad.adgroupName || '—');
      case 'spend': return h('td', { class: 'num', 'data-label': col.label }, money(ad.hasMetrics ? ad.spend : null, ad.currency));
      case 'cpc': case 'costPerResult': case 'costPerConversion': return h('td', { class: 'num', 'data-label': col.label }, money(ad.hasMetrics ? ad[col.key] : null, ad.currency));
      case 'ctr': return h('td', { class: 'num', 'data-label': col.label }, ad.hasMetrics ? formatPercent(ad.ctr) : '—');
      default: return h('td', { class: 'num', 'data-label': col.label }, ad.hasMetrics ? num(ad[col.key]) : '—'); // result, clicks, impressions, conversions
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
      return h('tr', { class: 'manager__total' }, h('td', null), columns.map((c) => h('td', { class: isNumeric(c) ? 'num' : '', 'data-label': c.label }, c.key === 'name' ? `Total${byCurrency.size > 1 ? ` (${t.currency ?? '—'})` : ''}` : (values[c.key] ?? ''))));
    });
  }

  function drawBody() {
    if (st.loading) {
      const n = st.data?.totalAccounts;
      return setChildren(body, h('div', { class: 'card manager__loading' }, spinner(), h('p', { class: 'muted' }, `Buscando os anúncios${n ? ` de ${n} contas` : ' de todas as contas'} no TikTok… isso pode levar alguns segundos.`)));
    }
    if (st.error) return setChildren(body, alertBox(st.error), h('p', null, button('Tentar de novo', { onClick: () => load() })));
    if (!st.data) return setChildren(body, spinner());
    if (!st.data.totalAccounts) {
      return setChildren(body, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Conecte uma Business Center para ver e gerenciar os anúncios de todas as suas contas aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
    }
    const list = sorted(visibleAds());
    const columns = st.config.columns.filter((c) => c.visible).map((c) => columnOf(c.key));
    const pageSize = st.config.pageSize;
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    st.page = Math.min(st.page, pages);
    const pageRows = list.slice((st.page - 1) * pageSize, st.page * pageSize);

    const failed = st.data.accounts.filter((a) => a.status === 'error');
    const noMetrics = st.data.accounts.filter((a) => a.status === 'ok' && a.metricsError);
    const notices = [
      failed.length ? alertBox(`${failed.length} conta(s) não carregaram os anúncios: ${failed.slice(0, 3).map((a) => `${a.name} (${a.error})`).join(' · ')}${failed.length > 3 ? '…' : ''}`, 'warning') : null,
      noMetrics.length ? alertBox(`Sem o desempenho de ${noMetrics.length} conta(s) (os anúncios aparecem sem números): ${noMetrics[0].metricsError}`, 'warning') : null,
      st.data.truncated ? alertBox('Há mais anúncios do que o limite exibido. Use os filtros ou o período para refinar.', 'warning') : null,
    ];

    const selectedHere = pageRows.filter((a) => st.selected.has(a.key));
    const headCheck = h('input', { type: 'checkbox', 'aria-label': 'Selecionar todos desta página', checked: pageRows.length > 0 && selectedHere.length === pageRows.length, onChange: (e) => { for (const a of pageRows) { if (e.target.checked) st.selected.add(a.key); else st.selected.delete(a.key); } drawBody(); } });

    const dragState = { key: null };
    const heads = columns.map((c) => {
      const sortedBy = st.config.sort.key === c.key;
      const th = h('th', { scope: 'col', class: `manager__th${isNumeric(c) ? ' num' : ''}`, draggable: 'true', 'aria-sort': sortedBy ? (st.config.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none', title: 'Arraste para mover a coluna' },
        h('button', { type: 'button', class: 'th-sort', disabled: !c.sortable, onClick: () => { st.config.sort = { key: c.key, dir: sortedBy && st.config.sort.dir === 'desc' ? 'asc' : 'desc' }; st.page = 1; drawToolbar(); drawBody(); } }, c.label, sortedBy ? (st.config.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''));
      th.addEventListener('dragstart', (e) => { dragState.key = c.key; e.dataTransfer.setData('application/x-manager-col', c.key); e.dataTransfer.effectAllowed = 'move'; th.classList.add('is-dragging'); });
      th.addEventListener('dragend', () => th.classList.remove('is-dragging'));
      th.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-manager-col')) { e.preventDefault(); th.classList.add('is-drop'); } });
      th.addEventListener('dragleave', () => th.classList.remove('is-drop'));
      th.addEventListener('drop', (e) => { e.preventDefault(); th.classList.remove('is-drop'); const from = e.dataTransfer.getData('application/x-manager-col'); if (from && from !== c.key) moveColumn(from, c.key); });
      return th;
    });

    const bulkBar = st.selected.size
      ? h('div', { class: 'selection-bar', role: 'region', 'aria-label': 'Anúncios selecionados' },
        h('strong', null, `${st.selected.size} ${st.selected.size === 1 ? 'selecionado' : 'selecionados'}`),
        canChange() ? button('Ativar', { small: true, variant: 'primary', onClick: () => bulk('ENABLE') }) : null,
        canChange() ? button('Pausar', { small: true, onClick: () => bulk('DISABLE') }) : null,
        button('Limpar seleção', { small: true, onClick: () => { st.selected.clear(); drawBody(); } }))
      : null;

    const range = st.data.accounts.find((a) => a.status === 'ok');
    const rangeText = range ? (range.from === range.to ? `Dados de ${range.from.split('-').reverse().join('/')}` : `Dados de ${range.from.split('-').reverse().join('/')} a ${range.to.split('-').reverse().join('/')}`) : '';
    const summary = h('p', { class: 'muted manager__summary', 'aria-live': 'polite' }, `${list.length} ${list.length === 1 ? 'anúncio' : 'anúncios'}${list.length !== st.data.ads.length ? ` de ${st.data.ads.length}` : ''} · ${st.data.accounts.length} contas · ${rangeText}${st.config.datePreset === 'today' ? ' (hoje, no fuso de cada conta)' : ''} · atualizado às ${new Date(st.data.fetchedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);

    const pager = pages > 1
      ? h('div', { class: 'manager__pager' },
        button('‹ Anterior', { small: true, disabled: st.page <= 1, onClick: () => { st.page -= 1; drawBody(); } }),
        h('span', { class: 'muted' }, `Página ${st.page} de ${pages}`),
        button('Próxima ›', { small: true, disabled: st.page >= pages, onClick: () => { st.page += 1; drawBody(); } }))
      : null;
    const sizeSelect = h('select', { class: 'input input--filter manager__size', 'aria-label': 'Anúncios por página', onChange: (e) => { st.config.pageSize = Number(e.target.value); st.page = 1; drawToolbar(); drawBody(); } }, [50, 100, 200].map((n) => h('option', { value: String(n) }, `${n} por página`)));
    sizeSelect.value = String(pageSize);

    setChildren(
      body,
      ...notices,
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
        : h('div', { class: 'card' }, emptyState({ title: st.data.ads.length ? 'Nenhum anúncio com esses filtros' : 'Nenhum anúncio nas suas contas', text: st.data.ads.length ? 'Mude o período, a situação ou a busca.' : 'Quando você publicar campanhas, os anúncios aparecem aqui.' })),
      h('div', { class: 'manager__footer' }, sizeSelect, pager),
    );
    return undefined;
  }

  setChildren(root, pageHeader('Gerenciador', 'Todos os anúncios de todas as suas contas em uma tabela: veja o desempenho, ative ou pause e salve o seu formato de visualização.'), toolbar, body);
  drawBody();
  await loadViews();
  drawToolbar();
  load(); // não bloqueia a abertura da tela: mostra "carregando" enquanto o TikTok responde
  return { element: root, cleanup: () => { loadId += 1; } };
}
