import { ACTION_GROUPS, ACTIVITY_RANGES, describeEntry } from '/shared/activity.js';
import { get } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, button, emptyState, field, spinner } from '../ui.js';
import { avatarEl } from './avatar.js';

const timeOf = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso da pessoa: serve para agrupar por dia
const sameDay = (a, b) => dayKey(a) === dayKey(b);

/** "Hoje", "Ontem" ou "quinta-feira, 26/11/2026". */
function dayLabel(iso, now = new Date()) {
  if (sameDay(iso, now.toISOString())) return 'Hoje';
  if (sameDay(iso, new Date(now.getTime() - 86_400_000).toISOString())) return 'Ontem';
  return new Date(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias" (até 30 dias; depois a data). */
export function ago(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

/** O que o dono mais quer medir, por pessoa (soma das ações do período). */
const HIGHLIGHTS = [
  ['Campanhas publicadas', ['campaign.publish']],
  ['Ativações e pausas', ['manager.status']],
  ['Criativos enviados', ['creative.upload', 'creative.tiktok_ref']],
  ['Contas adicionadas', ['bc.connect', 'advertiser.create']],
];
const sumOf = (counts, keys) => keys.reduce((total, key) => total + (counts[key] ?? 0), 0);

/**
 * Aba "Atividade" dos colaboradores: resumo do trabalho de cada pessoa no período e a linha do tempo de tudo o que foi feito
 * (quem, o quê, com qual link/criativo/catálogo/conta e a que horas). Só o dono acessa (o servidor também exige).
 * `members`: a equipe atual (para o filtro por pessoa e as fotos). Todo texto entra como nó de texto.
 */
export function createActivityPanel({ members, owner }) {
  const element = h('div', { class: 'activity' });
  const query = { range: '7', actor: '', group: '' };
  const state = { summary: null, entries: [], total: 0, page: 0, totalPages: 0, loading: true, error: null };
  let ticket = 0; // só a resposta do último pedido vale (trocar filtro rápido não mistura resultados)
  const avatarOf = new Map(members.map((m) => [m.userId, m.avatarVersion ?? null]));

  const people = [{ userId: owner.id, name: 'Você', avatarVersion: owner.avatarVersion ?? null }, ...members.map((m) => ({ userId: m.userId, name: m.name, avatarVersion: m.avatarVersion ?? null }))];
  const person = (name, userId) => avatarEl({ id: userId, name, avatarVersion: userId ? avatarOf.get(userId) ?? null : null }, { size: 'md' });

  const rangeField = field('Período', { as: 'select', options: ACTIVITY_RANGES.map(([days, text]) => [String(days), text]), value: query.range });
  const actorField = field('Pessoa', { as: 'select', options: [['', 'Todas as pessoas'], ...people.map((p) => [String(p.userId), p.name])], value: query.actor });
  const groupField = field('Tipo de ação', { as: 'select', options: [['', 'Todas as ações'], ...ACTION_GROUPS], value: query.group });
  const onFilter = () => {
    query.range = rangeField.control.value;
    query.actor = actorField.control.value;
    query.group = groupField.control.value;
    load();
  };
  [rangeField, actorField, groupField].forEach((f) => f.control.addEventListener('change', onFilter));

  const params = (extra = {}) => new URLSearchParams(Object.entries({ ...query, ...extra }).filter(([, v]) => v !== '')).toString();

  /** Busca o resumo (só quando o período muda) e a primeira página do registro; `more` traz a próxima página. */
  async function load({ more = false } = {}) {
    const mine = ++ticket;
    if (!more) {
      state.loading = true;
      state.error = null;
      draw();
    }
    try {
      const nextPage = more ? state.page + 1 : 1;
      const [feed, summary] = await Promise.all([
        get(`/team/activity?${params({ page: String(nextPage) })}`),
        more ? Promise.resolve(state.summary) : get(`/team/activity/summary?range=${query.range}`),
      ]);
      if (mine !== ticket) return;
      state.summary = summary;
      state.entries = more ? [...state.entries, ...feed.entries] : feed.entries;
      state.total = feed.total;
      state.page = feed.page;
      state.totalPages = feed.totalPages;
      state.error = null;
    } catch (err) {
      if (mine !== ticket) return;
      state.error = err.message;
    }
    state.loading = false;
    draw();
  }

  // ---------- resumo por pessoa ----------
  function summaryCards() {
    const list = state.summary?.people ?? [];
    if (!list.length) return null;
    return h('div', { class: 'activity__people', role: 'group', 'aria-label': 'Resumo do trabalho de cada pessoa' }, list.map((p) => {
      const selectable = p.actorId !== null;
      const selected = selectable && String(p.actorId) === query.actor;
      const label = p.actorId === owner.id ? 'Você' : p.name;
      const card = h(
        selectable ? 'button' : 'div',
        { ...(selectable ? { type: 'button', 'aria-pressed': String(selected), title: selected ? 'Mostrar todas as pessoas' : `Ver só o que ${label} fez` } : {}), class: `activity__person${selected ? ' is-selected' : ''}` },
        h('div', { class: 'activity__person-head' }, person(p.name, p.actorId), h('div', { class: 'activity__person-name' }, h('strong', null, label), h('span', { class: 'hub-meta' }, p.removed ? 'Removido(a) da equipe' : `Última ação ${ago(p.lastAt)}`))),
        h('div', { class: 'activity__total' }, h('strong', null, String(p.total)), h('span', null, p.total === 1 ? 'ação no período' : 'ações no período')),
        h('ul', { class: 'activity__stats' }, HIGHLIGHTS.map(([text, keys]) => h('li', null, h('strong', null, String(sumOf(p.counts, keys))), h('span', null, text)))),
      );
      if (selectable) {
        card.addEventListener('click', () => {
          query.actor = selected ? '' : String(p.actorId);
          actorField.control.value = query.actor;
          load();
        });
      }
      return card;
    }));
  }

  // ---------- linha do tempo ----------
  function entryRow(entry) {
    const view = describeEntry(entry);
    const name = entry.actorId === owner.id ? 'Você' : entry.actorName;
    return h(
      'li',
      { class: 'activity__entry' },
      person(entry.actorName, entry.actorId),
      h(
        'div',
        { class: 'activity__body' },
        h('p', { class: 'activity__what' }, h('strong', null, name), ' · ', view.title, view.target ? h('span', { class: 'activity__target' }, ` “${view.target}”`) : null),
        view.lines.length ? h('dl', { class: 'activity__lines' }, view.lines.map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, value)))) : null,
        view.groupLabel ? h('span', { class: 'badge badge--neutral activity__tag' }, view.groupLabel) : null,
      ),
      h('time', { class: 'activity__time', dateTime: entry.createdAt, title: new Date(entry.createdAt).toLocaleString('pt-BR') }, timeOf(entry.createdAt)),
    );
  }

  function timeline() {
    if (!state.entries.length) {
      return h('div', { class: 'card' }, emptyState({
        title: 'Nada registrado neste filtro',
        text: 'Quando alguém da equipe publicar, ativar, pausar ou mexer em criativos, catálogos e contas, aparece aqui com o horário. Tente um período maior.',
      }));
    }
    const groups = [];
    for (const entry of state.entries) {
      const last = groups.at(-1);
      if (last && sameDay(last.at, entry.createdAt)) last.items.push(entry);
      else groups.push({ at: entry.createdAt, items: [entry] });
    }
    const more = state.page < state.totalPages;
    return h(
      'div',
      { class: 'card activity__feed' },
      h('p', { class: 'activity__count hub-meta' }, `${state.total} ${state.total === 1 ? 'registro' : 'registros'} no período`),
      groups.map((g) => h('section', { class: 'activity__day' }, h('h3', { class: 'activity__day-title' }, dayLabel(g.at)), h('ol', { class: 'activity__list' }, g.items.map(entryRow)))),
      more ? h('div', { class: 'activity__more' }, button('Carregar mais', { onClick: () => load({ more: true }) })) : null,
    );
  }

  function draw() {
    const filters = h('div', { class: 'activity__filters' }, rangeField.element, actorField.element, groupField.element, button('Atualizar', { small: true, onClick: () => load() }));
    if (state.loading) return setChildren(element, filters, spinner('Carregando a atividade…'));
    if (state.error) return setChildren(element, filters, alertBox(state.error), button('Tentar de novo', { small: true, onClick: () => load() }));
    return setChildren(
      element,
      filters,
      summaryCards(),
      timeline(),
    );
  }

  return { element, load: () => load() };
}
