/**
 * Perguntas sobre a OPERAÇÃO da pessoa dentro da plataforma (quantas BCs, contas que caíram, anúncios rejeitados, criativos enviados, gasto
 * total, melhores criativos e anúncios). Regras puras e sem DOM (usadas pela tela e testadas em Node): reconhecem a pergunta por palavras-chave
 * e o período citado ("hoje", "ontem", "7 dias"…). Não há modelo de linguagem: o que não for reconhecido cai nos assuntos antigos do assistente.
 */

/** Períodos que o Gerenciador entende (mesmos ids de shared/manager-columns.js). */
export const OPERATION_PERIODS = Object.freeze({
  today: 'hoje',
  yesterday: 'ontem',
  last7: 'nos últimos 7 dias',
  last14: 'nos últimos 14 dias',
  last30: 'nos últimos 30 dias',
  thisMonth: 'neste mês',
  lastMonth: 'no mês passado',
});

export const OPERATIONS = Object.freeze({
  bcs: { id: 'bcs', title: 'Minhas Business Centers', text: 'Quantas Business Centers eu tenho?' },
  accounts: { id: 'accounts', title: 'Minhas contas de anúncio', text: 'Quantas contas de anúncio eu tenho e como estão?' },
  accountsDown: { id: 'accountsDown', title: 'Contas que caíram', text: 'Quantas contas caíram hoje?' },
  adsRejected: { id: 'adsRejected', title: 'Anúncios rejeitados', text: 'Quantos anúncios foram rejeitados hoje?' },
  creativesUploaded: { id: 'creativesUploaded', title: 'Criativos enviados', text: 'Quantos criativos eu subi hoje?' },
  spendTotal: { id: 'spendTotal', title: 'Gasto total', text: 'Quanto gastei no total hoje em ads?' },
  bestCreatives: { id: 'bestCreatives', title: 'Melhores criativos', text: 'Quais criativos performaram melhor hoje?' },
  bestCost: { id: 'bestCost', title: 'Melhor custo', text: 'Quais anúncios tiveram as melhores métricas de custo hoje?' },
});
export const OPERATION_IDS = Object.freeze(Object.keys(OPERATIONS));

const plain = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Período citado na pergunta (padrão: hoje). */
export function detectPeriod(text) {
  const t = plain(text);
  if (/mes passado|ultimo mes fechado/.test(t)) return 'lastMonth';
  if (/este mes|neste mes|mes atual|no mes\b/.test(t)) return 'thisMonth';
  if (/\b30 dias|ultimo mes|ultimos 30/.test(t)) return 'last30';
  if (/\b14 dias|duas semanas|quinzena/.test(t)) return 'last14';
  if (/\b7 dias|semana|ultimos sete|ultima semana/.test(t)) return 'last7';
  if (/\bontem\b/.test(t)) return 'yesterday';
  return 'today';
}

const hasMetric = (t) => /(gast|invest|custou|custo|cpc|cpa|cpm)/.test(t);

/**
 * Reconhece uma pergunta sobre a operação. Devolve `{ id, period }` (id de OPERATIONS) ou `null` quando não é uma pergunta deste tipo.
 * A ordem importa: o mais específico primeiro.
 */
export function detectOperation(text) {
  const t = plain(text);
  if (!t) return null;
  const done = (id) => ({ id, period: detectPeriod(t) });

  // contas que caíram / foram punidas
  if (/(conta|contas|bm|bc|business)/.test(t) && /(caiu|cairam|caida|caidas|cair|derrub|banid|banimento|suspens|suspend|punid|punic|bloquead|desativad|reprovad|perdi)/.test(t)) return done('accountsDown');
  // anúncios rejeitados
  if (/(anuncio|anuncios|ads?\b)/.test(t) && /(rejeit|reprov|negad|recus|disapprov|nao aprovad|barrad)/.test(t)) return done('adsRejected');
  // criativos enviados (subi, enviei, upload, fiz upload, adicionei, postei)
  if (/criativo|video|videos|imagem|imagens/.test(t) && /(subi|subiu|subimos|enviei|enviou|upload|adicionei|postei|carreguei|publiquei na biblioteca|quantos .* (tenho|tem))/.test(t) && !/(melhor|performou|performaram|performar|pior)/.test(t)) return done('creativesUploaded');
  // melhores criativos
  if (/criativo|video|videos/.test(t) && /(melhor|melhores|performou|performaram|performar|performance|desempenho|vencedor|ganhador|mais convert|mais vend|top)/.test(t)) return done('bestCreatives');
  // melhores anúncios em custo
  if (/anuncio|anuncios|ads?\b/.test(t) && /(melhor|melhores|menor|menores|mais barat|baratos)/.test(t) && /(custo|cpc|cpa|cpm|barat|metrica)/.test(t)) return done('bestCost');
  if (/(melhores|melhor) (metricas?|custos?)/.test(t) && /anuncio|ads?\b/.test(t)) return done('bestCost');
  // gasto total
  if (/(quanto|total|soma|somando)/.test(t) && hasMetric(t) && !/(conta|contas)\s+(que\s+)?mais/.test(t)) return done('spendTotal');
  if (/gasto total|total gasto|total investido|valor gasto/.test(t)) return done('spendTotal');
  // quantas BCs / contas
  if (/(quantas?|numero de|qtd|quantidade)/.test(t) && /\b(bcs?|bms?|business centers?|business center|gerenciadores?)\b/.test(t)) return done('bcs');
  if (/(quantas?|numero de|qtd|quantidade)/.test(t) && /contas?( de anuncio| de ads)?/.test(t)) return done('accounts');
  return null;
}
