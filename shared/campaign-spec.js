/**
 * Especificação ÚNICA das campanhas de TikTok Ads (fonte de verdade).
 *
 * Este módulo é isomórfico: o servidor o usa para validar (autoridade final) e o navegador o usa
 * para montar o formulário passo a passo e validar na hora. Não depende de Node nem do DOM.
 *
 * Estrutura da configuração:
 *   { campaign: {…}, adGroup: {…}, ad: {…} }
 * espelhando a hierarquia do TikTok: Campanha → Grupo de anúncios → Anúncio.
 *
 * A CONTA de anúncio não faz parte da configuração: a mesma campanha pode ser publicada em várias contas (de várias
 * Business Centers) na última etapa. Os campos marcados com `perAccount` (pixel, app, catálogo, formulário e identidade)
 * são IDs que pertencem a uma conta específica e podem ser ajustados por conta no momento da publicação.
 *
 * Observação: as combinações de objetivo × meta de otimização × evento de cobrança seguem a estrutura
 * documentada da Marketing API; o TikTok faz a validação final no momento da publicação.
 */

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------
export const OBJECTIVES = [
  { value: 'TRAFFIC', label: 'Tráfego', description: 'Leve pessoas para o seu site ou aplicativo.' },
  { value: 'WEB_CONVERSIONS', label: 'Conversões no site', description: 'Incentive ações valiosas no site, como compras e cadastros.' },
  { value: 'PRODUCT_SALES', label: 'Vendas de produtos', description: 'Venda produtos do seu catálogo diretamente nos anúncios.' },
  { value: 'LEAD_GENERATION', label: 'Geração de leads', description: 'Colete contatos de clientes interessados.' },
  { value: 'APP_PROMOTION', label: 'Promoção de app', description: 'Consiga instalações e ações dentro do seu aplicativo.' },
  { value: 'REACH', label: 'Alcance', description: 'Mostre seu anúncio para o maior número possível de pessoas.' },
  { value: 'VIDEO_VIEWS', label: 'Visualizações de vídeo', description: 'Aumente as visualizações dos seus vídeos.' },
  { value: 'ENGAGEMENT', label: 'Engajamento', description: 'Ganhe seguidores e visitas ao perfil.' },
];

/** Países com o ID de localização (GeoNames) usado pelo TikTok. */
export const COUNTRIES = [
  { value: 'BR', label: 'Brasil', locationId: '3469034' },
  { value: 'PT', label: 'Portugal', locationId: '2264397' },
  { value: 'US', label: 'Estados Unidos', locationId: '6252001' },
  { value: 'CA', label: 'Canadá', locationId: '6251999' },
  { value: 'MX', label: 'México', locationId: '3996063' },
  { value: 'AR', label: 'Argentina', locationId: '3865483' },
  { value: 'CL', label: 'Chile', locationId: '3895114' },
  { value: 'CO', label: 'Colômbia', locationId: '3686110' },
  { value: 'PE', label: 'Peru', locationId: '3932488' },
  { value: 'UY', label: 'Uruguai', locationId: '3439705' },
  { value: 'PY', label: 'Paraguai', locationId: '3437598' },
  { value: 'ES', label: 'Espanha', locationId: '2510769' },
  { value: 'FR', label: 'França', locationId: '3017382' },
  { value: 'DE', label: 'Alemanha', locationId: '2921044' },
  { value: 'IT', label: 'Itália', locationId: '3175395' },
  { value: 'GB', label: 'Reino Unido', locationId: '2635167' },
  { value: 'AU', label: 'Austrália', locationId: '2077456' },
  { value: 'JP', label: 'Japão', locationId: '1861060' },
  { value: 'AE', label: 'Emirados Árabes Unidos', locationId: '290557' },
  { value: 'SA', label: 'Arábia Saudita', locationId: '102358' },
];

const LANGUAGES = [
  ['pt', 'Português'], ['en', 'Inglês'], ['es', 'Espanhol'], ['fr', 'Francês'], ['de', 'Alemão'], ['it', 'Italiano'],
  ['ja', 'Japonês'], ['ko', 'Coreano'], ['ar', 'Árabe'], ['id', 'Indonésio'], ['th', 'Tailandês'], ['vi', 'Vietnamita'],
  ['ru', 'Russo'], ['tr', 'Turco'],
];

const AGE_GROUPS = [
  ['AGE_13_17', '13–17'], ['AGE_18_24', '18–24'], ['AGE_25_34', '25–34'],
  ['AGE_35_44', '35–44'], ['AGE_45_54', '45–54'], ['AGE_55_100', '55+'],
];

const CALLS_TO_ACTION = [
  ['LEARN_MORE', 'Saiba mais'], ['SHOP_NOW', 'Comprar agora'], ['SIGN_UP', 'Cadastre-se'], ['CONTACT_US', 'Fale conosco'],
  ['APPLY_NOW', 'Candidate-se'], ['BOOK_NOW', 'Reservar agora'], ['DOWNLOAD_NOW', 'Baixar agora'], ['INSTALL_NOW', 'Instalar agora'],
  ['ORDER_NOW', 'Pedir agora'], ['GET_QUOTE', 'Pedir orçamento'], ['WATCH_NOW', 'Assistir agora'], ['VIEW_NOW', 'Ver agora'],
  ['PLAY_GAME', 'Jogar'], ['SUBSCRIBE', 'Assinar'], ['VISIT_STORE', 'Visitar loja'],
];

const GOALS_BY_OBJECTIVE = {
  TRAFFIC: [['CLICK', 'Cliques'], ['LANDING_PAGE_VIEW', 'Visualizações da página de destino']],
  WEB_CONVERSIONS: [['CONVERT', 'Conversões'], ['VALUE', 'Valor de conversão (ROAS)']],
  PRODUCT_SALES: [['CLICK', 'Cliques'], ['CONVERT', 'Conversões'], ['VALUE', 'Valor de conversão (ROAS)']],
  LEAD_GENERATION: [['LEAD_GENERATION', 'Leads'], ['CONVERT', 'Conversões']],
  APP_PROMOTION: [['INSTALL', 'Instalações'], ['CONVERT', 'Ações no app'], ['VALUE', 'Valor no app']],
  REACH: [['REACH', 'Alcance']],
  VIDEO_VIEWS: [['VIDEO_VIEW', 'Visualizações de vídeo'], ['ENGAGED_VIEW', 'Visualizações focadas (6 s)']],
  ENGAGEMENT: [['FOLLOWERS', 'Seguidores'], ['PROFILE_VIEWS', 'Visitas ao perfil']],
};

