import { EXTRA_TOPICS, TOPICS } from '/shared/chat-topics.js';
import { buildInsights, percentChange } from '/shared/report-insights.js';
import { get } from '../../api.js';
import { formatCurrency, formatNumber, formatPercent } from '../../format.js';
import { can } from '../../state.js';

/**
 * Respostas do assistente do Início. Não há um modelo de linguagem por trás: o assistente reconhece os assuntos abaixo (pelas sugestões ou por
 * palavras-chave na pergunta) e responde com DADOS REAIS das contas (desempenho e gasto) ou com tutoriais detalhados. O que não reconhece, ele diz
 * com honestidade e oferece os assuntos que sabe responder.
 *
 * Uma resposta é uma lista de blocos (renderizados sem HTML em ./rich.js):
 *   { type: 'p', text } | { type: 'h', text } | { type: 'ul' | 'ol', items: [texto | { title, text }] } | { type: 'kpis', items: [{ label, value, delta }] }
 *   | { type: 'table', head: [..], rows: [[..]] } | { type: 'note', tone: 'info' | 'warn' | 'good', text } | { type: 'actions', items: [{ label, href | wizard | ask }] }
 */

const ACTION = {
  wizard: { label: 'Abrir o assistente de campanha', wizard: true },
  creatives: { label: 'Ir para Criativos', href: '/creatives' },
  manager: { label: 'Ir para o Gerenciador', href: '/manager' },
  reports: { label: 'Abrir os Relatórios', href: '/reports' },
  accounts: { label: 'Ir para Contas TikTok', href: '/business-centers' },
  catalog: { label: 'Ir para Catálogo', href: '/catalog' },
};

// ---------------------------------------------------------------------------
// Tutoriais
// ---------------------------------------------------------------------------
const connectSteps = () => [
  { type: 'h', text: 'Como conectar a sua Business Center' },
  { type: 'ol', items: [
    { title: 'Abra Contas TikTok', text: 'No menu lateral, grupo "BC e CA", e clique em "Conectar Business Center".' },
    { title: 'Escolha o jeito mais fácil: por link', text: 'Dê um nome à conexão e clique para gerar o link. Abra-o no navegador em que você está logado na Business Center do TikTok, escolha as contas de anúncio e confirme. O sistema acompanha sozinho e conclui a conexão.' },
    { title: 'Ou cole um token (avançado)', text: 'Em "Prefiro colar um token", informe o ID da Business Center e o token de acesso da Marketing API.' },
    { title: 'Confira', text: 'Em "Contas de anúncio" aparecem todas as contas com moeda, fuso e status. Se algo faltar, use "Atualizar contas"; se aparecer "Com erro", use "Renovar acesso".' },
  ] },
  { type: 'actions', items: [ACTION.accounts] },
];

