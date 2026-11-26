import { OPERATION_PERIODS } from '/shared/assistant-intents.js';
import { DOWN_STATUSES, accountStatusLabel, accountsThatDropped, bestByCost, bestByPerformance, localRange, rejectedAds, totalsByCurrency } from '/shared/assistant-ops.js';
import { statusInfo } from '/shared/ad-status.js';
import { get } from '../../api.js';
import { formatCurrency, formatNumber, formatPercent } from '../../format.js';
import { can } from '../../state.js';

/**
 * Respostas do assistente sobre a OPERAÇÃO da pessoa (quantas BCs, contas que caíram, anúncios rejeitados, criativos enviados, gasto total, melhores
 * criativos e anúncios). Cada resposta usa os MESMOS dados das telas (Gerenciador, Contas TikTok, Criativos) e diz com honestidade o que não dá para
 * saber. O texto vem de blocos (renderizados sem HTML em ./rich.js). Valores de moedas diferentes nunca se misturam.
 */
const ACTIONS = {
  manager: { label: 'Abrir o Gerenciador', href: '/manager' },
  accounts: { label: 'Ir para Contas TikTok', href: '/business-centers' },
  creatives: { label: 'Ir para Criativos', href: '/creatives' },
  balance: { label: 'Ver o Saldo', href: '/balance/accounts' },
  reports: { label: 'Abrir os Relatórios', href: '/reports' },
};
const money = (value, currency) => formatCurrency(value, currency && currency !== 'UNKNOWN' ? currency : undefined);
const currencyTitle = (currency) => (currency && currency !== 'UNKNOWN' ? `Contas em ${currency}` : 'Contas sem moeda informada');
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const when = (isoText) => new Date(isoText).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const periodText = (period) => OPERATION_PERIODS[period] ?? 'hoje';
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const noAccess = (what, area) => [
  { type: 'p', text: `O seu acesso não inclui ${area}, então não posso consultar ${what}.` },
  { type: 'p', text: 'Peça ao dono da conta para liberar essa área no seu acesso.' },
];
const queryRange = (period) => {
  const { from, to } = localRange(period);
  return `from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`;
};
const failedAccounts = (data) => {
  const failed = (data.accounts ?? []).filter((a) => a.status === 'error').length;
  return failed ? [{ type: 'note', tone: 'warn', text: `${plural(failed, 'conta não respondeu', 'contas não responderam')} agora (o TikTok limita a frequência das consultas); os números podem estar incompletos.` }] : [];
};
const loadManager = (level, period) => get(`/tiktok/manager/${level}?preset=${period}`);

// ---------------------------------------------------------------------------
async function bcsAnswer() {
  if (!can('accounts')) return noAccess('as suas Business Centers', 'a área "Contas TikTok"');
  const { businessCenters: list } = await get('/tiktok/business-centers');
  if (!list.length) return [{ type: 'p', text: 'Você ainda não tem nenhuma Business Center conectada.' }, { type: 'actions', items: [ACTIONS.accounts] }];
  const ids = new Set(list.flatMap((c) => c.bcIds ?? []));
  const accounts = list.reduce((sum, c) => sum + c.advertiserCount, 0);
  const withError = list.filter((c) => c.status === 'error');
  const blocks = [
    { type: 'p', text: `Você tem ${plural(ids.size || list.length, 'Business Center', 'Business Centers')} em ${plural(list.length, 'conexão', 'conexões')}, com ${plural(accounts, 'conta de anúncio', 'contas de anúncio')} no total.` },
    { type: 'kpis', items: [{ label: 'Business Centers', value: formatNumber(ids.size || list.length) }, { label: 'Conexões', value: formatNumber(list.length) }, { label: 'Contas de anúncio', value: formatNumber(accounts) }, { label: 'Conexões com erro', value: formatNumber(withError.length) }] },
    { type: 'table', head: ['Conexão', 'Business Center', 'Contas', 'Situação'], rows: list.slice(0, 15).map((c) => [c.name, (c.bcIds ?? []).join(', ') || '—', String(c.advertiserCount), c.status === 'error' ? 'Com erro' : 'Ativa']) },
  ];
  if (list.length > 15) blocks.push({ type: 'p', text: `… e mais ${list.length - 15} conexões. Veja todas em Contas TikTok.` });
  if (withError.length) blocks.push({ type: 'note', tone: 'warn', text: `${plural(withError.length, 'conexão está com erro de acesso', 'conexões estão com erro de acesso')} (${withError.slice(0, 3).map((c) => c.name).join(', ')}). Em Contas TikTok use "Renovar acesso".` });
  blocks.push({ type: 'actions', items: [ACTIONS.accounts] });
  return blocks;
}

