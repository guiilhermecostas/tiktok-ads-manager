/**
 * Eventos de conversão do pixel (web), conforme a tabela oficial do TikTok "Supported Pixel events": o valor da primeira coluna é o que vai em
 * `optimization_event` no grupo de anúncios e em `event_type` ao criar o evento no pixel. Fonte ÚNICA usada pelo servidor (validação) e pela tela.
 * IMPORTANTE: o evento só funciona se JÁ EXISTIR no pixel (Gerenciador de Eventos); caso contrário o TikTok recusa o grupo de anúncios com
 * "This pixel event type does not exist".
 */

/** [valor, rótulo curto, nome do evento no pixel (o que o site envia)] */
export const PIXEL_EVENTS = Object.freeze([
  ['SHOPPING', 'Compra (geral)', 'Purchase'],
  ['INITIATE_ORDER', 'Início de pedido', 'InitiateCheckout'],
  ['ON_WEB_CART', 'Adicionar ao carrinho', 'AddToCart'],
  ['ADD_BILLING', 'Dados de pagamento adicionados', 'AddPaymentInfo'],
  ['ON_WEB_DETAIL', 'Ver conteúdo', 'ViewContent'],
  ['FORM', 'Envio de formulário', 'Lead'],
  ['ON_WEB_REGISTER', 'Cadastro', 'CompleteRegistration'],
  ['ON_WEB_SUBSCRIBE', 'Assinatura', 'Subscribe'],
  ['ON_WEB_SEARCH', 'Busca', 'Search'],
  ['ON_WEB_ADD_TO_WISHLIST', 'Lista de desejos', 'AddToWishlist'],
  ['CONSULT', 'Contato', 'Contact'],
  ['DOWNLOAD_START', 'Download', 'Download'],
]);

export const PIXEL_EVENT_VALUES = Object.freeze(PIXEL_EVENTS.map(([value]) => value));

/**
 * Valores que versões antigas do assistente ofereciam e que NÃO existem no TikTok (campanhas e configurações salvas com eles são corrigidas
 * sozinhas): "Pagamento concluído" é a Compra (`SHOPPING`) e "Adicionar ao carrinho" é `ON_WEB_CART`.
 */
export const LEGACY_PIXEL_EVENTS = Object.freeze({ COMPLETE_PAYMENT: 'SHOPPING', ADD_TO_CART: 'ON_WEB_CART' });

/** Rótulo em português do evento (o próprio valor, se não for conhecido). */
export const pixelEventLabel = (value) => PIXEL_EVENTS.find(([v]) => v === value)?.[1] ?? String(value ?? '');

export const isPixelEvent = (value) => PIXEL_EVENT_VALUES.includes(value);

/** Nome do evento (rótulo) que fica no pixel; até 40 caracteres, sem emoji (limite do TikTok). */
export const PIXEL_EVENT_NAME_MAX = 40;
