import { ACCOUNT_LABELS, MAX_LABEL_BATCH, countByKind, isAccountLabel } from '/shared/account-labels.js';
import { get, patch } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, badge, button, emptyState, toast } from '../ui.js';
import { createAccountFilter, currencyBadge, labelBadge } from './account-filter.js';
import { hubLayout, plural } from './hub.js';

const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const rowKey = (a) => `${a.businessCenterId}:${a.id}`; // a mesma conta pode aparecer em duas Business Centers

/**
 * Sub-aba "Contas de anúncio": todas as contas que o usuário pode usar e de qual Business Center (conexão) cada uma vem.
 * Mostra só as contas das BCs do próprio usuário e das compartilhadas com a equipe (mesma regra do resto do sistema).
 * Cada conta pode receber uma etiqueta (ex.: "Conta de agência"): ela aparece na publicação de campanhas e vale como filtro.
 */
export async function adAccountsView() {
  const { advertisers } = await get('/tiktok/advertisers');
  const state = { q: '', bc: '' };
  const selected = new Set(); // rowKey das contas marcadas para etiquetar em lote
  let busy = false;

  const centers = [...new Map(advertisers.map((a) => [a.businessCenterId, a.businessCenterName])).entries()].sort((x, y) => x[1].localeCompare(y[1], 'pt-BR'));

  const summary = h('p', { 'aria-live': 'polite' });
  const body = h('div');
  const bulkCount = h('span', { class: 'acc-bulk__count', 'aria-live': 'polite' });
  const bulkButtons = h('div', { class: 'hub__actions' });
  const bulkBar = h('div', { class: 'acc-bulk', hidden: true, role: 'region', 'aria-label': 'Etiquetar contas selecionadas' }, bulkCount, bulkButtons);
  const filter = createAccountFilter({ onChange: () => draw(), accounts: advertisers });
  let visibleRows = [];
  const checkboxes = new Map(); // rowKey -> input (atualizados no lugar, sem redesenhar a tabela)
  let headCheckbox = null;

  const search = h('input', { class: 'input toolbar__search', type: 'search', placeholder: 'Buscar por nome ou ID da conta…', 'aria-label': 'Buscar contas de anúncio', maxlength: 100 });
  const bcFilter = h('select', { class: 'input', 'aria-label': 'Filtrar por Business Center' }, h('option', { value: '' }, 'Todas as Business Centers'), centers.map(([id, name]) => h('option', { value: String(id) }, name)));
  search.addEventListener('input', () => { state.q = normalize(search.value.trim()); draw(); });
  bcFilter.addEventListener('change', () => { state.bc = bcFilter.value; draw(); });

  const labelable = (a) => a.canLabel === true;

  /** Etiqueta (ou, com `value` nulo, remove a etiqueta de) contas; uma chamada por Business Center. */
  async function applyLabel(accounts, value) {
    if (busy || !accounts.length || (value !== null && !isAccountLabel(value))) return;
    busy = true;
    draw();
    const byCenter = new Map();
    for (const a of accounts) byCenter.set(a.businessCenterId, [...(byCenter.get(a.businessCenterId) ?? []), a]);
    let done = 0;
    try {
      for (const [centerId, list] of byCenter) {
        for (let i = 0; i < list.length; i += MAX_LABEL_BATCH) {
          const chunk = list.slice(i, i + MAX_LABEL_BATCH);
          await patch(`/tiktok/business-centers/${centerId}/advertisers`, { advertiserIds: chunk.map((a) => a.id), label: value });
          for (const a of chunk) a.label = value;
          done += chunk.length;
        }
      }
      toast(value ? `${plural(done, 'conta marcada', 'contas marcadas')} como ${ACCOUNT_LABELS[value].toLowerCase()}.` : `${plural(done, 'conta voltou', 'contas voltaram')} a ser comum.`);
      selected.clear();
    } catch (err) {
      toast(done ? `${plural(done, 'conta alterada', 'contas alteradas')} antes do erro: ${err.message}` : err.message, 'danger');
    } finally {
      busy = false;
      draw();
    }
  }

  /** Business Center de origem: nome e uma linha discreta (ID, tipo da conexão, visibilidade e proxy). */
  function origin(a) {
    const meta = [
      a.ownerBcId ?? a.businessCenterBcId ? `ID ${a.ownerBcId ?? a.businessCenterBcId}` : null, // a BC dona da conta (conexões por link não têm ID na conexão)
      a.businessCenterAuthType === 'oauth' ? 'Por link' : 'Token',
      a.businessCenterShared ? 'Compartilhada' : a.businessCenterOwned ? 'Só você' : 'Privada',
      a.businessCenterViaProxy ? 'Via proxy' : null,
    ].filter(Boolean);
    return h('div', null, h('span', { class: 'cell-strong' }, a.businessCenterName), h('span', { class: 'hub-meta' }, meta.join(' · ')));
  }

  /** Tipo da conta: quem pode etiquetar escolhe na hora (comum ou agência); os demais só veem o selo. */
  function kindCell(a) {
    if (!labelable(a)) return labelBadge(a) ?? h('span', { class: 'muted' }, 'Comum');
    const select = h(
      'select',
      { class: 'input acc-kind', 'aria-label': `Tipo da conta ${a.name}`, disabled: busy },
      h('option', { value: '' }, 'Conta comum'),
      Object.entries(ACCOUNT_LABELS).map(([value, text]) => h('option', { value }, text)),
    );
    select.value = a.label ?? '';
    select.addEventListener('change', () => applyLabel([a], select.value || null));
    return select;
  }

  /** Atualiza, no lugar, o que depende da seleção (barra de lote e caixa do cabeçalho), sem redesenhar a tabela. */
  function syncSelection() {
    const editable = visibleRows.filter(labelable);
    const picked = editable.filter((a) => selected.has(rowKey(a)));
    bulkBar.hidden = !picked.length;
    bulkCount.textContent = `${plural(picked.length, 'conta selecionada', 'contas selecionadas')}`;
    if (headCheckbox) {
      headCheckbox.checked = editable.length > 0 && picked.length === editable.length;
      headCheckbox.indeterminate = picked.length > 0 && picked.length < editable.length;
    }
    setChildren(bulkButtons, [
      button('Marcar como conta de agência', { small: true, variant: 'primary', disabled: busy, onClick: () => applyLabel(picked, 'agency') }),
      button('Marcar como conta comum', { small: true, disabled: busy, onClick: () => applyLabel(picked, null) }),
      button('Limpar seleção', { small: true, disabled: busy, onClick: () => { selected.clear(); checkboxes.forEach((box) => { box.checked = false; }); syncSelection(); } }),
    ]);
  }

  function selectCell(a) {
    if (!labelable(a)) return h('td', { class: 'acc-select', 'data-label': 'Selecionar' });
    const box = h('input', { type: 'checkbox', 'aria-label': `Selecionar ${a.name}`, checked: selected.has(rowKey(a)), disabled: busy });
    box.addEventListener('change', () => {
      if (box.checked) selected.add(rowKey(a));
      else selected.delete(rowKey(a));
      syncSelection();
    });
    checkboxes.set(rowKey(a), box);
    return h('td', { class: 'acc-select', 'data-label': 'Selecionar' }, box);
  }

  function draw() {
    const rows = advertisers.filter((a) => filter.matches(a) && (!state.bc || String(a.businessCenterId) === state.bc) && (!state.q || normalize(`${a.name} ${a.id}`).includes(state.q)));
    visibleRows = rows;
    checkboxes.clear();
    // O que não está mais na tela (filtro/busca) sai da seleção: a ação em lote só vale para o que o usuário está vendo.
    const visibleKeys = new Set(rows.map(rowKey));
    for (const key of [...selected]) if (!visibleKeys.has(key)) selected.delete(key);

    const bcCount = new Set(rows.map((a) => a.businessCenterId)).size;
    const kinds = countByKind(rows);
    summary.textContent =
      `${plural(rows.length, 'conta de anúncio', 'contas de anúncio')} em ${plural(bcCount, 'Business Center', 'Business Centers')}` +
      (kinds.agency ? ` · ${kinds.agency} de agência` : '') +
      (rows.length !== advertisers.length ? ` (de ${advertisers.length} no total)` : '');

    if (!rows.length) {
      headCheckbox = null;
      setChildren(body, h('div', { class: 'card' }, emptyState({
        title: 'Nenhuma conta encontrada',
        text: 'Ajuste a busca ou os filtros.',
        action: filter.isActive() ? button('Limpar filtros de tipo e situação', { onClick: () => filter.reset() }) : null,
      })));
      syncSelection();
      return;
    }
    const canEdit = rows.some(labelable);
    headCheckbox = canEdit
      ? h('input', {
          type: 'checkbox', 'aria-label': 'Selecionar todas as contas da lista', disabled: busy,
          onChange: (e) => {
            for (const a of rows.filter(labelable)) {
              if (e.target.checked) selected.add(rowKey(a));
              else selected.delete(rowKey(a));
              const box = checkboxes.get(rowKey(a));
              if (box) box.checked = e.target.checked;
            }
            syncSelection();
          },
        })
      : null;
    setChildren(
      body,
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { class: 'table table--stack' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col', class: 'acc-select' }, headCheckbox ?? h('span', { class: 'visually-hidden' }, 'Selecionar')),
              ['Conta de anúncio', 'Business Center', 'Tipo', 'Moeda', 'Fuso horário', 'Status'].map((t) => h('th', { scope: 'col' }, t)),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((a) =>
              h(
                'tr',
                null,
                selectCell(a),
                // O ID fica logo abaixo do nome, em UMA linha (não quebra), para a tabela ter uma coluna a menos sem perder o dado.
                h('td', { 'data-label': 'Conta' }, h('div', { class: 'acc-name' }, h('span', { class: 'cell-strong' }, a.name), h('span', { class: 'acc-id', title: 'ID da conta de anúncio' }, `ID ${a.id}`))),
                h('td', { 'data-label': 'Business Center' }, origin(a)),
                h('td', { 'data-label': 'Tipo' }, kindCell(a)),
                h('td', { 'data-label': 'Moeda' }, currencyBadge(a.currency) ?? h('span', { class: 'muted' }, '—')),
                h('td', { class: 'muted', 'data-label': 'Fuso horário' }, a.timezone ?? '—'),
                h('td', { 'data-label': 'Status' }, a.businessCenterStatus === 'active' ? badge('Ativa', 'success') : badge('Acesso com erro', 'danger')),
              ),
            ),
          ),
        ),
      ),
    );
    syncSelection();
  }

  const subtitle = 'Todas as contas de anúncio disponíveis para você, a Business Center de cada uma e o tipo (comum ou de agência).';
  if (!advertisers.length) {
    return {
      element: hubLayout({
        active: '/business-centers/accounts',
        subtitle,
        children: [
          h('div', { class: 'card' }, emptyState({
            title: 'Nenhuma conta de anúncio ainda',
            text: 'Conecte uma Business Center na aba “Business Centers”: as contas de anúncio dela aparecem aqui.',
            action: h('a', { class: 'btn btn--primary', href: '/business-centers', 'data-link': '' }, 'Ir para Business Centers'),
          })),
        ],
      }),
    };
  }
  draw();
  return {
    element: hubLayout({
      active: '/business-centers/accounts',
      subtitle,
      summary,
      filters: [search, bcFilter, ...filter.controls],
      children: [
        advertisers.some(labelable) ? h('p', { class: 'hub__note' }, 'Marque uma conta como “Conta de agência” para ela aparecer identificada (e filtrável) na hora de publicar campanhas.') : null,
        bulkBar,
        body,
        advertisers.some((a) => a.businessCenterStatus !== 'active') ? alertBox('Algumas Business Centers estão com erro de acesso. Reautorize ou atualize o token na aba “Business Centers”.', 'warning') : null,
      ],
    }),
  };
}
