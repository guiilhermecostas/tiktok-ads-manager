/**
 * Produto da tela/CSV (já validado por `normalizeProduct`) → item de `products` em `/catalog/product/upload/` (catálogo E-commerce).
 * Os nomes e o aninhamento seguem a documentação oficial v1.3: product_detail, price_info, landing_page.
 * Função pura. Só inclui chaves com valor (o TikTok recusa lista vazia e texto em branco).
 */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));

export function toTikTokProduct(product) {
  return compact({
    sku_id: product.skuId,
    title: product.title,
    description: product.description,
    availability: product.availability,
    brand: product.brand,
    image_url: product.imageUrl,
    additional_image_urls: product.additionalImageUrls,
    video_url: product.videoUrl,
    item_group_id: product.itemGroupId,
    google_product_category: product.googleProductCategory,
    global_trade_item_number: product.gtin,
    manufacturer_part_number: product.mpn,
    product_detail: compact({
      condition: product.condition,
      age_group: product.ageGroup,
      color: product.color,
      gender: product.gender,
      material: product.material,
      pattern: product.pattern,
      product_category: product.productCategory,
      size: product.size,
    }),
    // A moeda não é enviada: "se não for informada, vale a moeda do país do catálogo" (documentação oficial).
    price_info: compact({ price: product.price, sale_price: product.salePrice }),
    landing_page: { landing_page_url: product.landingPageUrl },
  });
}
