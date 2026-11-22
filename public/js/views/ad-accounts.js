import { get } from '../api.js';
import { h } from '../dom.js';
import { alertBox, badge, emptyState } from '../ui.js';
import { hubLayout, plural } from './hub.js';

const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Sub-aba "Contas de anúncio": todas as contas que o usuário pode usar e de qual Business Center (conexão) cada uma vem.
 * Mostra só as contas das BCs do próprio usuário e das compartilhadas com a equipe (mesma regra do resto do sistema).
 */
export async function adAccountsView() {
  const { advertisers } = await get('/tiktok/advertisers');
  const state = { q: '', bc: '' };

  const centers = [...new Map(advertisers.map((a) => [a.businessCenterId, a.businessCenterName])).entries()].sort((x, y) => x[1].localeCompare(y[1], 'pt-BR'));

  const summary = h('p', { 'aria-live': 'polite' });
  const body = h('div');

  const search = h('input', { class: 'input toolbar__search', type: 'search', placeholder: 'Buscar por nome ou ID da conta…', 'aria-label': 'Buscar contas de anúncio', maxlength: 100 });
  const filter = h('select', { class: 'input', 'aria-label': 'Filtrar por Business Center' }, h('option', { value: '' }, 'Todas as Business Centers'), centers.map(([id, name]) => h('option', { value: String(id) }, name)));
  search.addEventListener('input', () => { state.q = normalize(search.value.trim()); draw(); });
  filter.addEventListener('change', () => { state.bc = filter.value; draw(); });

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

  function draw() {
    const rows = advertisers.filter((a) => (!state.bc || String(a.businessCenterId) === state.bc) && (!state.q || normalize(`${a.name} ${a.id}`).includes(state.q)));
    const bcCount = new Set(rows.map((a) => a.businessCenterId)).size;
    summary.textContent = `${plural(rows.length, 'conta de anúncio', 'contas de anúncio')} em ${plural(bcCount, 'Business Center', 'Business Centers')}` + (rows.length !== advertisers.length ? ` (de ${advertisers.length} no total)` : '');

    if (!rows.length) {
      body.replaceChildren(h('div', { class: 'card' }, emptyState({ title: 'Nenhuma conta encontrada', text: 'Ajuste a busca ou o filtro de Business Center.' })));
      return;
    }
    body.replaceChildren(
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Conta de anúncio', 'ID da conta', 'Business Center', 'Moeda', 'Fuso horário', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            rows.map((a) =>
              h(
                'tr',
                null,
                h('td', { class: 'cell-strong', 'data-label': 'Conta' }, a.name),
                h('td', { 'data-label': 'ID da conta' }, h('span', { class: 'code' }, a.id)),
                h('td', { 'data-label': 'Business Center' }, origin(a)),
                h('td', { 'data-label': 'Moeda' }, a.currency ?? '—'),
                h('td', { class: 'muted', 'data-label': 'Fuso horário' }, a.timezone ?? '—'),
                h('td', { 'data-label': 'Status' }, a.businessCenterStatus === 'active' ? badge('Ativa', 'success') : badge('Acesso com erro', 'danger')),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const subtitle = 'Todas as contas de anúncio disponíveis para você e a Business Center de cada uma.';
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
      actions: [search, filter],
      children: [body, advertisers.some((a) => a.businessCenterStatus !== 'active') ? alertBox('Algumas Business Centers estão com erro de acesso. Reautorize ou atualize o token na aba “Business Centers”.', 'warning') : null],
    }),
  };
}
