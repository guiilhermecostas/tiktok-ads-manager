/**
 * Registro de atividades da equipe: quem fez o quê e quando dentro da plataforma. Regras puras, usadas pelo servidor (validar e guardar) e pela
 * tela (descrever em português). Só ações do catálogo abaixo são aceitas, e só os campos de detalhe da lista `DETAIL_FIELDS` são guardados:
 * nada que a pessoa digita vira "campo novo" e NUNCA entram tokens, senhas, e-mail de acesso nem textos longos.
 */

/** Grupos para filtrar e resumir (a ordem é a da tela). */
export const ACTION_GROUPS = Object.freeze([
  ['campaigns', 'Campanhas'],
  ['creatives', 'Criativos'],
  ['catalog', 'Catálogo'],
  ['accounts', 'Contas e BCs'],
  ['finance', 'Financeiro'],
  ['team', 'Equipe'],
  ['access', 'Acessos'],
]);
const GROUP_KEYS = ACTION_GROUPS.map(([key]) => key);

/** Cada ação: grupo e a frase que descreve (a tela completa com os detalhes). `manager.status` muda a frase conforme o detalhe. */
export const ACTIONS = Object.freeze({
  'campaign.create': { group: 'campaigns', label: 'Criou uma campanha' },
  'campaign.update': { group: 'campaigns', label: 'Editou uma campanha' },
  'campaign.delete': { group: 'campaigns', label: 'Excluiu uma campanha' },
  'campaign.publish': { group: 'campaigns', label: 'Publicou uma campanha' },
  'template.create': { group: 'campaigns', label: 'Criou uma configuração one-click' },
  'template.update': { group: 'campaigns', label: 'Alterou uma configuração one-click' },
  'template.delete': { group: 'campaigns', label: 'Apagou uma configuração one-click' },
  'template.launch': { group: 'campaigns', label: 'Publicou uma configuração one-click' },
  'manager.status': { group: 'campaigns', label: 'Ativou ou pausou no Gerenciador' },
  'creative.upload': { group: 'creatives', label: 'Enviou um criativo' },
  'creative.tiktok_ref': { group: 'creatives', label: 'Adicionou um criativo que já estava no TikTok' },
  'creative.update': { group: 'creatives', label: 'Alterou um criativo' },
  'creative.delete': { group: 'creatives', label: 'Excluiu criativos' },
  'creative.move': { group: 'creatives', label: 'Moveu criativos de pasta' },
  'folder.create': { group: 'creatives', label: 'Criou uma pasta de criativos' },
  'folder.rename': { group: 'creatives', label: 'Renomeou uma pasta de criativos' },
  'folder.delete': { group: 'creatives', label: 'Excluiu uma pasta de criativos' },
  'hook.create': { group: 'creatives', label: 'Pediu um hook com IA' },
  'hook.apply': { group: 'creatives', label: 'Juntou um hook a um vídeo' },
  'hook.delete': { group: 'creatives', label: 'Excluiu um hook' },
  'catalog.create': { group: 'catalog', label: 'Criou um catálogo' },
  'catalog.products': { group: 'catalog', label: 'Enviou produtos ao catálogo' },
  'catalog.set': { group: 'catalog', label: 'Criou um conjunto de produtos' },
  'catalog.feed_create': { group: 'catalog', label: 'Criou uma sincronização do catálogo' },
  'catalog.feed_status': { group: 'catalog', label: 'Ligou ou desligou uma sincronização' },
  'catalog.feed_delete': { group: 'catalog', label: 'Excluiu uma sincronização do catálogo' },
  'catalog.defaults_save': { group: 'catalog', label: 'Salvou o anúncio padrão do catálogo' },
  'catalog.defaults_remove': { group: 'catalog', label: 'Removeu o anúncio padrão do catálogo' },
  'bc.connect': { group: 'accounts', label: 'Conectou uma Business Center' },
  'bc.connect_link': { group: 'accounts', label: 'Gerou um link para conectar uma Business Center' },
  'bc.update': { group: 'accounts', label: 'Editou uma conexão' },
  'bc.sync': { group: 'accounts', label: 'Atualizou as contas de uma conexão' },
  'bc.remove': { group: 'accounts', label: 'Removeu uma conexão' },
  'advertiser.create': { group: 'accounts', label: 'Criou contas de anúncio' },
  'identity.create': { group: 'accounts', label: 'Criou uma identidade personalizada' },
  'pixel.link': { group: 'accounts', label: 'Vinculou ou desvinculou um pixel de contas de anúncio' },
  'proxy.create': { group: 'accounts', label: 'Cadastrou uma proxy' },
  'proxy.update': { group: 'accounts', label: 'Editou uma proxy' },
  'proxy.delete': { group: 'accounts', label: 'Removeu uma proxy' },
  'proxy.activate': { group: 'accounts', label: 'Ligou uma proxy' },
  'proxy.deactivate': { group: 'accounts', label: 'Desligou a proxy' },
  'file.upload': { group: 'accounts', label: 'Enviou um arquivo' },
  'file.delete': { group: 'accounts', label: 'Excluiu um arquivo' },
  'balance.transfer': { group: 'finance', label: 'Transferiu saldo' },
  'team.invite': { group: 'team', label: 'Convidou um colaborador' },
  'team.resend': { group: 'team', label: 'Reenviou um convite' },
  'team.cancel_invite': { group: 'team', label: 'Cancelou um convite' },
  'team.member_update': { group: 'team', label: 'Mudou o acesso de um colaborador' },
  'team.member_remove': { group: 'team', label: 'Removeu um colaborador' },
  'team.member_join': { group: 'team', label: 'Entrou para a equipe' },
  'session.login': { group: 'access', label: 'Entrou na plataforma' },
});
export const ACTION_KEYS = Object.freeze(Object.keys(ACTIONS));

