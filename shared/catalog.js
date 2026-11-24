/**
 * Catálogo de produtos (TikTok Catalog API v1.3): regras compartilhadas entre o servidor e a tela.
 * Todos os limites e valores vêm da documentação OFICIAL (`/catalog/create/`, `/catalog/product/upload/`, `/catalog/set/create/`).
 * Módulo isomórfico: não depende de Node nem do DOM.
 */

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
export const CATALOG_NAME_MAX = 128; // "Catalog name. Length limit: 128 characters."
export const CATALOG_TYPE = 'ECOM'; // o único tipo usado em campanhas de Vendas de produtos (os demais — hotel, voo etc. — têm outros esquemas)
export const MAX_PRODUCTS_PER_REQUEST = 500; // a API aceita até 5.000; mandamos em lotes menores (corpo pequeno, erros localizados)
export const MAX_IMPORT_PRODUCTS = 5000; // limite de uma importação pela tela (10 lotes)
export const MAX_BATCH_BYTES = 1_500_000; // o servidor aceita 2 MB por pedido: sobra folga para o restante do corpo
export const MAX_SKU_IDS_PER_AD = 20; // "Specific products with a maximum of 20 products"
export const PRODUCT_SET_NAME_MAX = 128;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // eslint-disable-line no-control-regex
const EMOJI = /\p{Extended_Pictographic}/u;
const REGION_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ID_RE = /^\d{1,24}$/;

export const isCatalogId = (value) => typeof value === 'string' && ID_RE.test(value);

/** Valida e normaliza os dados de um catálogo novo. */
export function normalizeCatalogInput(raw) {
  const errors = [];
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > CATALOG_NAME_MAX) errors.push({ path: 'name', message: `O nome do catálogo deve ter de 2 a ${CATALOG_NAME_MAX} caracteres.` });
  else if (CONTROL_CHARS.test(name)) errors.push({ path: 'name', message: 'O nome contém caracteres inválidos.' });
  const regionCode = typeof input.regionCode === 'string' ? input.regionCode.trim().toUpperCase() : '';
  if (!REGION_RE.test(regionCode)) errors.push({ path: 'regionCode', message: 'Escolha o país de destino do catálogo.' });
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (!CURRENCY_RE.test(currency)) errors.push({ path: 'currency', message: 'Escolha a moeda do catálogo.' });
  return { value: { name, regionCode, currency, catalogType: CATALOG_TYPE }, errors };
}

// ---------------------------------------------------------------------------
// Produto (catálogo E-commerce)
// ---------------------------------------------------------------------------
export const AVAILABILITY = Object.freeze([
  ['IN_STOCK', 'Em estoque'], ['AVAILABLE_FOR_ORDER', 'Disponível para encomenda'], ['PREORDER', 'Pré-venda'],
  ['OUT_OF_STOCK', 'Sem estoque'], ['DISCONTINUED', 'Descontinuado'],
]);
export const CONDITIONS = Object.freeze([['NEW', 'Novo'], ['REFURBISHED', 'Recondicionado'], ['USED', 'Usado']]);
export const GENDERS = Object.freeze([['MALE', 'Masculino'], ['FEMALE', 'Feminino'], ['UNISEX', 'Unissex']]);
export const AGE_GROUPS = Object.freeze([['NEW_BORN', 'Recém-nascido'], ['INFANT', 'Bebê'], ['TODDLER', 'Criança pequena'], ['KIDS', 'Criança'], ['ADULT', 'Adulto']]);
/** Disponibilidade que permite usar o produto em anúncios (documentação de `ad_creation_eligible`). */
export const ADS_AVAILABILITY = Object.freeze(['IN_STOCK', 'AVAILABLE_FOR_ORDER', 'PREORDER']);

const oneOf = (pairs) => new Set(pairs.map(([value]) => value));
const SETS = { availability: oneOf(AVAILABILITY), condition: oneOf(CONDITIONS), gender: oneOf(GENDERS), ageGroup: oneOf(AGE_GROUPS) };

/**
 * Campos do produto como a tela e o CSV os entendem. `max`: limite oficial; `required`: obrigatório pela API.
 * `path`: onde o campo fica no corpo de `/catalog/product/upload/`.
 */