function campaignTutorial() {
  return [
    { type: 'p', text: 'Vamos criar uma campanha de TRÁFEGO (leva pessoas ao seu site). Tudo é criado PAUSADO: nada gasta até você ativar.' },
    { type: 'h', text: 'Antes de começar (uns 5 minutos)' },
    { type: 'ul', items: [
      'Conecte a sua Business Center em Contas TikTok (se ainda não conectou, peça "Como conecto minha Business Center?").',
      'Tenha ao menos um vídeo na biblioteca: Criativos → Enviar. Vertical 9:16, 720 × 1280 ou maior, de 5 a 60 segundos. Na publicação o sistema limpa os metadados e refaz o arquivo para cada conta.',
      'Tenha a URL de destino (site ou página de vendas). Para tráfego não precisa de pixel; se quiser medir vendas depois, instale o pixel e use o objetivo "Conversões no site".',
    ] },
    { type: 'h', text: 'Passo a passo no assistente (botão "Publicar campanha")' },
    { type: 'ol', items: [
      { title: 'Objetivo', text: 'Escolha "Tráfego".' },
      { title: 'Campanha', text: 'Dê um nome que você reconheça depois (ex.: TRÁFEGO | Produto X | Nov/26). No orçamento, deixe "Sem limite" e defina o valor no grupo de anúncios (fica mais fácil de ajustar), ou escolha diário para limitar a campanha toda.' },
      { title: 'Grupo de anúncios', text: 'Países de destino; idade e gênero (comece amplo: o TikTok aprende com o tempo); posicionamentos automáticos; orçamento diário (use um valor que você aceita gastar por 3 a 7 dias para ter dados); agenda "começar imediatamente"; meta "Cliques" (ou "Visualizações da página de destino" se a sua página carrega rápido); cobrança CPC; lance "Menor custo (automático)" no começo.' },
      { title: 'Anúncio', text: 'Identidade (nome e foto que aparecem), o vídeo da biblioteca, o texto (até 100 caracteres: benefício direto + chamada), o botão (ex.: "Saiba mais" ou "Comprar agora") e a URL de destino. Em "Parâmetros UTM" use utm_source=tiktok&utm_medium=cpc para enxergar o tráfego no seu analytics.' },
      { title: 'Revisão e publicação', text: 'Confira o resumo, escolha em quais contas de anúncio publicar (pode ser mais de uma) e publique.' },
    ] },
    { type: 'h', text: 'Depois de publicar' },
    { type: 'ol', items: [
      'Abra Ads → Gerenciador, encontre o anúncio e ligue o interruptor "Ativo".',
      'O TikTok analisa o anúncio: o status passa de "Em análise" para "Em veiculação" (costuma levar de minutos a algumas horas).',
      'Acompanhe CTR e CPC no Gerenciador (período "Hoje") e no menu KPI → Relatórios.',
      'Espere de 3 a 7 dias antes de mudar o que quer que seja: edições constantes reiniciam o aprendizado.',
      'Depois: pause os anúncios com CTR muito abaixo dos outros e duplique o melhor com um gancho novo (peça "Me dê 5 ideias de gancho").',
    ] },
    { type: 'note', tone: 'info', text: 'Dica: compare seus anúncios entre si em vez de procurar um número mágico. O melhor CTR e o menor CPC do seu próprio teste mandam.' },
    { type: 'actions', items: [ACTION.wizard, ACTION.creatives, ACTION.manager] },
  ];
}

function creativeIdeas() {
  return [
    { type: 'p', text: 'Nos anúncios em vídeo, os 3 primeiros segundos decidem se a pessoa fica. Estes são 5 ganchos que funcionam em quase qualquer nicho, cada um com um roteiro curto para adaptar:' },
    { type: 'ol', items: [
      { title: '1. A pergunta que dói (problema)', text: 'Abra com uma pergunta sobre a dor exata do cliente. Ex.: "Você também acorda com dor nas costas?" Roteiro: 0–3 s pergunta + cena do problema · 3–8 s o produto resolvendo · 8–15 s prova rápida + chamada ("toque em Saiba mais").' },
      { title: '2. Resultado primeiro (antes e depois)', text: 'Mostre o resultado nos 2 primeiros segundos e só depois explique como chegou lá. Ex.: o espelho limpo, o gráfico subindo, a casa organizada. Roteiro: 0–2 s resultado · 2–10 s "como eu fiz" em 3 passos · fim com a chamada.' },
      { title: '3. Quebra de crença', text: 'Contrarie algo que todo mundo faz. Ex.: "Pare de lavar o cabelo todo dia — faça isto." Gera curiosidade e comentários. Roteiro: 0–3 s a frase de choque · 3–10 s o motivo · 10–15 s a alternativa (seu produto).' },
      { title: '4. Prova social', text: 'Comece por um depoimento real ou pela captura de uma avaliação/comentário elogiando. Ex.: "A cliente Ana me mandou isso hoje…". Use só números e depoimentos verdadeiros. Roteiro: 0–3 s o depoimento · 3–10 s o produto · 10–15 s oferta.' },
      { title: '5. Demonstração em 3 segundos', text: 'Sem introdução: o produto em uso, de perto (unboxing, antes de usar, som do produto). Texto grande na tela com o benefício. Roteiro: 0–3 s demonstração impactante · 3–12 s detalhes e variações · 12–15 s chamada.' },
    ] },
    { type: 'h', text: 'Como transformar cada ideia em anúncio aqui' },
    { type: 'ol', items: [
      'Grave na vertical (9:16), 720 × 1280 ou maior, de 5 a 15 segundos, com legenda e texto na tela (muita gente assiste sem som).',
      'Vá em Criativos e envie os vídeos (arraste e solte). Dá para organizar em pastas por oferta.',
      'Opcional: use "Hook com IA" (dentro de Criativos) para gerar só o começo de 2 a 3 segundos e juntar ao seu vídeo. Ele depende de créditos da Kling: se aparecer "Avise o administrador do sistema", os créditos acabaram e o administrador precisa recarregar.',
      'Teste 3 ganchos diferentes com o mesmo corpo de vídeo (só o começo muda). Assim você descobre o que prende, não o que o resto do vídeo faz.',
      'Publique pelo assistente (botão "Publicar campanha") e acompanhe o CTR e o CPC no Gerenciador. Mantenha o gancho vencedor e crie novas variações dele.',
    ] },
    { type: 'note', tone: 'warn', text: 'Cuidado com as políticas do TikTok: evite promessas milagrosas, "antes e depois" enganoso e alegações de saúde ou ganhos sem prova. Anúncio reprovado atrasa tudo.' },
    { type: 'actions', items: [ACTION.creatives, ACTION.wizard] },
  ];
}