const BILLING_BY_GOAL = {
  CLICK: [['CPC', 'CPC (por clique)'], ['OCPM', 'oCPM (otimizado por mil impressões)']],
  LANDING_PAGE_VIEW: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  CONVERT: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  VALUE: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  INSTALL: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  LEAD_GENERATION: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  REACH: [['CPM', 'CPM (por mil impressões)']],
  VIDEO_VIEW: [['CPV', 'CPV (por visualização)'], ['OCPM', 'oCPM (otimizado por mil impressões)']],
  ENGAGED_VIEW: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  FOLLOWERS: [['OCPM', 'oCPM (otimizado por mil impressões)']],
  PROFILE_VIEWS: [['OCPM', 'oCPM (otimizado por mil impressões)']],
};

const GENERIC_AD_FORMATS = [['SINGLE_VIDEO', 'Vídeo único'], ['SINGLE_IMAGE', 'Imagem única'], ['CAROUSEL_ADS', 'Carrossel de imagens']];
// Campanha de catálogo (Catalog Ads): vídeo gerado com os produtos do catálogo, ou o seu vídeo mostrando produtos do catálogo.
const CATALOG_AD_FORMATS = [['CATALOG_VIDEO', 'Vídeo do catálogo (gerado com os seus produtos)'], ['SINGLE_VIDEO', 'Vídeo único (o seu vídeo + produtos do catálogo)']];
const AD_FORMATS_BY_OBJECTIVE = {};
const toOptions = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const optionsMap = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, toOptions(v)]));
for (const objective of OBJECTIVES) AD_FORMATS_BY_OBJECTIVE[objective.value] = toOptions(objective.value === 'PRODUCT_SALES' ? CATALOG_AD_FORMATS : GENERIC_AD_FORMATS);

const CONVERSION_GOALS = ['CONVERT', 'VALUE'];
const CATALOG = ['PRODUCT_SALES']; // "campanha de catálogo": Vendas de produtos com origem dos produtos = catálogo (Catalog Ads / Video Shopping Ads)
const CATALOG_CONVERSION = { 'campaign.objective': CATALOG, 'adGroup.optimizationGoal': CONVERSION_GOALS };
const WEB_LIKE = ['TRAFFIC', 'WEB_CONVERSIONS', 'LEAD_GENERATION', 'PRODUCT_SALES', 'REACH', 'VIDEO_VIEWS', 'ENGAGEMENT'];

// ---------------------------------------------------------------------------
// Etapas do assistente
// ---------------------------------------------------------------------------
export const STEPS = [
  { id: 'objective', title: 'Objetivo', description: 'Escolha o que você quer alcançar.' },
  { id: 'campaign', title: 'Campanha', description: 'Nome e orçamento no nível da campanha.' },
  { id: 'adGroup', title: 'Grupo de anúncios', description: 'Público, posicionamentos, orçamento, agenda e lances.' },
  { id: 'ad', title: 'Anúncio', description: 'Identidade, criativo, texto e destino.' },
  { id: 'review', title: 'Revisão e publicação', description: 'Confira tudo e escolha em quais contas de anúncio publicar.' },
];

// ---------------------------------------------------------------------------
// Campos
// Atributos: key, label, type, lineOnly (lista separada só por linha), step, group, help, placeholder, default, required, requiredWhen,
// showWhen, hideWhen, perAccount, options | optionsBy {path,map}, min, max, maxItems, pattern, itemPattern, urlSchemes
// Condições (showWhen/requiredWhen): { 'caminho.do.campo': [valores aceitos] } — todas precisam bater (E).
// ---------------------------------------------------------------------------
const ID_PATTERN = /^\d{1,24}$/;
const MEDIA_ID_PATTERN = /^[\w-]{4,100}$/;
const SKU_PATTERN = /^[^\p{Cc}\p{Extended_Pictographic}]{1,100}$/u; // SKU do catálogo: até 100 caracteres, sem emoji nem controle