/** Campos de detalhe aceitos (e como aparecem). Qualquer outro campo é descartado antes de guardar. */
export const DETAIL_FIELDS = Object.freeze({
  link: 'Link de destino',
  creatives: 'Criativos',
  catalog: 'Catálogo',
  account: 'Conta de anúncio',
  accounts: 'Contas de anúncio',
  objective: 'Objetivo',
  items: 'Itens',
  count: 'Quantidade',
  level: 'Nível',
  status: 'Situação',
  amount: 'Valor',
  direction: 'Sentido',
  folder: 'Pasta',
  file: 'Arquivo',
  connection: 'Conexão',
  bc: 'Business Center',
  email: 'E-mail do convidado',
  areas: 'Acessos liberados',
  change: 'O que mudou',
});
const FIELD_KEYS = Object.keys(DETAIL_FIELDS);

export const MAX_TEXT = 300;
export const MAX_LIST = 20;
export const MAX_DETAILS_BYTES = 4000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (value) => String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/**
 * Limpa os detalhes antes de guardar: só campos conhecidos; texto sem caracteres de controle e com até 300 caracteres; listas de até 20 textos;
 * números finitos. O que sobrar de estranho é descartado em silêncio (registrar uma ação nunca pode quebrar a ação).
 */
export function sanitizeDetails(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of FIELD_KEYS) {
    const value = raw[key];
    if (typeof value === 'string') {
      const text = clean(value);
      if (text) out[key] = text;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      const list = value.filter((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))).slice(0, MAX_LIST).map((v) => clean(v)).filter(Boolean);
      if (list.length) out[key] = list;
    }
  }
  return out;
}

/** Nome do alvo (campanha, criativo, pasta…): texto limpo de até 200 caracteres, ou null. */
export const cleanTarget = (value) => (typeof value === 'string' && clean(value) ? clean(value).slice(0, 200) : null);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LEVEL_NAME = { campaign: ['campanha', 'campanhas'], adgroup: ['grupo de anúncios', 'grupos de anúncios'], ad: ['anúncio', 'anúncios'] };
const DIRECTION = { RECHARGE: 'Da Business Center para a conta', REFUND: 'Da conta para a Business Center' };