function catalogTutorial() {
  return [
    { type: 'p', text: 'Campanha de catálogo (objetivo "Vendas de produtos") mostra produtos do seu catálogo nos anúncios. O catálogo vem primeiro:' },
    { type: 'h', text: '1. Crie o catálogo' },
    { type: 'ol', items: [
      'Ads → Catálogo → "+ Catálogo". Escolha a Business Center, o nome, o país de destino e a moeda (depois de criado, o país e a moeda não mudam).',
      'Confirme: o catálogo é criado direto no TikTok.',
    ] },
    { type: 'h', text: '2. Adicione os produtos' },
    { type: 'ol', items: [
      'Abra o catálogo → aba "Adicionar produtos". Importe uma planilha CSV (baixe o modelo) ou cadastre produto a produto.',
      'Cada produto precisa de SKU, título, descrição, estoque, marca, imagem (JPG/PNG de pelo menos 500 × 500 px, pública), condição, preço e página do produto.',
      'Envie. O sistema mostra o resultado do processamento (novos, atualizados e erros com a sugestão de correção).',
      'Aguarde a aprovação (minutos a algumas horas). Só produtos aprovados e disponíveis servem para anúncios: a aba "Produtos" mostra "Pode usar".',
    ] },
    { type: 'h', text: '2.1 Mantenha preço e estoque atualizados sozinho' },
    { type: 'ol', items: [
      'Aba "Sincronização" → informe a URL do feed de produtos da sua loja (CSV, TSV ou XML no formato Google Merchant; Shopify, WooCommerce, Nuvemshop e outras plataformas geram esse feed).',
      'Escolha de quanto em quanto tempo o TikTok deve buscar (horas, dias ou meses) e o fuso. Se o feed tiver senha, informe usuário e senha: eles vão direto ao TikTok e o sistema não os guarda.',
      '"Atualizar" mantém os produtos que saírem do feed; "Substituir tudo" faz o catálogo ser exatamente o feed (produtos fora dele são removidos).',
      'O TikTok guarda só a disponibilidade (em estoque, sem estoque…), não o número do estoque: o seu feed precisa da coluna "availability". Na planilha CSV ou no formulário você pode informar a quantidade e o sistema calcula a disponibilidade.',
    ] },
    { type: 'h', text: '3. (Opcional) Crie conjuntos de produtos' },
    { type: 'p', text: 'Aba "Conjuntos de produtos": filtre por marca, preço, estoque etc. para anunciar só parte do catálogo.' },
    { type: 'h', text: '4. Crie a campanha' },
    { type: 'ol', items: [
      'Aba "Campanha" do catálogo: escolha UMA vez os criativos da biblioteca (vídeo e capa), quais produtos mostrar, o texto, o botão, a URL e a identidade, e salve. Um painel mostra o que ainda falta.',
      'Depois, o botão "Criar campanha com este catálogo" abre o assistente já preenchido com tudo isso (só falta escolher as contas de anúncio). No assistente normal, use "Usar o anúncio padrão deste catálogo" sob o seletor de catálogo.',
      'No grupo de anúncios, escolha o catálogo na lista e a meta (Cliques, Conversões com pixel, ou Valor/ROAS). O orçamento fica no grupo.',
      'No anúncio, escolha "Vídeo do catálogo" (gerado com os seus produtos) ou o seu próprio vídeo, quais produtos mostrar (todos, um conjunto ou até 20 SKUs), o texto, o botão e a URL da sua loja.',
      'Publique (tudo nasce pausado) e ative no Gerenciador.',
    ] },
    { type: 'actions', items: [ACTION.catalog, ACTION.wizard] },
  ];
}