export const FIELDS = {
  campaign: [
    {
      key: 'objective', label: 'Objetivo da campanha', type: 'objective', step: 'objective', required: true,
      options: toOptions(OBJECTIVES.map((o) => [o.value, o.label])),
    },
    {
      key: 'appPromotionType', label: 'Tipo de promoção do app', type: 'enum', step: 'objective', group: 'Aplicativo',
      options: [{ value: 'APP_INSTALL', label: 'Novas instalações' }, { value: 'APP_RETARGETING', label: 'Reengajamento de usuários' }],
      showWhen: { 'campaign.objective': ['APP_PROMOTION'] }, requiredWhen: { 'campaign.objective': ['APP_PROMOTION'] },
    },
    { key: 'name', label: 'Nome da campanha', type: 'string', step: 'campaign', required: true, min: 2, max: 100, placeholder: 'Ex.: Black Friday – Conversões', group: 'Identificação' },
    {
      key: 'budgetMode', label: 'Orçamento da campanha', type: 'enum', step: 'campaign', group: 'Orçamento', default: 'BUDGET_MODE_INFINITE',
      // Campanha de catálogo: o orçamento da CAMPANHA exige otimização de orçamento (CBO), que o TikTok só libera por allowlist. O orçamento fica no grupo de anúncios.
      hideWhen: { 'campaign.objective': CATALOG },
      help: 'Sem limite: o orçamento é definido no grupo de anúncios. Diário/total: o limite vale para toda a campanha.',
      options: [
        { value: 'BUDGET_MODE_INFINITE', label: 'Sem limite (definir no grupo de anúncios)' },
        { value: 'BUDGET_MODE_DAY', label: 'Orçamento diário' },
        { value: 'BUDGET_MODE_TOTAL', label: 'Orçamento total' },
      ],
    },
    {
      key: 'budget', label: 'Valor do orçamento', type: 'money', step: 'campaign', group: 'Orçamento', min: 1, max: 100_000_000,
      showWhen: { 'campaign.budgetMode': ['BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL'] },
      requiredWhen: { 'campaign.budgetMode': ['BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL'] },
    },
    {
      key: 'specialIndustries', label: 'Categorias especiais de anúncio', type: 'enumList', step: 'campaign', group: 'Conformidade', maxItems: 3,
      hideWhen: { 'campaign.objective': CATALOG }, // em campanha de catálogo é recurso liberado só por allowlist
      help: 'Marque se o anúncio trata de moradia, emprego ou crédito (políticas especiais do TikTok).',
      options: [{ value: 'HOUSING', label: 'Moradia' }, { value: 'EMPLOYMENT', label: 'Emprego' }, { value: 'CREDIT', label: 'Crédito' }],
    },
  ],

  adGroup: [
    { key: 'name', label: 'Nome do grupo de anúncios', type: 'string', step: 'adGroup', required: true, min: 2, max: 100, group: 'Identificação' },

    // Específicos do objetivo
    { key: 'appPlatform', label: 'Plataforma do app', type: 'enum', step: 'adGroup', group: 'Aplicativo',
      options: [{ value: 'APP_ANDROID', label: 'Android' }, { value: 'APP_IOS', label: 'iOS' }],
      showWhen: { 'campaign.objective': ['APP_PROMOTION'] }, requiredWhen: { 'campaign.objective': ['APP_PROMOTION'] } },
    { key: 'appId', perAccount: true, label: 'ID do app', type: 'string', step: 'adGroup', group: 'Aplicativo', pattern: ID_PATTERN, patternMessage: 'Use apenas números.', max: 24,
      showWhen: { 'campaign.objective': ['APP_PROMOTION'] }, requiredWhen: { 'campaign.objective': ['APP_PROMOTION'] } },
    { key: 'catalogId', perAccount: true, label: 'ID do catálogo', type: 'string', step: 'adGroup', group: 'Catálogo', pattern: ID_PATTERN, patternMessage: 'Use apenas números.', max: 24,
      showWhen: { 'campaign.objective': CATALOG }, requiredWhen: { 'campaign.objective': CATALOG },
      help: 'Escolha um catálogo da sua Business Center (menu Catálogo) com produtos disponíveis.' },
    { key: 'catalogBcId', perAccount: true, label: 'ID da Business Center dona do catálogo', type: 'string', step: 'adGroup', group: 'Catálogo', pattern: ID_PATTERN, patternMessage: 'Use apenas números.', max: 24,
      showWhen: { 'campaign.objective': CATALOG }, requiredWhen: { 'campaign.objective': CATALOG },
      help: 'O catálogo é um ativo de uma Business Center; o TikTok exige o ID dela (catalog_authorized_bc_id).' },
    { key: 'leadDestination', label: 'Destino dos leads', type: 'enum', step: 'adGroup', group: 'Leads', default: 'WEBSITE',
      options: [{ value: 'INSTANT_FORM', label: 'Formulário instantâneo do TikTok' }, { value: 'WEBSITE', label: 'Site' }],
      showWhen: { 'campaign.objective': ['LEAD_GENERATION'] } },
    { key: 'leadFormId', perAccount: true, label: 'ID da página/formulário instantâneo', type: 'string', step: 'adGroup', group: 'Leads', pattern: ID_PATTERN, patternMessage: 'Use apenas números.', max: 24,
      showWhen: { 'campaign.objective': ['LEAD_GENERATION'], 'adGroup.leadDestination': ['INSTANT_FORM'] },
      requiredWhen: { 'campaign.objective': ['LEAD_GENERATION'], 'adGroup.leadDestination': ['INSTANT_FORM'] } },

    // Meta e conversão: a meta, o pixel e o evento ficam JUNTOS (nesta ordem), logo depois do que está sendo promovido.
    { key: 'optimizationGoal', label: 'Meta de otimização (o que você quer conseguir)', type: 'enum', step: 'adGroup', group: 'Meta e conversão', required: true,
      help: 'É o que o TikTok vai tentar conseguir com o seu dinheiro. Para vender, escolha Conversões.',
      optionsBy: { path: 'campaign.objective', map: optionsMap(GOALS_BY_OBJECTIVE) } },
    { key: 'pixelId', perAccount: true, label: 'ID do Pixel do TikTok', type: 'string', step: 'adGroup', group: 'Meta e conversão', pattern: ID_PATTERN, patternMessage: 'Use apenas números.', max: 24,
      // Conversões no site sempre usa pixel; em campanha de catálogo só nas metas de conversão (com meta "Cliques" o TikTok recusa o pixel).
      showWhen: [{ 'campaign.objective': ['WEB_CONVERSIONS'] }, CATALOG_CONVERSION], requiredWhen: [{ 'campaign.objective': ['WEB_CONVERSIONS'] }, CATALOG_CONVERSION],
      help: 'Escolha o pixel da sua conta: é ele que mede as conversões do seu site.' },
    { key: 'optimizationEvent', label: 'Evento de conversão (a ação que conta como resultado)', type: 'enum', step: 'adGroup', group: 'Meta e conversão', help: 'A ação do seu site que o pixel registra e que o TikTok vai buscar (ex.: Compra).',
      options: [
        { value: 'SHOPPING', label: 'Compra (geral)' }, { value: 'COMPLETE_PAYMENT', label: 'Pagamento concluído' },
        { value: 'ADD_TO_CART', label: 'Adicionar ao carrinho' }, { value: 'INITIATE_ORDER', label: 'Início de pedido' },
        { value: 'FORM', label: 'Envio de formulário' }, { value: 'ON_WEB_REGISTER', label: 'Cadastro' },
      ],
      showWhen: { 'campaign.objective': ['WEB_CONVERSIONS', 'PRODUCT_SALES'], 'adGroup.optimizationGoal': CONVERSION_GOALS },
      requiredWhen: { 'campaign.objective': ['WEB_CONVERSIONS', 'PRODUCT_SALES'], 'adGroup.optimizationGoal': CONVERSION_GOALS } },

    // Posicionamentos
    { key: 'placementType', label: 'Posicionamentos', type: 'enum', step: 'adGroup', group: 'Posicionamentos', default: 'PLACEMENT_TYPE_AUTOMATIC',
      options: [{ value: 'PLACEMENT_TYPE_AUTOMATIC', label: 'Automáticos (recomendado)' }, { value: 'PLACEMENT_TYPE_NORMAL', label: 'Selecionar manualmente' }] },
    { key: 'placements', label: 'Onde exibir', type: 'enumList', step: 'adGroup', group: 'Posicionamentos', maxItems: 5,
      options: [{ value: 'PLACEMENT_TIKTOK', label: 'TikTok' }, { value: 'PLACEMENT_PANGLE', label: 'Pangle (rede de audiência)' }],
      showWhen: { 'adGroup.placementType': ['PLACEMENT_TYPE_NORMAL'] }, requiredWhen: { 'adGroup.placementType': ['PLACEMENT_TYPE_NORMAL'] } },
    { key: 'commentDisabled', label: 'Desativar comentários', type: 'bool', step: 'adGroup', group: 'Posicionamentos' },
    { key: 'videoDownloadDisabled', label: 'Impedir download do vídeo', type: 'bool', step: 'adGroup', group: 'Posicionamentos' },

    // Público
    { key: 'locations', label: 'Países', type: 'enumList', step: 'adGroup', group: 'Público', required: true, maxItems: 20,
      options: COUNTRIES.map(({ value, label }) => ({ value, label })) },
    { key: 'gender', label: 'Gênero', type: 'enum', step: 'adGroup', group: 'Público', default: 'GENDER_UNLIMITED',
      options: [{ value: 'GENDER_UNLIMITED', label: 'Todos' }, { value: 'GENDER_MALE', label: 'Masculino' }, { value: 'GENDER_FEMALE', label: 'Feminino' }] },
    { key: 'ageGroups', label: 'Faixas etárias', type: 'enumList', step: 'adGroup', group: 'Público', maxItems: 6, help: 'Vazio = todas as idades.', options: toOptions(AGE_GROUPS) },
    { key: 'languages', label: 'Idiomas', type: 'enumList', step: 'adGroup', group: 'Público', maxItems: 14, help: 'Vazio = todos os idiomas.', options: toOptions(LANGUAGES) },
    { key: 'operatingSystems', label: 'Sistemas operacionais', type: 'enumList', step: 'adGroup', group: 'Público', maxItems: 2, help: 'Vazio = todos.',
      options: [{ value: 'ANDROID', label: 'Android' }, { value: 'IOS', label: 'iOS' }] },
    { key: 'interestCategoryIds', label: 'IDs de categorias de interesse (avançado)', type: 'stringList', step: 'adGroup', group: 'Público', itemPattern: ID_PATTERN, maxItems: 50,
      help: 'Um ID numérico por linha, conforme a lista de interesses do TikTok.' },
    { key: 'audienceIds', label: 'IDs de públicos personalizados (avançado)', type: 'stringList', step: 'adGroup', group: 'Público', itemPattern: ID_PATTERN, maxItems: 50,
      help: 'Um ID numérico por linha (públicos criados no TikTok).' },

    // Orçamento e agenda
    { key: 'budgetMode', label: 'Tipo de orçamento', type: 'enum', step: 'adGroup', group: 'Orçamento e agenda', default: 'BUDGET_MODE_DAY',
      options: [{ value: 'BUDGET_MODE_DAY', label: 'Diário' }, { value: 'BUDGET_MODE_TOTAL', label: 'Total (vitalício)' }],
      showWhen: { 'campaign.budgetMode': ['BUDGET_MODE_INFINITE'] } },
    { key: 'budget', label: 'Valor do orçamento', type: 'money', step: 'adGroup', group: 'Orçamento e agenda', min: 1, max: 100_000_000,
      showWhen: { 'campaign.budgetMode': ['BUDGET_MODE_INFINITE'] }, requiredWhen: { 'campaign.budgetMode': ['BUDGET_MODE_INFINITE'] } },
    { key: 'scheduleType', label: 'Agenda', type: 'enum', step: 'adGroup', group: 'Orçamento e agenda', default: 'SCHEDULE_FROM_NOW',
      options: [{ value: 'SCHEDULE_FROM_NOW', label: 'Começar imediatamente, sem data final' }, { value: 'SCHEDULE_START_END', label: 'Definir início e fim' }] },
    { key: 'scheduleStart', label: 'Início', type: 'datetime', step: 'adGroup', group: 'Orçamento e agenda',
      showWhen: { 'adGroup.scheduleType': ['SCHEDULE_START_END'] }, requiredWhen: { 'adGroup.scheduleType': ['SCHEDULE_START_END'] },
      help: 'No fuso horário da conta de anúncio.' },
    { key: 'scheduleEnd', label: 'Fim', type: 'datetime', step: 'adGroup', group: 'Orçamento e agenda',
      showWhen: { 'adGroup.scheduleType': ['SCHEDULE_START_END'] }, requiredWhen: { 'adGroup.scheduleType': ['SCHEDULE_START_END'] } },

    // Lance e cobrança
    { key: 'billingEvent', label: 'Evento de cobrança', type: 'enum', step: 'adGroup', group: 'Lance e cobrança', required: true,
      optionsBy: { path: 'adGroup.optimizationGoal', map: optionsMap(BILLING_BY_GOAL) } },
    { key: 'bidType', label: 'Estratégia de lance', type: 'enum', step: 'adGroup', group: 'Lance e cobrança', default: 'BID_TYPE_NO_BID',
      options: [{ value: 'BID_TYPE_NO_BID', label: 'Menor custo (automático)' }, { value: 'BID_TYPE_CUSTOM', label: 'Limite de custo / lance manual' }] },
    { key: 'bidPrice', label: 'Valor do lance', type: 'money', step: 'adGroup', group: 'Lance e cobrança', min: 1, max: 100_000_000,
      showWhen: { 'adGroup.bidType': ['BID_TYPE_CUSTOM'] }, requiredWhen: { 'adGroup.bidType': ['BID_TYPE_CUSTOM'] } },
    { key: 'pacing', label: 'Ritmo de entrega', type: 'enum', step: 'adGroup', group: 'Lance e cobrança', default: 'PACING_MODE_SMOOTH',
      options: [{ value: 'PACING_MODE_SMOOTH', label: 'Padrão (distribuído ao longo do dia)' }, { value: 'PACING_MODE_FAST', label: 'Acelerado (gasta mais rápido)' }] },
    { key: 'frequency', label: 'Limite de frequência (impressões por pessoa)', type: 'int', step: 'adGroup', group: 'Frequência', min: 1, max: 10,
      showWhen: { 'campaign.objective': ['REACH', 'VIDEO_VIEWS'] } },
    { key: 'frequencyDays', label: 'Em quantos dias', type: 'int', step: 'adGroup', group: 'Frequência', min: 1, max: 7,
      showWhen: { 'campaign.objective': ['REACH', 'VIDEO_VIEWS'] } },
  ],

  ad: [
    { key: 'name', label: 'Nome do anúncio', type: 'string', step: 'ad', required: true, min: 2, max: 100, group: 'Identificação' },
    { key: 'format', label: 'Formato', type: 'enum', step: 'ad', group: 'Criativo', default: 'SINGLE_VIDEO',
      optionsBy: { path: 'campaign.objective', map: AD_FORMATS_BY_OBJECTIVE } },
    { key: 'identityType', perAccount: true, label: 'Tipo de identidade', type: 'enum', step: 'ad', group: 'Identidade', default: 'CUSTOMIZED_USER', required: true,
      options: [
        { value: 'CUSTOMIZED_USER', label: 'Identidade personalizada' }, { value: 'AUTH_CODE', label: 'Conta do TikTok (código de autorização)' },
        { value: 'TT_USER', label: 'Conta do TikTok vinculada' }, { value: 'BC_AUTH_TT', label: 'Conta do TikTok da Business Center' },
      ] },
    { key: 'identityId', perAccount: true, label: 'ID da identidade', type: 'string', step: 'ad', group: 'Identidade', required: true, pattern: MEDIA_ID_PATTERN, patternMessage: 'Use letras, números, _ ou - (4 a 100 caracteres).', max: 100 },
    { key: 'displayName', label: 'Nome exibido (identidade personalizada)', type: 'string', step: 'ad', group: 'Identidade', min: 1, max: 40, showWhen: { 'ad.identityType': ['CUSTOMIZED_USER'] } },
    // Criativos vêm da BIBLIOTECA do usuário (ids inteiros). No momento da publicação o servidor envia o arquivo ao TikTok
    // (ou reaproveita o envio anterior para a mesma conta de anúncio) e usa o ID que o TikTok devolver.
    { key: 'videoCreativeId', label: 'Vídeo', type: 'creative', creativeKind: 'video', step: 'ad', group: 'Criativo',
      showWhen: { 'ad.format': ['SINGLE_VIDEO'] }, requiredWhen: { 'ad.format': ['SINGLE_VIDEO'] }, help: 'Escolha um vídeo da sua biblioteca de criativos.' },
    { key: 'coverCreativeId', label: 'Imagem de capa (opcional)', type: 'creative', creativeKind: 'image', step: 'ad', group: 'Criativo',
      showWhen: { 'ad.format': ['SINGLE_VIDEO'] },
      requiredWhen: { 'campaign.objective': CATALOG, 'ad.format': ['SINGLE_VIDEO'] }, help: 'Em campanha de catálogo a capa é obrigatória.' },
    // Produtos do catálogo que o anúncio mostra (Catalog Ads: product_specific_type)
    { key: 'productSpecificType', label: 'Produtos do anúncio', type: 'enum', step: 'ad', group: 'Produtos do catálogo', default: 'ALL',
      options: [{ value: 'ALL', label: 'Todos os produtos do catálogo' }, { value: 'PRODUCT_SET', label: 'Um conjunto de produtos' }, { value: 'CUSTOMIZED_PRODUCTS', label: 'Produtos específicos (até 20)' }],
      showWhen: { 'campaign.objective': CATALOG }, help: 'Só entram produtos aprovados e disponíveis (em estoque, sob encomenda ou pré-venda).' },
    { key: 'productSetId', perAccount: true, label: 'ID do conjunto de produtos', type: 'string', step: 'ad', group: 'Produtos do catálogo', pattern: ID_PATTERN, patternMessage: 'Use apenas números.', max: 24,
      showWhen: { 'campaign.objective': CATALOG, 'ad.productSpecificType': ['PRODUCT_SET'] }, requiredWhen: { 'campaign.objective': CATALOG, 'ad.productSpecificType': ['PRODUCT_SET'] },
      help: 'Crie conjuntos no menu Catálogo → Conjuntos.' },
    { key: 'skuIds', label: 'SKUs dos produtos', type: 'stringList', lineOnly: true, step: 'ad', group: 'Produtos do catálogo', itemPattern: SKU_PATTERN, maxItems: 20,
      showWhen: { 'campaign.objective': CATALOG, 'ad.productSpecificType': ['CUSTOMIZED_PRODUCTS'] }, requiredWhen: { 'campaign.objective': CATALOG, 'ad.productSpecificType': ['CUSTOMIZED_PRODUCTS'] },
      help: 'Um SKU por linha, exatamente como está no catálogo (de 1 a 20).' },
    { key: 'imageCreativeIds', label: 'Imagens', type: 'creativeList', creativeKind: 'image', step: 'ad', group: 'Criativo', maxItems: 10,
      showWhen: { 'ad.format': ['SINGLE_IMAGE', 'CAROUSEL_ADS'] }, requiredWhen: { 'ad.format': ['SINGLE_IMAGE', 'CAROUSEL_ADS'] },
      help: 'Imagem única: 1 imagem. Carrossel: de 2 a 10, na ordem em que serão exibidas.' },
    { key: 'text', label: 'Texto do anúncio', type: 'string', step: 'ad', group: 'Texto e chamada', required: true, min: 1, max: 100, multiline: true },
    { key: 'callToAction', label: 'Botão de chamada para ação', type: 'enum', step: 'ad', group: 'Texto e chamada', options: toOptions(CALLS_TO_ACTION), help: 'Vazio = sem botão (em campanha de catálogo o botão é obrigatório).',
      requiredWhen: { 'campaign.objective': CATALOG } },
    { key: 'landingPageUrl', label: 'URL de destino', type: 'url', step: 'ad', group: 'Destino', max: 2000, urlSchemes: ['https:', 'http:'],
      showWhen: { 'campaign.objective': WEB_LIKE },
      requiredWhen: { 'campaign.objective': ['TRAFFIC', 'WEB_CONVERSIONS', ...CATALOG] } },
    { key: 'deeplinkUrl', label: 'Deeplink do app', type: 'url', step: 'ad', group: 'Destino', max: 2000, urlSchemes: ['https:', 'http:', '*'],
      showWhen: { 'campaign.objective': ['APP_PROMOTION', 'TRAFFIC'] } },
    { key: 'utmParams', label: 'Parâmetros UTM', type: 'string', step: 'ad', group: 'Destino', max: 300, pattern: /^[\w\-.~%=&+]*$/, patternMessage: 'Use o formato utm_source=tiktok&utm_medium=cpc (sem espaços).',
      showWhen: { 'campaign.objective': WEB_LIKE }, help: 'Adicionados ao final da URL de destino.' },
    { key: 'impressionTrackingUrl', label: 'URL de rastreamento de impressões', type: 'url', step: 'ad', group: 'Rastreamento', max: 2000, urlSchemes: ['https:'] },
    { key: 'clickTrackingUrl', label: 'URL de rastreamento de cliques', type: 'url', step: 'ad', group: 'Rastreamento', max: 2000, urlSchemes: ['https:'] },
  ],
};