async function accountsAnswer() {
  if (!can('accounts')) return noAccess('as suas contas de anúncio', 'a área "Contas TikTok"');
  const [{ advertisers }, status] = await Promise.all([get('/tiktok/advertisers'), get(`/assistant/accounts-down?${queryRange('today')}`)]);
  if (!advertisers.length) return [{ type: 'p', text: 'Você ainda não tem contas de anúncio conectadas.' }, { type: 'actions', items: [ACTIONS.accounts] }];
  const byCurrency = new Map();
  for (const a of advertisers) byCurrency.set(a.currency ?? 'UNKNOWN', (byCurrency.get(a.currency ?? 'UNKNOWN') ?? 0) + 1);
  const blocks = [
    { type: 'p', text: `Você tem ${plural(advertisers.length, 'conta de anúncio', 'contas de anúncio')} conectadas${byCurrency.size > 1 ? ` (${[...byCurrency.entries()].map(([c, n]) => `${n} em ${c === 'UNKNOWN' ? 'moeda não informada' : c}`).join(', ')})` : ''}.` },
  ];
  if (status.monitored > 0) {
    const notEnabled = status.current;
    blocks.push({ type: 'kpis', items: [{ label: 'Contas', value: formatNumber(advertisers.length) }, { label: 'Ativas', value: formatNumber(Math.max(0, status.monitored - notEnabled.length)) }, { label: 'Fora do ar ou em análise', value: formatNumber(notEnabled.length) }] });
    if (notEnabled.length) blocks.push({ type: 'table', head: ['Conta', 'Situação', 'Desde'], rows: notEnabled.slice(0, 10).map((c) => [c.name, accountStatusLabel(c.status), when(c.since)]) });
    else blocks.push({ type: 'note', tone: 'good', text: 'Todas as contas lidas estão ativas.' });
  } else {
    blocks.push({ type: 'note', tone: 'info', text: 'Ainda não li a situação das contas (a leitura é feita a cada 30 minutos, junto com o gasto por hora). Volte em alguns minutos.' });
  }
  blocks.push({ type: 'actions', items: [ACTIONS.accounts, ACTIONS.balance] });
  return blocks;
}

async function accountsDownAnswer({ period }) {
  if (!can('accounts')) return noAccess('a situação das contas', 'a área "Contas TikTok"');
  const data = await get(`/assistant/accounts-down?${queryRange(period)}`);
  const dropped = accountsThatDropped(data.events, DOWN_STATUSES);
  const blocks = [{ type: 'p', text: dropped.length ? `${cap(periodText(period))}, ${plural(dropped.length, 'conta caiu', 'contas caíram')}.` : `Nenhuma conta caiu ${periodText(period)} (nas leituras que fiz).` }];
  blocks.push({ type: 'kpis', items: [{ label: 'Caíram no período', value: formatNumber(dropped.length) }, { label: 'Fora do ar agora', value: formatNumber(data.current.length) }, { label: 'Contas acompanhadas', value: formatNumber(data.monitored) }] });
  if (dropped.length) blocks.push({ type: 'table', head: ['Conta', 'Antes', 'Agora', 'Quando'], rows: dropped.slice(0, 15).map((e) => [e.name, accountStatusLabel(e.previousStatus), accountStatusLabel(e.status), when(e.at)]) });
  const stillDown = data.current.filter((c) => !dropped.some((d) => d.advertiserId === c.advertiserId));
  if (stillDown.length) blocks.push({ type: 'note', tone: 'warn', text: `Fora do ar agora, desde antes do período: ${stillDown.slice(0, 5).map((c) => `${c.name} (${accountStatusLabel(c.status)})`).join(', ')}.` });
  blocks.push(data.monitoredSince
    ? { type: 'note', tone: 'info', text: `Eu acompanho a situação das contas desde ${when(data.monitoredSince)}, lendo a cada 30 minutos. Uma queda que começou e acabou entre duas leituras, ou antes disso, não aparece.` }
    : { type: 'note', tone: 'info', text: 'Ainda não li a situação das contas (a leitura é feita a cada 30 minutos). Volte em alguns minutos: só posso contar o que eu mesmo vi mudar.' });
  blocks.push({ type: 'actions', items: [ACTIONS.accounts, ACTIONS.manager] });
  return blocks;
}