// ---------------------------------------------------------------------------
// Respostas com dados reais
// ---------------------------------------------------------------------------
const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const delta = (current, previous) => {
  const change = percentChange(current, previous);
  return change === null ? null : `${change >= 0 ? '+' : '−'}${formatPercent(Math.abs(change))} vs. período anterior`;
};
const label = (name, currency) => `${name}${currency && currency !== 'UNKNOWN' ? ` · ${currency}` : ''}`;

async function loadOverview(days = 7) {
  return get(`/tiktok/overview?days=${days}&compare=1`);
}

function noAccess() {
  return [
    { type: 'p', text: 'Seu acesso não inclui a área de Relatórios, então não posso consultar os números das contas.' },
    { type: 'p', text: 'Peça ao dono da conta para liberar "Relatórios" no seu acesso.' },
  ];
}
function noAccounts() {
  return [
    { type: 'p', text: 'Ainda não há contas de anúncio conectadas, então não tenho números para mostrar.' },
    ...connectSteps(),
  ];
}

export async function performanceAnswer() {
  if (!can('reports')) return noAccess();
  const data = await loadOverview(7);
  if (!data.totalAdvertisers) return noAccounts();
  const blocks = [{ type: 'p', text: `Desempenho de ${shortDate(data.range.startDate)} a ${shortDate(data.range.endDate)} (últimos 7 dias), em ${data.analyzed} ${data.analyzed === 1 ? 'conta' : 'contas'}. Valores de moedas diferentes ficam separados.` }];
  if (!data.groups.length) {
    blocks.push({ type: 'note', tone: 'warn', text: 'Nenhuma conta respondeu agora. Tente de novo em instantes (o TikTok limita a frequência das consultas).' });
  }
  for (const group of data.groups) {
    const t = group.totals;
    const p = group.previous;
    const money = (value) => formatCurrency(value, group.currency);
    blocks.push({ type: 'h', text: group.currency && group.currency !== 'UNKNOWN' ? `Contas em ${group.currency}` : 'Contas sem moeda informada' });
    blocks.push({ type: 'kpis', items: [
      { label: 'Gasto', value: money(t.spend), delta: p ? delta(t.spend, p.spend) : null },
      { label: 'Impressões', value: formatNumber(t.impressions), delta: p ? delta(t.impressions, p.impressions) : null },
      { label: 'Cliques', value: formatNumber(t.clicks), delta: p ? delta(t.clicks, p.clicks) : null },
      { label: 'CTR', value: formatPercent(t.ctr), delta: p ? delta(t.ctr, p.ctr) : null },
      { label: 'CPC', value: money(t.cpc), delta: p ? delta(t.cpc, p.cpc) : null },
      { label: 'Conversões', value: formatNumber(t.conversions), delta: p ? delta(t.conversions, p.conversions) : null },
    ] });
    const notes = buildInsights({ group, data, metricsCurrency: group.currency, format: { money, percent: formatPercent } });
    if (notes.length) blocks.push({ type: 'ul', items: notes.map((n) => n.text) });
  }
  const top = data.accounts.filter((a) => a.totals.spend > 0).slice(0, 3);
  if (top.length) {
    blocks.push({ type: 'h', text: 'Contas que mais gastaram' });
    blocks.push({ type: 'table', head: ['Conta', 'Gasto', 'Cliques', 'Conversões'], rows: top.map((a) => [label(a.name, a.currency), formatCurrency(a.totals.spend, a.currency), formatNumber(a.totals.clicks), formatNumber(a.totals.conversions)]) });
  }
  blocks.push({ type: 'actions', items: [ACTION.reports, ACTION.manager, { label: 'Onde estou gastando?', ask: TOPICS[1].text }] });
  return blocks;
}