export const PRODUCT_FIELDS = Object.freeze([
  { key: 'skuId', label: 'SKU (ID do produto)', required: true, max: 100, noEmoji: true, path: 'sku_id', help: 'Identificador único do produto no catálogo (ex.: CAMISETA-AZUL-M). Até 100 caracteres, sem emoji.' },
  { key: 'title', label: 'Título', required: true, max: 500, noEmoji: true, path: 'title', help: 'Sem texto promocional como "frete grátis" ou "alta qualidade". Até 500 caracteres.' },
  { key: 'description', label: 'Descrição', required: true, max: 10_000, path: 'description', multiline: true },
  { key: 'availability', label: 'Disponibilidade', required: true, options: AVAILABILITY, path: 'availability' },
  { key: 'brand', label: 'Marca', required: true, max: 150, path: 'brand' },
  { key: 'imageUrl', label: 'Imagem principal (URL)', required: true, url: true, path: 'image_url', help: 'JPG ou PNG de pelo menos 500 × 500 px, acessível publicamente. Imagens menores reprovam o produto.' },
  { key: 'condition', label: 'Condição', required: true, options: CONDITIONS, path: 'product_detail.condition' },
  { key: 'price', label: 'Preço', required: true, money: true, path: 'price_info.price' },
  { key: 'landingPageUrl', label: 'Página do produto (URL)', required: true, url: true, path: 'landing_page.landing_page_url', help: 'Onde o cliente vê e compra o produto.' },
  { key: 'salePrice', label: 'Preço promocional', money: true, path: 'price_info.sale_price' },
  { key: 'additionalImageUrls', label: 'Imagens adicionais (URLs)', urlList: true, maxItems: 10, path: 'additional_image_urls' },
  { key: 'videoUrl', label: 'Vídeo (URL)', url: true, path: 'video_url' },
  { key: 'itemGroupId', label: 'ID do grupo (variações)', max: 100, path: 'item_group_id', help: 'Use o mesmo valor em todas as variações (cor, tamanho) do mesmo produto.' },
  { key: 'googleProductCategory', label: 'Categoria (Google)', max: 250, path: 'google_product_category' },
  { key: 'gtin', label: 'GTIN / código de barras', max: 50, path: 'global_trade_item_number' },
  { key: 'mpn', label: 'MPN (código do fabricante)', max: 70, path: 'manufacturer_part_number' },
  { key: 'color', label: 'Cor', max: 100, path: 'product_detail.color' },
  { key: 'size', label: 'Tamanho', max: 100, path: 'product_detail.size' },
  { key: 'gender', label: 'Gênero', options: GENDERS, path: 'product_detail.gender' },
  { key: 'ageGroup', label: 'Faixa etária', options: AGE_GROUPS, path: 'product_detail.age_group' },
  { key: 'material', label: 'Material', max: 200, path: 'product_detail.material' },
  { key: 'pattern', label: 'Estampa', max: 100, path: 'product_detail.pattern' },
  { key: 'productCategory', label: 'Tipo de produto', max: 250, path: 'product_detail.product_category' },
]);

export const REQUIRED_PRODUCT_KEYS = PRODUCT_FIELDS.filter((f) => f.required).map((f) => f.key);