async function adsRejectedAnswer({ period }) {
  if (!can('campaigns', 'reports')) return noAccess('os anúncios', 'as áreas "Campanhas" ou "Relatórios"');
  const data = await loadManager('ads', period);
  const range = localRange(period);
  const { inPeriod, total } = rejectedAds(data.ads, range);
  const blocks = [{ type: 'p', text: inPeriod.length ? `${cap(periodText(period))}, ${plural(inPeriod.length, 'anúncio foi reprovado', 'anúncios foram reprovados')}.` : `Nenhum anúncio foi reprovado ${periodText(period)}.` }];
  blocks.push({ type: 'kpis', items: [{ label: `Reprovados ${periodText(period)}`, value: formatNumber(inPeriod.length) }, { label: 'Reprovados agora (total)', value: formatNumber(total.length) }, { label: 'Anúncios no total', value: formatNumber(data.ads.length) }] });
  const shown = (inPeriod.length ? inPeriod : total).slice(0, 10);
  if (shown.length) {
    blocks.push({ type: 'h', text: inPeriod.length ? 'Reprovados no período' : 'Reprovados no momento (de períodos anteriores)' });
    blocks.push({ type: 'table', head: ['Anúncio', 'Conta', 'Motivo (status)', 'Alterado em'], rows: shown.map((r) => [r.name ?? r.id, r.accountName, statusInfo('ads', r.status).label, r.modifiedAt ? when(r.modifiedAt) : '—']) });
  }
  blocks.push({ type: 'note', tone: 'info', text: 'O TikTok não informa o horário exato da reprovação: conto os anúncios que estão reprovados agora e foram alterados no período. Anúncios excluídos não entram.' });
  blocks.push(...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager] });
  return blocks;
}

async function creativesUploadedAnswer({ period }) {
  if (!can('creatives')) return noAccess('os criativos', 'a área "Criativos"');
  const data = await get(`/assistant/creatives?${queryRange(period)}`);
  const blocks = [{ type: 'p', text: data.total ? `Você enviou ${plural(data.total, 'criativo', 'criativos')} ${periodText(period)}: ${plural(data.videos, 'vídeo', 'vídeos')} e ${plural(data.images, 'imagem', 'imagens')}.` : `Você não enviou nenhum criativo ${periodText(period)}.` }];
  blocks.push({ type: 'kpis', items: [{ label: 'Enviados', value: formatNumber(data.total) }, { label: 'Vídeos', value: formatNumber(data.videos) }, { label: 'Imagens', value: formatNumber(data.images) }] });
  if (data.latest.length) blocks.push({ type: 'ul', items: data.latest });
  blocks.push({ type: 'actions', items: [ACTIONS.creatives] });
  return blocks;
}

async function spendTotalAnswer({ period }) {
  if (!can('campaigns', 'reports')) return noAccess('o gasto', 'as áreas "Campanhas" ou "Relatórios"');
  const data = await loadManager('campaigns', period);
  const totals = totalsByCurrency(data.campaigns);
  if (!data.accounts.length) return [{ type: 'p', text: 'Ainda não há contas de anúncio conectadas, então não tenho gasto para mostrar.' }, { type: 'actions', items: [ACTIONS.accounts] }];
  if (!totals.some((t) => t.spend > 0)) {
    return [{ type: 'p', text: `Nenhum gasto ${periodText(period)} nas suas contas.` }, { type: 'note', tone: 'info', text: 'Se há campanhas ativas, confira se estão em veiculação (Gerenciador) e se as contas têm saldo (Saldo).' }, ...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager, ACTIONS.balance] }];
  }
  const blocks = [{ type: 'p', text: `Gasto ${periodText(period)} em ${plural(data.accounts.filter((a) => a.status === 'ok').length, 'conta', 'contas')}. Cada moeda fica à parte, porque não dá para somar reais com dólares.` }];
  for (const t of totals.filter((x) => x.spend > 0)) {
    blocks.push({ type: 'h', text: currencyTitle(t.currency) });
    blocks.push({ type: 'kpis', items: [{ label: 'Gasto total', value: money(t.spend, t.currency) }, { label: 'Impressões', value: formatNumber(t.impressions) }, { label: 'Cliques', value: formatNumber(t.clicks) }, { label: 'Conversões', value: formatNumber(t.conversions) }] });
    const top = data.campaigns.filter((c) => (c.currency ?? 'UNKNOWN') === t.currency && c.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 5);
    if (top.length) blocks.push({ type: 'table', head: ['Campanha', 'Conta', 'Gasto', '% do total'], rows: top.map((c) => [c.name ?? c.id, c.accountName, money(c.spend, t.currency), formatPercent((c.spend / t.spend) * 100)]) });
  }
  blocks.push({ type: 'note', tone: 'info', text: 'É a soma das campanhas, a mesma do Gerenciador (no fuso de cada conta). Campanhas excluídas não entram.' });
  blocks.push(...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager, ACTIONS.reports] });
  return blocks;
}