export async function spendAnswer() {
  if (!can('reports')) return noAccess();
  const data = await loadOverview(7);
  if (!data.totalAdvertisers) return noAccounts();
  const blocks = [{ type: 'p', text: `Gasto de ${shortDate(data.range.startDate)} a ${shortDate(data.range.endDate)} (últimos 7 dias). Cada moeda é analisada à parte, porque não dá para somar reais com dólares.` }];
  const groups = data.groups.filter((g) => g.totals.spend > 0);
  if (!groups.length) {
    blocks.push({ type: 'note', tone: 'info', text: 'Nenhum gasto nos últimos 7 dias. Se há campanhas ativas, confira se estão em veiculação (Ads → Gerenciador) e se a conta tem saldo (BC e CA → Saldo).' });
    blocks.push({ type: 'actions', items: [ACTION.manager, ACTION.reports] });
    return blocks;
  }
  for (const group of groups) {
    const accounts = data.accounts.filter((a) => (a.currency ?? 'UNKNOWN') === (group.currency ?? 'UNKNOWN') && a.totals.spend > 0);
    const top = accounts[0];
    const share = (top.totals.spend / group.totals.spend) * 100;
    blocks.push({ type: 'h', text: group.currency && group.currency !== 'UNKNOWN' ? `Contas em ${group.currency}` : 'Contas sem moeda informada' });
    blocks.push({ type: 'p', text: `A conta que mais gastou foi "${top.name}": ${formatCurrency(top.totals.spend, group.currency)}${accounts.length > 1 ? `, ${formatPercent(share)} do total de ${formatCurrency(group.totals.spend, group.currency)}` : ''}.` });
    blocks.push({ type: 'table', head: ['Conta', 'Gasto', '% do total', 'Cliques', 'Conversões'], rows: accounts.slice(0, 5).map((a) => [a.name, formatCurrency(a.totals.spend, group.currency), formatPercent((a.totals.spend / group.totals.spend) * 100), formatNumber(a.totals.clicks), formatNumber(a.totals.conversions)]) });
    if (accounts.length > 5) blocks.push({ type: 'p', text: `… e mais ${accounts.length - 5} contas com gasto. Veja todas nos Relatórios.` });
    const spentNoConversion = accounts.filter((a) => a.totals.conversions === 0).slice(0, 3);
    if (spentNoConversion.length) blocks.push({ type: 'note', tone: 'warn', text: `Gastaram sem nenhuma conversão registrada: ${spentNoConversion.map((a) => a.name).join(', ')}. Vale conferir o pixel e o evento de conversão (ou se o objetivo é tráfego).` });
  }
  if (data.failed) blocks.push({ type: 'note', tone: 'warn', text: `${data.failed === 1 ? '1 conta não pôde' : `${data.failed} contas não puderam`} ser consultada(s) agora; os números podem estar incompletos.` });
  blocks.push({ type: 'actions', items: [ACTION.reports, ACTION.manager] });
  return blocks;
}

// ---------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------
function helpAnswer() {
  return [
    { type: 'p', text: 'Ainda não consigo conversar livremente. Eu respondo, com dados reais das suas contas ou com tutoriais passo a passo, estes assuntos:' },
    { type: 'ul', items: [...TOPICS, ...EXTRA_TOPICS].map((t) => `${t.title}: ${t.text}`) },
    { type: 'actions', items: [...TOPICS, ...EXTRA_TOPICS].map((t) => ({ label: t.title, ask: t.text })) },
  ];
}

/** Monta a resposta de um assunto. Lança erro (com mensagem para a pessoa) se a consulta falhar. */
export async function answerFor(topic) {
  switch (topic) {
    case 'performance': return performanceAnswer();
    case 'spend': return spendAnswer();
    case 'creative': return creativeIdeas();
    case 'campaign': return campaignTutorial();
    case 'catalog': return catalogTutorial();
    case 'connect': return connectSteps();
    default: return helpAnswer();
  }
}