/**
 * Uma entrada pronta para mostrar: `{ title, target, lines: [[rótulo, valor], …], group, groupLabel }`.
 * A frase muda com o detalhe quando faz sentido ("Ativou 3 anúncios" em vez de "Ativou ou pausou no Gerenciador").
 */
export function describeEntry(entry) {
  const meta = ACTIONS[entry.action];
  const details = entry.details ?? {};
  let title = meta?.label ?? 'Fez uma ação';
  if (entry.action === 'manager.status' && Number.isFinite(details.count)) {
    const [one, many] = LEVEL_NAME[details.level] ?? ['item', 'itens'];
    title = `${details.status === 'ENABLE' ? 'Ativou' : 'Pausou'} ${plural(details.count, one, many)}`;
  }
  const lines = [];
  for (const key of FIELD_KEYS) {
    if (details[key] === undefined || (entry.action === 'manager.status' && ['level', 'status', 'count'].includes(key))) continue;
    let value = details[key];
    if (key === 'direction') value = DIRECTION[value] ?? value;
    if (key === 'level') value = (LEVEL_NAME[value] ?? [value])[0];
    if (Array.isArray(value)) value = value.join(', ');
    lines.push([DETAIL_FIELDS[key], String(value)]);
  }
  return { title, target: entry.targetName ?? null, lines, group: meta?.group ?? null, groupLabel: ACTION_GROUPS.find(([key]) => key === meta?.group)?.[1] ?? null };
}

// ---------- consulta (filtros da tela) ----------
export const ACTIVITY_RANGES = Object.freeze([
  [1, 'Últimas 24 horas'],
  [7, 'Últimos 7 dias'],
  [30, 'Últimos 30 dias'],
  [90, 'Últimos 90 dias'],
  [365, 'Último ano'],
]);
const RANGE_DAYS = ACTIVITY_RANGES.map(([days]) => days);
export const ACTIVITY_PAGE_SIZE = 30;
export const MAX_ACTIVITY_PAGE = 200;
export const RETENTION_DAYS = 365; // o registro guarda um ano; o que for mais antigo é apagado

/**
 * Confere os filtros que chegam pela URL (tudo texto). `actor` é o ID da pessoa (número) ou "me" quando vazio; `group` um dos grupos;
 * `range` em dias; `page` a partir de 1. Retorna { value, errors }; valor repetido (lista) é recusado.
 */
export function normalizeActivityQuery(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const errors = [];
  const one = (v) => (typeof v === 'string' ? v : undefined);
  let actorId = null;
  if (q.actor !== undefined && q.actor !== '') {
    if (!/^\d{1,9}$/.test(one(q.actor) ?? '') || Number(q.actor) < 1) errors.push({ path: 'actor', message: 'Pessoa inválida.' });
    else actorId = Number(q.actor);
  }
  let group = null;
  if (q.group !== undefined && q.group !== '') {
    if (!GROUP_KEYS.includes(one(q.group))) errors.push({ path: 'group', message: 'Tipo de ação inválido.' });
    else group = q.group;
  }
  const range = q.range === undefined ? 7 : /^\d{1,3}$/.test(one(q.range) ?? '') ? Number(q.range) : NaN;
  if (!RANGE_DAYS.includes(range)) errors.push({ path: 'range', message: 'Período inválido.' });
  const page = q.page === undefined ? 1 : /^\d{1,3}$/.test(one(q.page) ?? '') ? Number(q.page) : NaN;
  if (!Number.isInteger(page) || page < 1 || page > MAX_ACTIVITY_PAGE) errors.push({ path: 'page', message: 'Página inválida.' });
  return errors.length ? { value: null, errors } : { value: { actorId, group, range, page }, errors: [] };
}

/** Ações (chaves) de um grupo: o servidor usa isto para filtrar por grupo sem montar SQL com texto vindo do cliente. */
export const actionsOfGroup = (group) => ACTION_KEYS.filter((key) => ACTIONS[key].group === group);