async function bestCreativesAnswer({ period }) {
  if (!can('campaigns', 'reports')) return noAccess('o desempenho dos anúncios', 'as áreas "Campanhas" ou "Relatórios"');
  const data = await loadManager('ads', period);
  const groups = bestByPerformance(data.ads, 5);
  if (!groups.length) return [{ type: 'p', text: `Nenhum anúncio teve gasto ${periodText(period)}, então não há o que comparar.` }, ...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager] }];
  const blocks = [{ type: 'p', text: `Os anúncios que melhor performaram ${periodText(period)}, ordenados por conversões e, no empate, por CTR. Cada moeda à parte.` }];
  for (const g of groups) {
    blocks.push({ type: 'h', text: currencyTitle(g.currency) });
    blocks.push({ type: 'table', head: ['Anúncio', 'Conversões', 'CTR', 'Gasto', 'Cliques'], rows: g.rows.map((r) => [r.name ?? r.id, formatNumber(r.conversions ?? 0), formatPercent(r.ctr ?? 0), money(r.spend, g.currency), formatNumber(r.clicks ?? 0)]) });
  }
  blocks.push({ type: 'note', tone: 'info', text: 'Aqui "criativo" é o anúncio: o TikTok não liga o anúncio ao arquivo da sua biblioteca. Se você dá o nome do criativo ao anúncio, o ranking já mostra qual criativo venceu.' });
  blocks.push(...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager, ACTIONS.creatives] });
  return blocks;
}

async function bestCostAnswer({ period }) {
  if (!can('campaigns', 'reports')) return noAccess('as métricas dos anúncios', 'as áreas "Campanhas" ou "Relatórios"');
  const data = await loadManager('ads', period);
  const groups = bestByCost(data.ads, 5);
  if (!groups.length) return [{ type: 'p', text: `Não há anúncios com gasto e resultado suficientes ${periodText(period)} para comparar custos.` }, ...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager] }];
  const blocks = [{ type: 'p', text: `Os anúncios com o melhor custo ${periodText(period)}. Só entram anúncios com gasto relevante (pelo menos 2% do gasto da moeda), porque custo baixo com gasto ínfimo não quer dizer nada.` }];
  for (const g of groups) {
    blocks.push({ type: 'h', text: `${currencyTitle(g.currency)} · menor ${g.metric === 'costPerResult' ? 'custo por resultado' : 'CPC (ninguém teve resultado)'}` });
    blocks.push({ type: 'table', head: ['Anúncio', g.metric === 'costPerResult' ? 'Custo por resultado' : 'CPC', 'Gasto', 'Resultados', 'CTR'], rows: g.rows.map((r) => [r.name ?? r.id, money(g.metric === 'costPerResult' ? r.costPerResult : r.cpc, g.currency), money(r.spend, g.currency), formatNumber(r.result ?? 0), formatPercent(r.ctr ?? 0)]) });
  }
  blocks.push(...failedAccounts(data), { type: 'actions', items: [ACTIONS.manager] });
  return blocks;
}

const HANDLERS = { bcs: bcsAnswer, accounts: accountsAnswer, accountsDown: accountsDownAnswer, adsRejected: adsRejectedAnswer, creativesUploaded: creativesUploadedAnswer, spendTotal: spendTotalAnswer, bestCreatives: bestCreativesAnswer, bestCost: bestCostAnswer };

/** Monta a resposta de uma pergunta de operação `{ id, period }`. Lança erro (com mensagem para a pessoa) se a consulta falhar. */
export async function operationAnswer(operation) {
  const handler = HANDLERS[operation.id];
  return handler({ period: operation.period });
}