function parseHttpUrl(text, max = 2000) {
  if (text.length > max || CONTROL_CHARS.test(text) || /\s/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  return text;
}

/** Aceita número, "29.90", "29,90", "1.234,56" e "1,234.56"; devolve número com 2 casas ou null. */
export function parsePrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 && raw < 1e9 ? Math.round(raw * 100) / 100 : null;
  if (typeof raw !== 'string' || /[-−(]/.test(raw)) return null; // valor negativo nunca é preço
  let text = raw.trim().replace(/[A-Za-z]{3}$/, '').replace(/^[A-Za-z]{3}/, '').replace(/[^\d.,]/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (lastComma >= 0) text = /,\d{1,2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value < 1e9 ? Math.round(value * 100) / 100 : null;
}

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

/**
 * Valida e normaliza UM produto no formato da tela/CSV. Devolve `{ value, errors }`; `errors` é uma lista de { path, message }.
 * `value` só tem campos conhecidos e válidos (o resto é descartado).
 */
export function normalizeProduct(raw) {
  const errors = [];
  const value = {};
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const field of PRODUCT_FIELDS) {
    const given = input[field.key];
    const fail = (message) => errors.push({ path: field.key, message });
    if (isBlank(given)) {
      if (field.required) fail('Campo obrigatório.');
      continue;
    }
    if (field.options) {
      const text = typeof given === 'string' ? given.trim().toUpperCase() : '';
      if (!SETS[field.key]?.has(text)) fail('Valor inválido.');
      else value[field.key] = text;
    } else if (field.money) {
      const price = parsePrice(given);
      if (price === null) fail('Informe um valor maior que zero (ex.: 29,90).');
      else value[field.key] = price;
    } else if (field.urlList) {
      const list = Array.isArray(given) ? given : [];
      if (!Array.isArray(given) || list.length > field.maxItems) fail(`No máximo ${field.maxItems} URLs.`);
      else {
        const urls = list.map((u) => (typeof u === 'string' ? parseHttpUrl(u.trim()) : null));
        if (urls.some((u) => u === null)) fail('Alguma URL é inválida (use endereços completos com https://).');
        else value[field.key] = [...new Set(urls)];
      }
    } else if (field.url) {
      const url = typeof given === 'string' ? parseHttpUrl(given.trim()) : null;
      if (!url) fail('Informe uma URL válida, incluindo https://.');
      else value[field.key] = url;
    } else {
      const text = typeof given === 'string' ? (field.multiline ? given.trim() : given.trim().replace(/\s+/g, ' ')) : '';
      if (typeof given !== 'string') fail('Texto inválido.');
      else if (!text || text.length > field.max) fail(`Deve ter até ${field.max} caracteres.`);
      else if (CONTROL_CHARS.test(text)) fail('Contém caracteres inválidos.');
      else if (field.noEmoji && EMOJI.test(text)) fail('Não pode conter emoji.');
      else value[field.key] = text;
    }
  }
  if (value.price !== undefined && value.salePrice !== undefined && value.salePrice >= value.price) errors.push({ path: 'salePrice', message: 'O preço promocional deve ser menor que o preço.' });
  return { value, errors };
}

// ---------------------------------------------------------------------------
// Importação por CSV
// ---------------------------------------------------------------------------
/** Nomes de coluna aceitos (modelo do TikTok, do Google/Meta e os nossos) → campo do produto. */
const COLUMN_ALIASES = {
  skuId: ['sku_id', 'sku', 'id', 'product_id', 'item_id'],
  title: ['title', 'titulo', 'name', 'nome'],
  description: ['description', 'descricao'],
  availability: ['availability', 'disponibilidade', 'stock_status'],
  brand: ['brand', 'marca'],
  imageUrl: ['image_url', 'image_link', 'image', 'imagem', 'main_image'],
  condition: ['condition', 'condicao'],
  price: ['price', 'preco', 'regular_price'],
  landingPageUrl: ['landing_page_url', 'link', 'url', 'product_url', 'landing_url', 'pagina'],
  salePrice: ['sale_price', 'preco_promocional', 'preco_promo'],
  additionalImageUrls: ['additional_image_urls', 'additional_image_link', 'additional_images', 'imagens_adicionais'],
  videoUrl: ['video_url', 'video_link', 'video'],
  itemGroupId: ['item_group_id', 'group_id', 'grupo'],
  googleProductCategory: ['google_product_category', 'categoria_google'],
  gtin: ['gtin', 'global_trade_item_number', 'ean', 'upc'],
  mpn: ['mpn', 'manufacturer_part_number'],
  color: ['color', 'cor'],
  size: ['size', 'tamanho'],
  gender: ['gender', 'genero'],
  ageGroup: ['age_group', 'faixa_etaria'],
  material: ['material'],
  pattern: ['pattern', 'estampa'],
  productCategory: ['product_category', 'product_type', 'categoria', 'tipo_de_produto'],
};
const ALIAS_TO_KEY = new Map(Object.entries(COLUMN_ALIASES).flatMap(([key, names]) => names.map((n) => [n, key])));
const normalizeHeader = (text) => String(text ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]+/g, '_');

/** Valores comuns de feeds ("in stock", "disponível") nos valores oficiais. */
const AVAILABILITY_WORDS = {
  in_stock: 'IN_STOCK', instock: 'IN_STOCK', em_estoque: 'IN_STOCK', disponivel: 'IN_STOCK', available: 'IN_STOCK',
  available_for_order: 'AVAILABLE_FOR_ORDER', preorder: 'PREORDER', pre_order: 'PREORDER', pre_venda: 'PREORDER', backorder: 'AVAILABLE_FOR_ORDER',
  out_of_stock: 'OUT_OF_STOCK', outofstock: 'OUT_OF_STOCK', sem_estoque: 'OUT_OF_STOCK', indisponivel: 'OUT_OF_STOCK', discontinued: 'DISCONTINUED', descontinuado: 'DISCONTINUED',
};
const CONDITION_WORDS = { new: 'NEW', novo: 'NEW', refurbished: 'REFURBISHED', recondicionado: 'REFURBISHED', used: 'USED', usado: 'USED' };
const GENDER_WORDS = { male: 'MALE', masculino: 'MALE', female: 'FEMALE', feminino: 'FEMALE', unisex: 'UNISEX', unissex: 'UNISEX' };
const AGE_WORDS = { newborn: 'NEW_BORN', new_born: 'NEW_BORN', infant: 'INFANT', bebe: 'INFANT', toddler: 'TODDLER', kids: 'KIDS', crianca: 'KIDS', adult: 'ADULT', adulto: 'ADULT' };
const WORDS = { availability: AVAILABILITY_WORDS, condition: CONDITION_WORDS, gender: GENDER_WORDS, ageGroup: AGE_WORDS };

/** Lê CSV (RFC 4180: aspas, aspas duplas, quebras de linha dentro de campo). Detecta o separador (vírgula, ponto e vírgula ou tab). */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Converte o texto de um CSV em produtos validados. Devolve { products, rows, unknownColumns, missingColumns, fatal }.
 *  - `rows[i] = { line, product | null, errors }` (line = número da linha no arquivo, a partir de 2)
 *  - `fatal`: mensagem quando o arquivo não serve (vazio, sem cabeçalho reconhecível, linhas demais)
 */
export function csvToProducts(text, { maxRows = MAX_IMPORT_PRODUCTS } = {}) {
  const table = parseCsv(text);
  if (table.length < 2) return { products: [], rows: [], unknownColumns: [], missingColumns: [], fatal: 'O arquivo precisa ter o cabeçalho e ao menos um produto.' };
  const header = table[0].map(normalizeHeader);
  const keys = header.map((name) => ALIAS_TO_KEY.get(name) ?? null);
  const unknownColumns = table[0].filter((_, i) => keys[i] === null && header[i] !== '');
  const missingColumns = REQUIRED_PRODUCT_KEYS.filter((key) => !keys.includes(key)).map((key) => PRODUCT_FIELDS.find((f) => f.key === key).label);
  if (missingColumns.length) return { products: [], rows: [], unknownColumns, missingColumns, fatal: `Faltam colunas obrigatórias: ${missingColumns.join(', ')}.` };
  if (table.length - 1 > maxRows) return { products: [], rows: [], unknownColumns, missingColumns, fatal: `O arquivo tem produtos demais (máximo ${maxRows} por importação).` };

  const rows = [];
  const products = [];
  const seen = new Set();
  table.slice(1).forEach((cells, index) => {
    const raw = {};
    keys.forEach((key, i) => {
      if (!key) return;
      const cell = (cells[i] ?? '').trim();
      if (cell === '') return;
      const word = WORDS[key];
      if (word) raw[key] = word[normalizeHeader(cell)] ?? cell;
      else if (key === 'additionalImageUrls') raw[key] = cell.split(/[|;\n]|,(?=\s*https?:)/).map((u) => u.trim()).filter(Boolean);
      else raw[key] = cell;
    });
    const { value, errors } = normalizeProduct(raw);
    if (value.skuId !== undefined) {
      if (seen.has(value.skuId)) errors.push({ path: 'skuId', message: 'SKU repetido no arquivo.' });
      seen.add(value.skuId);
    }
    rows.push({ line: index + 2, product: errors.length ? null : value, errors });
    if (!errors.length) products.push(value);
  });
  return { products, rows, unknownColumns, missingColumns: [], fatal: null };
}

/** Modelo de CSV (cabeçalho + uma linha de exemplo) para a pessoa baixar. */
export function csvTemplate() {
  const header = ['sku_id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'brand', 'image_link', 'link', 'additional_image_link', 'item_group_id', 'color', 'size'];
  const example = ['CAMISETA-AZUL-M', 'Camiseta básica azul', 'Camiseta de algodão, corte reto.', 'in stock', 'new', '79.90', '59.90', 'Minha Marca', 'https://exemplo.com/img/camiseta-azul.jpg', 'https://exemplo.com/camiseta-azul', 'https://exemplo.com/img/camiseta-azul-2.jpg', 'CAMISETA-AZUL', 'Azul', 'M'];
  return `${header.join(',')}\n${example.map((c) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')}\n`;
}

// ---------------------------------------------------------------------------
// Conjunto de produtos (`/catalog/set/create/`)
// ---------------------------------------------------------------------------
/**
 * Filtros simples da tela → `conditions` da API (campos e operadores da tabela oficial "Product set operators and fields").
 * `input`: { brands: string[], titleContains: string[], priceMin, priceMax, availability, condition }. Pelo menos um filtro.
 */
export function buildSetConditions(input) {
  const errors = [];
  const rules = [];
  const src = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const list = (value, label, max = 20) => {
    if (isBlank(value)) return [];
    const items = (Array.isArray(value) ? value : [value]).map((v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : v));
    if (items.length > max || items.some((v) => typeof v !== 'string' || !v || v.length > 150 || CONTROL_CHARS.test(v))) {
      errors.push({ path: label, message: `Informe até ${max} valores de até 150 caracteres.` });
      return [];
    }
    return [...new Set(items)];
  };
  const brands = list(src.brands, 'brands');
  if (brands.length) rules.push({ field: 'brand', operation: 'I_CONTAIN', value: brands });
  const words = list(src.titleContains, 'titleContains');
  if (words.length) rules.push({ field: 'title', operation: 'I_WILDCARD', value: words });
  for (const [key, operation] of [['priceMin', 'GTE'], ['priceMax', 'LTE']]) {
    if (isBlank(src[key])) continue;
    const price = parsePrice(src[key]);
    if (price === null) errors.push({ path: key, message: 'Informe um valor maior que zero.' });
    else rules.push({ field: 'price', operation, value: String(price) });
  }
  if (!isBlank(src.priceMin) && !isBlank(src.priceMax) && parsePrice(src.priceMin) > parsePrice(src.priceMax)) errors.push({ path: 'priceMax', message: 'O preço máximo deve ser maior que o mínimo.' });
  if (!isBlank(src.availability)) {
    if (!SETS.availability.has(src.availability)) errors.push({ path: 'availability', message: 'Disponibilidade inválida.' });
    else rules.push({ field: 'availability', operation: 'EQUAL', value: src.availability });
  }
  if (!isBlank(src.condition)) {
    if (!SETS.condition.has(src.condition)) errors.push({ path: 'condition', message: 'Condição inválida.' });
    else rules.push({ field: 'condition', operation: 'EQUAL', value: src.condition });
  }
  if (!rules.length && !errors.length) errors.push({ path: 'conditions', message: 'Escolha ao menos um filtro para o conjunto de produtos.' });
  return { conditions: rules.length ? { and: rules } : null, errors };
}

export function normalizeProductSetName(raw) {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > PRODUCT_SET_NAME_MAX || CONTROL_CHARS.test(name)) return { name: null, error: `O nome do conjunto deve ter de 2 a ${PRODUCT_SET_NAME_MAX} caracteres.` };
  return { name, error: null };
}

/** Divide a fila de envio em lotes de até 500 produtos E ~1,5 MB (descrições longas não estouram o limite do pedido). Mantém a ordem. */
export function toBatches(products, { maxCount = MAX_PRODUCTS_PER_REQUEST, maxBytes = MAX_BATCH_BYTES } = {}) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const product of products) {
    const size = JSON.stringify(product).length;
    if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(product);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}