export const SECTION_KEYS = Object.keys(FIELDS);

/** Campos que dependem da conta de anúncio (IDs do TikTok): podem receber valores próprios em cada conta na publicação. */
export const ACCOUNT_FIELDS = SECTION_KEYS.flatMap((section) => FIELDS[section].filter((f) => f.perAccount).map((f) => `${section}.${f.key}`));

// ---------------------------------------------------------------------------
// Utilitários (puros)
// ---------------------------------------------------------------------------
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

export function getPath(config, path) {
  let current = config;
  for (const key of path.split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Condição de visibilidade/obrigatoriedade: { 'caminho': [valores] } (todas precisam bater, E) ou uma LISTA de condições
 * (basta uma bater, OU), ex.: pixel em Conversões no site OU em Vendas de produtos com meta de conversão.
 */
const matches = (cond, config) => !cond || (Array.isArray(cond) ? cond.some((c) => matches(c, config)) : Object.entries(cond).every(([path, allowed]) => allowed.includes(getPath(config, path))));

export const isVisible = (field, config) => matches(field.showWhen, config) && !(field.hideWhen && matches(field.hideWhen, config));
export const isRequired = (field, config) => Boolean(field.required) || (field.requiredWhen !== undefined && matches(field.requiredWhen, config));

export function getOptions(field, config) {
  if (field.optionsBy) return field.optionsBy.map[getPath(config, field.optionsBy.path)] ?? [];
  return field.options ?? [];
}

export const findField = (section, key) => FIELDS[section]?.find((f) => f.key === key);
export const stepOfPath = (path) => {
  const [section, key] = path.split('.');
  return findField(section, key)?.step ?? null;
};
export const fieldsOfStep = (stepId) => SECTION_KEYS.flatMap((section) => FIELDS[section].filter((f) => f.step === stepId).map((field) => ({ section, field })));

/** Config com os valores padrão dos campos (sem dados do usuário). */
export function defaultConfig() {
  const config = {};
  for (const section of SECTION_KEYS) {
    config[section] = {};
    for (const field of FIELDS[section]) if (field.default !== undefined) config[section][field.key] = field.default;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Conversão de tipos (valor bruto -> valor tipado). Retorna { value } ou { error }.
// ---------------------------------------------------------------------------
function parseUrl(raw, field) {
  if (typeof raw !== 'string') return { error: 'Informe uma URL válida.' };
  const text = raw.trim();
  if (text.length > (field.max ?? 2000)) return { error: `A URL deve ter no máximo ${field.max ?? 2000} caracteres.` };
  if (CONTROL_CHARS.test(text) || /\s/.test(text)) return { error: 'A URL não pode conter espaços ou caracteres de controle.' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'Informe uma URL válida, incluindo https://.' };
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return { error: 'Esse tipo de endereço não é permitido.' };
  const allowed = field.urlSchemes ?? ['https:', 'http:'];
  if (!allowed.includes('*') && !allowed.includes(url.protocol)) {
    return { error: `Use uma URL ${allowed.map((s) => s.replace(':', '')).join(' ou ')}.` };
  }
  if (url.username || url.password) return { error: 'A URL não pode conter usuário ou senha.' };
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return { error: 'Informe uma URL válida.' };
  return { value: text };
}

/** ID de criativo da biblioteca: inteiro positivo (cabe no int4 do banco). */
const isCreativeId = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 2_147_483_647;

function parseDatetime(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return { error: 'Informe data e hora válidas.' };
  const date = new Date(`${raw}:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 16) !== raw) return { error: 'Informe data e hora válidas.' };
  return { value: raw };
}

function parseValue(field, raw, config) {
  switch (field.type) {
    case 'string': {
      if (typeof raw !== 'string') return { error: 'Texto inválido.' };
      const text = field.multiline ? raw.trim() : raw.trim().replace(/\s+/g, ' ');
      if (CONTROL_CHARS.test(text)) return { error: 'Contém caracteres inválidos.' };
      const min = field.min ?? 1;
      if (text.length < min || text.length > (field.max ?? 200)) return { error: `Deve ter entre ${min} e ${field.max ?? 200} caracteres.` };
      if (field.pattern && !field.pattern.test(text)) return { error: field.patternMessage ?? 'Formato inválido.' };
      return { value: text };
    }
    case 'int':
    case 'money': {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { error: 'Informe um número inteiro válido.' };
      if (raw < (field.min ?? 0) || raw > (field.max ?? Number.MAX_SAFE_INTEGER)) {
        return { error: field.type === 'money' ? 'Informe um valor maior que zero e dentro do limite.' : `Use um valor entre ${field.min} e ${field.max}.` };
      }
      return { value: raw };
    }
    case 'bool':
      return typeof raw === 'boolean' ? { value: raw } : { error: 'Valor inválido.' };
    case 'enum':
    case 'objective': {
      if (typeof raw !== 'string') return { error: 'Opção inválida.' };
      if (getOptions(field, config).some((o) => o.value === raw)) return { value: raw };
      // "Obsoleto" = já foi uma opção válida para OUTRO valor do campo pai (a pessoa mudou o objetivo): descarta sem erro. Um valor que nunca
      // existiu em nenhuma lista é erro de verdade (nunca é trocado em silêncio pelo padrão).
      const wasValid = field.optionsBy ? Object.values(field.optionsBy.map).some((list) => list.some((o) => o.value === raw)) : false;
      return { error: 'Opção inválida.', stale: wasValid };
    }
    case 'enumList': {
      if (!Array.isArray(raw) || raw.length > (field.maxItems ?? 50)) return { error: 'Seleção inválida.' };
      const allowed = new Set(getOptions(field, config).map((o) => o.value));
      if (!raw.every((v) => typeof v === 'string' && allowed.has(v))) return { error: 'Seleção inválida.' };
      return { value: [...new Set(raw)] };
    }
    case 'stringList': {
      if (!Array.isArray(raw) || raw.length > (field.maxItems ?? 50)) return { error: `No máximo ${field.maxItems ?? 50} itens.` };
      const items = raw.map((v) => (typeof v === 'string' ? v.trim() : v));
      if (!items.every((v) => typeof v === 'string' && field.itemPattern.test(v))) return { error: 'Algum item está em formato inválido.' };
      return { value: [...new Set(items)] };
    }
    case 'creative': {
      if (!isCreativeId(raw)) return { error: 'Criativo inválido.' };
      return { value: raw };
    }
    case 'creativeList': {
      if (!Array.isArray(raw) || raw.length > (field.maxItems ?? 10) || !raw.every(isCreativeId)) return { error: 'Seleção de criativos inválida.' };
      return { value: [...new Set(raw)] };
    }
    case 'datetime':
      return parseDatetime(raw);
    case 'url':
      return parseUrl(raw, field);
    default:
      return { error: 'Campo desconhecido.' };
  }
}

// ---------------------------------------------------------------------------
// Regras entre campos
// ---------------------------------------------------------------------------
const CROSS_RULES = [
  (c, err) => {
    const { scheduleType, scheduleStart, scheduleEnd } = c.adGroup;
    if (scheduleType === 'SCHEDULE_START_END' && scheduleStart && scheduleEnd && scheduleEnd <= scheduleStart) {
      err('adGroup.scheduleEnd', 'O fim deve ser depois do início.');
    }
  },
  (c, err) => {
    if (c.adGroup.budgetMode === 'BUDGET_MODE_TOTAL' && c.adGroup.scheduleType !== 'SCHEDULE_START_END' && isVisible(findField('adGroup', 'budgetMode'), c)) {
      err('adGroup.scheduleType', 'Orçamento total exige data de início e fim.');
    }
    if (c.campaign.budgetMode === 'BUDGET_MODE_TOTAL' && c.adGroup.scheduleType !== 'SCHEDULE_START_END') {
      err('adGroup.scheduleType', 'Orçamento total na campanha exige data de início e fim no grupo de anúncios.');
    }
  },
  (c, err) => {
    const { frequency, frequencyDays } = c.adGroup;
    if ((frequency === undefined) !== (frequencyDays === undefined)) {
      err(frequency === undefined ? 'adGroup.frequency' : 'adGroup.frequencyDays', 'Informe a frequência e o período juntos (ou deixe ambos vazios).');
    }
  },
  // ----- Campanha de catálogo: combinações que o contrato oficial do TikTok exige (Catalog Ads) -----
  (c, err) => {
    if (c.campaign.objective !== 'PRODUCT_SALES') return;
    const g = c.adGroup;
    if (g.optimizationGoal === 'CLICK' && g.billingEvent && g.billingEvent !== 'CPC') err('adGroup.billingEvent', 'Na meta "Cliques" de uma campanha de catálogo a cobrança é CPC.');
    if (g.optimizationGoal && g.optimizationGoal !== 'CLICK' && g.billingEvent && g.billingEvent !== 'OCPM') err('adGroup.billingEvent', 'Nas metas de conversão de uma campanha de catálogo a cobrança é oCPM.');
    if (g.optimizationGoal === 'VALUE') {
      if (g.optimizationEvent && g.optimizationEvent !== 'SHOPPING') err('adGroup.optimizationEvent', 'Na meta de valor (ROAS) de uma campanha de catálogo o evento é "Compra (geral)".');
      if (g.bidType === 'BID_TYPE_CUSTOM') err('adGroup.bidType', 'Na meta de valor (ROAS) de uma campanha de catálogo a estratégia é "Menor custo (automático)".');
    }
    if (g.bidType === 'BID_TYPE_NO_BID' && g.pacing === 'PACING_MODE_FAST') err('adGroup.pacing', 'Com "Menor custo (automático)" o ritmo de entrega é o padrão.');
    if (g.placementType === 'PLACEMENT_TYPE_NORMAL' && g.placements?.some((p) => p !== 'PLACEMENT_TIKTOK')) err('adGroup.placements', 'Campanha de catálogo só pode exibir no TikTok (sem Pangle).');
    if (c.ad.format === 'CATALOG_VIDEO' && c.ad.identityType && c.ad.identityType !== 'CUSTOMIZED_USER') err('ad.identityType', 'O vídeo do catálogo exige identidade personalizada.');
  },
  (c, err) => {
    const count = c.ad.imageCreativeIds?.length ?? 0;
    if (c.ad.format === 'SINGLE_IMAGE' && count > 1) err('ad.imageCreativeIds', 'Imagem única aceita apenas 1 imagem.');
    if (c.ad.format === 'CAROUSEL_ADS' && count > 0 && count < 2) err('ad.imageCreativeIds', 'O carrossel precisa de 2 a 10 imagens.');
  },
];

// ---------------------------------------------------------------------------
// Validação principal
// ---------------------------------------------------------------------------
/**
 * Valida e normaliza uma configuração de campanha.
 *
 * @param {unknown} raw  entrada não confiável
 * @param {object} [opts]
 * @param {boolean} [opts.requireComplete=false] exige os campos obrigatórios (rascunho = false)
 * @param {string[]} [opts.steps]                limita os erros reportados a essas etapas
 * @returns {{ config: object, errors: {path:string, message:string}[] }}
 *   `config` contém apenas campos conhecidos, válidos e visíveis (o restante é descartado).
 */
export function validateConfig(raw, { requireComplete = false, steps } = {}) {
  const errors = [];
  const input = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) errors.push({ path: '', message: 'Configuração inválida.' });

  // 1) Leitura tipada de todos os campos conhecidos (ignora qualquer chave desconhecida).
  const typed = defaultConfig();
  const parseErrors = {};
  for (const section of SECTION_KEYS) {
    const rawSection = isPlainObject(input[section]) ? input[section] : {};
    for (const field of FIELDS[section]) {
      if (!hasOwn(rawSection, field.key) || isBlank(rawSection[field.key])) continue;
      const result = parseValue(field, rawSection[field.key], typed);
      const path = `${section}.${field.key}`;
      if (result.error) {
        // Valor que deixou de ser válido porque o campo "pai" mudou (ex.: trocou o objetivo): descarta sem erro.
        if (!result.stale) parseErrors[path] = result.error;
        if (result.stale && field.default !== undefined) typed[section][field.key] = field.default; // obsoleto: volta ao padrão do campo
        else delete typed[section][field.key];
      } else {
        typed[section][field.key] = result.value;
      }
    }
  }

  // 2) Revalida campos dependentes na ordem de declaração (opções dependem de valores já lidos).
  for (const section of SECTION_KEYS) {
    for (const field of FIELDS[section]) {
      const path = `${section}.${field.key}`;
      const value = typed[section][field.key];
      if (!isVisible(field, typed)) {
        // Campo oculto: descarta o valor (e qualquer erro dele), mantendo o padrão se existir.
        if (field.default !== undefined) typed[section][field.key] = field.default;
        else delete typed[section][field.key];
        delete parseErrors[path];
        continue;
      }
      if (field.optionsBy && value !== undefined && !getOptions(field, typed).some((o) => o.value === value)) {
        if (field.default !== undefined) typed[section][field.key] = field.default; // a opção deixou de existir: volta ao padrão
        else delete typed[section][field.key];
      }
    }
  }

  // 3) Erros de tipo e obrigatórios.
  for (const [path, message] of Object.entries(parseErrors)) errors.push({ path, message });
  for (const section of SECTION_KEYS) {
    for (const field of FIELDS[section]) {
      const path = `${section}.${field.key}`;
      if (!isVisible(field, typed) || !isBlank(typed[section][field.key])) continue;
      if (requireComplete && isRequired(field, typed)) errors.push({ path, message: 'Campo obrigatório.' });
    }
  }

  // 4) Regras entre campos.
  CROSS_RULES.forEach((rule) => rule(typed, (path, message) => errors.push({ path, message })));

  const scoped = steps ? errors.filter((e) => e.path === '' || steps.includes(stepOfPath(e.path))) : errors;
  const seen = new Set();
  const unique = scoped.filter((e) => (seen.has(e.path) ? false : seen.add(e.path)));
  return { config: typed, errors: unique };
}

/**
 * Poda LEVE para o formulário: remove só o que ficou oculto ou deixou de ser uma opção válida depois
 * de uma mudança de escolha. NÃO faz validação de tipo, então nada do que o usuário está digitando é apagado.
 */
export function reconcileConfig(config) {
  const next = {};
  for (const section of SECTION_KEYS) next[section] = isPlainObject(config?.[section]) ? { ...config[section] } : {};
  for (const section of SECTION_KEYS) {
    for (const field of FIELDS[section]) {
      const value = next[section][field.key];
      if (!isVisible(field, next)) {
        if (field.default !== undefined) next[section][field.key] = field.default;
        else delete next[section][field.key];
      } else if (value !== undefined && field.optionsBy && !getOptions(field, next).some((o) => o.value === value)) {
        if (field.default !== undefined) next[section][field.key] = field.default;
        else delete next[section][field.key];
      }
    }
  }
  return next;
}

/** Remove valores ocultos/obsoletos E inválidos (validação completa dos tipos). */
export function pruneConfig(config) {
  return validateConfig(config).config;
}

/**
 * Aplica ajustes POR CONTA sobre a configuração da campanha (publicar a mesma campanha em contas diferentes).
 * `rawOverrides` = { adGroup: { pixelId: '…' }, ad: { identityId: '…' } }. Só os campos `perAccount` são aceitos; qualquer
 * outro caminho é erro e NUNCA altera o resto da campanha. Valor vazio significa "sem ajuste" (vale o da campanha).
 * O resultado (`config`) ainda precisa passar por validateConfig.
 * @returns {{ config: object, overrides: object, errors: {path:string, message:string}[] }}  `overrides` já saneado
 */
export function applyAccountOverrides(base, rawOverrides) {
  const config = {};
  for (const section of SECTION_KEYS) config[section] = { ...(isPlainObject(base?.[section]) ? base[section] : {}) };
  const overrides = {};
  const errors = [];
  if (rawOverrides === undefined || rawOverrides === null) return { config, overrides, errors };
  if (!isPlainObject(rawOverrides)) return { config, overrides, errors: [{ path: 'overrides', message: 'Ajustes por conta inválidos.' }] };
  for (const [section, values] of Object.entries(rawOverrides)) {
    if (!isPlainObject(values)) {
      errors.push({ path: `overrides.${section}`, message: 'Ajustes por conta inválidos.' });
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      const path = `${section}.${key}`;
      if (!ACCOUNT_FIELDS.includes(path)) {
        errors.push({ path: `overrides.${path}`, message: 'Este campo não pode ser ajustado por conta.' });
        continue;
      }
      if (isBlank(value) || (typeof value === 'string' && !value.trim())) continue;
      if (typeof value !== 'string') {
        errors.push({ path, message: 'Texto inválido.' });
        continue;
      }
      (overrides[section] ??= {})[key] = value.trim();
      config[section][key] = value.trim();
    }
  }
  return { config, overrides, errors };
}

// ---------------------------------------------------------------------------
// Apresentação (revisão)
// ---------------------------------------------------------------------------
export function formatValue(field, value, config) {
  if (isBlank(value)) return '—';
  const labelOf = (v) => getOptions(field, config).find((o) => o.value === v)?.label ?? v;
  switch (field.type) {
    case 'bool': return value ? 'Sim' : 'Não';
    case 'enum':
    case 'objective': return labelOf(value);
    case 'enumList': return value.map(labelOf).join(', ');
    case 'stringList': return value.join(', ');
    case 'creative': return `Criativo #${value}`;
    case 'creativeList': return value.map((v) => `#${v}`).join(', ');
    case 'money': return (value / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'datetime': return value.replace('T', ' ');
    default: return String(value);
  }
}

/** Resumo para a listagem: nome, objetivo e orçamento diário (em centavos) derivados da configuração. */
export function summarize(config) {
  const { campaign, adGroup } = config;
  let dailyBudget = 0;
  if (campaign.budgetMode === 'BUDGET_MODE_DAY') dailyBudget = campaign.budget ?? 0;
  else if (campaign.budgetMode === 'BUDGET_MODE_INFINITE' && adGroup.budgetMode === 'BUDGET_MODE_DAY') dailyBudget = adGroup.budget ?? 0;
  return { name: campaign.name, objective: campaign.objective, dailyBudget };
}

/**
 * Criativos da biblioteca referenciados pela configuração (apenas campos visíveis).
 * Usado pelo servidor para checar dono/tipo e para enviar os arquivos ao TikTok na publicação.
 * @returns {{ path: string, id: number, kind: 'image'|'video' }[]}
 */
export function collectCreativeRefs(config) {
  const refs = [];
  for (const field of FIELDS.ad) {
    if (field.type !== 'creative' && field.type !== 'creativeList') continue;
    if (!isVisible(field, config)) continue;
    const value = getPath(config, `ad.${field.key}`);
    const ids = field.type === 'creative' ? (value === undefined ? [] : [value]) : (value ?? []);
    ids.forEach((id, index) => refs.push({ path: field.type === 'creative' ? `ad.${field.key}` : `ad.${field.key}.${index}`, id, kind: field.creativeKind, field: field.key }));
  }
  return refs;
}
