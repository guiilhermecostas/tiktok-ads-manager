import { MAX_IMPORT_PRODUCTS, normalizeProduct } from './catalog.js';

/**
 * Geração de produtos em lote para o catálogo: a pessoa informa UMA vez nome, link, preço, marca, imagem e a quantidade, e o sistema monta
 * todos os produtos (cada um com SKU próprio e título numerado), já validados pelas MESMAS regras do envio (`normalizeProduct`). O servidor
 * valida de novo cada produto ao receber. Módulo isomórfico: não depende de Node nem do DOM (o sufixo aleatório do SKU vem de quem chama).
 */
export const MAX_BULK_PRODUCTS = MAX_IMPORT_PRODUCTS;
export const BULK_NAME_MAX = 120; // o título final (nome + número) fica bem abaixo dos 500 caracteres do TikTok
export const BULK_TAG_RE = /^[a-z0-9]{4,12}$/;
const SKU_BASE_MAX = 60; // SKU final: base + "-" + sufixo + "-" + número, sempre dentro dos 100 caracteres do TikTok
const COUNT_RE = /^\d{1,5}$/;

/** "05 - US - Dezy Agência" → "05-US-DEZY-AGENCIA" (só letras, números e hífen; sem acento nem emoji). */
export function skuBase(name) {
  const text = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SKU_BASE_MAX).replace(/-+$/g, '');
  return text || 'PRODUTO';
}

/** Como fica o primeiro produto (título e SKU de exemplo) para a tela mostrar enquanto a pessoa digita; `null` se faltar o nome. */
export function previewProduct(name, startAt) {
  const text = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!text || text.length > BULK_NAME_MAX) return null;
  const start = COUNT_RE.test(String(startAt ?? '').trim()) ? Number(String(startAt).trim()) : 1;
  return { title: `${text} · ${start}`, skuId: `${skuBase(text)}-…-${start}` };
}

/**
 * `input`: { name, count, startAt?, price, brand, description?, imageUrl, landingPageUrl }; `tag`: sufixo único desta geração (evita que uma
 * segunda geração com o mesmo nome sobrescreva os produtos da primeira). Devolve `{ products, errors }`; `errors`: [{ path, message }].
 * Sem erro, `products` tem exatamente `count` produtos, todos válidos e com SKU diferente.
 */
export function generateProducts(input, tag) {
  const errors = [];
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fail = (path, message) => errors.push({ path, message });

  const name = typeof raw.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) fail('name', 'Informe o nome base dos produtos.');
  else if (name.length > BULK_NAME_MAX) fail('name', `Use até ${BULK_NAME_MAX} caracteres.`);

  const countText = String(raw.count ?? '').trim();
  const count = COUNT_RE.test(countText) ? Number(countText) : 0;
  if (!count || count > MAX_BULK_PRODUCTS) fail('count', `Informe de 1 a ${MAX_BULK_PRODUCTS} produtos.`);

  const startText = String(raw.startAt ?? '').trim();
  const startAt = startText === '' ? 1 : (COUNT_RE.test(startText) ? Number(startText) : -1);
  if (startAt < 0) fail('startAt', 'Informe um número inteiro de 0 em diante.');

  if (typeof tag !== 'string' || !BULK_TAG_RE.test(tag)) fail('tag', 'Identificador da geração inválido.');

  const base = skuBase(name);
  const build = (n) => ({
    skuId: `${base}-${tag}-${n}`,
    title: `${name} · ${n}`,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description : name,
    brand: raw.brand,
    imageUrl: raw.imageUrl,
    landingPageUrl: raw.landingPageUrl,
    condition: 'NEW',
    price: raw.price,
    availability: 'IN_STOCK',
  });
  const validate = (n) => normalizeProduct(build(n)).errors.map((e) => ({ path: ['skuId', 'title'].includes(e.path) ? 'name' : e.path, message: e.message }));

  // Todos os campos são conferidos de uma vez (a pessoa vê tudo o que falta, não um erro por tentativa). Os campos comuns são iguais em todos
  // os produtos, então um produto de amostra basta; cada produto gerado ainda passa pela validação completa abaixo.
  const probe = validate(Math.max(startAt, 0));
  const usesName = !(typeof raw.description === 'string' && raw.description.trim()); // descrição em branco = nome base: o erro já é o do nome
  for (const e of probe) if (!(usesName && e.path === 'description') && !errors.some((x) => x.path === e.path)) errors.push(e);
  if (errors.length) return { products: [], errors };

  const products = [];
  for (let i = 0; i < count; i += 1) {
    const { value, errors: found } = normalizeProduct(build(startAt + i));
    if (found.length) return { products: [], errors: found.map((e) => ({ path: ['skuId', 'title'].includes(e.path) ? 'name' : e.path, message: e.message })) };
    products.push(value);
  }
  return { products, errors: [] };
}
