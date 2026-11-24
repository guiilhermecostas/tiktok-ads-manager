import { MAX_IMPORT_PRODUCTS, PRODUCT_FIELDS, csvTemplate, csvToProducts, normalizeProduct, toBatches } from '/shared/catalog.js';
import { get, post } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatCurrency, formatNumber } from '../../format.js';
import { alertBox, badge, button, toast } from '../../ui.js';
import { catalogUrl, refQuery } from './detail.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 1500;
const POLL_TRIES = 30;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tabela simples de problemas (cabeçalho + linhas de texto). */
function errorTable(headers, rows) {
  return h('div', { class: 'card table-wrap catalog-add__errors' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, headers.map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, rows.map((cells) => h('tr', null, cells.map((cell) => h('td', null, cell)))))));
}

/**
 * Aba "Adicionar produtos": importa uma planilha CSV ou adiciona um produto pelo formulário, junta tudo numa lista de envio e envia em lotes.
 * Valida no navegador com as MESMAS regras do servidor (shared/catalog.js) e mostra o resultado do processamento do TikTok (novos, atualizados,
 * erros com o motivo). O mesmo SKU enviado de novo atualiza o produto (envio incremental).
 */
export function addProductsTab({ catalog, canWrite, onUploaded }) {
  const queue = new Map(); // SKU -> produto validado
  const root = h('div', { class: 'catalog-add' });
  const csvSlot = h('div');
  const formErrors = new Map();
  const queueSlot = h('div');
  const resultSlot = h('div');
  let sending = false;

  // ---------- CSV ----------
  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob(['\uFEFF', csvTemplate()], { type: 'text/csv;charset=utf-8' }));
    const link = h('a', { href: url, download: 'modelo-catalogo.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function onFile(file, input) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setChildren(csvSlot, alertBox('O arquivo é grande demais (máximo 5 MB). Divida em partes.'));
      input.value = '';
      return;
    }
    const parsed = csvToProducts(await file.text());
    input.value = '';
    if (parsed.fatal) {
      setChildren(csvSlot, alertBox(parsed.fatal));
      return;
    }
    for (const product of parsed.products) queue.set(product.skuId, product);
    drawQueue();
    const bad = parsed.rows.filter((r) => r.errors.length);
    setChildren(csvSlot,
      alertBox(`${formatNumber(parsed.products.length)} ${parsed.products.length === 1 ? 'produto válido foi' : 'produtos válidos foram'} para a lista de envio${bad.length ? `; ${formatNumber(bad.length)} com problema ${bad.length === 1 ? 'ficou' : 'ficaram'} de fora (veja abaixo)` : ''}.`, bad.length ? 'warning' : 'success'),
      parsed.unknownColumns.length ? h('p', { class: 'field__hint' }, `Colunas ignoradas: ${parsed.unknownColumns.join(', ')}.`) : null,
      bad.length ? errorTable(['Linha', 'Problema'], bad.slice(0, 20).map((r) => [String(r.line), r.errors.map((e) => `${PRODUCT_FIELDS.find((f) => f.key === e.path)?.label ?? e.path}: ${e.message}`).join(' · ')])) : null,
      bad.length > 20 ? h('p', { class: 'muted catalog-add__more' }, `… e mais ${bad.length - 20} linhas com problema.`) : null);
  }

  // ---------- formulário de um produto ----------
  const controls = new Map();
  function buildField(f) {
    const id = `prod-${f.key}`;
    const common = { id, class: 'input', autocomplete: 'off' };
    let control;
    if (f.options) control = h('select', common, h('option', { value: '' }, 'Escolha…'), f.options.map(([value, label]) => h('option', { value }, label)));
    else if (f.urlList) control = h('textarea', { ...common, class: 'input input--area', rows: 2, placeholder: 'Uma URL por linha (até 10)' });
    else if (f.multiline) control = h('textarea', { ...common, class: 'input input--area', rows: 3, maxlength: f.max });
    else control = h('input', { ...common, type: 'text', maxlength: f.url ? 2000 : f.max, inputmode: f.money ? 'decimal' : null, placeholder: f.url ? 'https://' : f.money ? '0,00' : null });
    controls.set(f.key, control);
    const err = h('p', { class: 'field__error', role: 'alert', hidden: true });
    formErrors.set(f.key, err);
    return h('div', { class: `field${f.multiline || f.urlList || f.url ? ' field--wide' : ''}` },
      h('label', { for: id, class: 'field__label' }, f.label, f.required ? ' *' : ''), control,
      f.help ? h('p', { class: 'field__hint' }, f.help) : null, err);
  }
  const requiredFields = PRODUCT_FIELDS.filter((f) => f.required).map(buildField);
  const optionalFields = PRODUCT_FIELDS.filter((f) => !f.required).map(buildField);

  function readForm() {
    const raw = {};
    for (const f of PRODUCT_FIELDS) {
      const v = controls.get(f.key).value;
      raw[f.key] = f.urlList ? v.split(/\n+/).map((u) => u.trim()).filter(Boolean) : v;
    }
    return raw;
  }
  function addFromForm(event) {
    event.preventDefault();
    for (const e of formErrors.values()) {
      e.hidden = true;
      e.textContent = '';
    }
    const { value, errors } = normalizeProduct(readForm());
    if (errors.length) {
      for (const e of errors) {
        const slot = formErrors.get(e.path);
        if (slot) {
          slot.textContent = e.message;
          slot.hidden = false;
        }
      }
      controls.get(errors[0].path)?.focus();
      return;
    }
    const replaced = queue.has(value.skuId);
    queue.set(value.skuId, value);
    for (const c of controls.values()) c.value = '';
    drawQueue();
    toast(replaced ? 'Produto atualizado na lista (mesmo SKU).' : 'Produto adicionado à lista de envio.');
    controls.get('skuId').focus();
  }

  // ---------- lista de envio ----------
  function drawQueue() {
    const products = [...queue.values()];
    setChildren(queueSlot,
      h('h3', { class: 'form-section__title' }, `Lista de envio (${formatNumber(products.length)})`),
      products.length
        ? h('div', { class: 'card table-wrap catalog-add__queue' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['SKU', 'Produto', 'Preço', 'Estoque', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, products.slice(0, 100).map((p) => h('tr', null,
            h('td', null, h('span', { class: 'cell-strong' }, p.skuId)), h('td', null, p.title), h('td', { class: 'num' }, formatCurrency(p.price, catalog.currency ?? 'USD')), h('td', null, p.availability),
            h('td', null, button('Remover', { small: true, disabled: sending, ariaLabel: `Remover ${p.skuId}`, onClick: () => { queue.delete(p.skuId); drawQueue(); } }))))),
          ))
        : h('p', { class: 'muted' }, 'Importe uma planilha ou adicione produtos pelo formulário. Eles aparecem aqui antes do envio.'),
      products.length > 100 ? h('p', { class: 'muted catalog-add__more' }, `… e mais ${formatNumber(products.length - 100)} produtos (todos serão enviados).`) : null,
      products.length ? h('div', { class: 'catalog-add__send' },
        button(sending ? 'Enviando…' : `Enviar ${formatNumber(products.length)} ${products.length === 1 ? 'produto' : 'produtos'} ao TikTok`, { variant: 'primary', disabled: sending || !canWrite, onClick: send }),
        button('Limpar lista', { disabled: sending, onClick: () => { queue.clear(); drawQueue(); } })) : null);
  }

  async function pollLog(feedLogId) {
    for (let i = 0; i < POLL_TRIES; i += 1) {
      if (!root.isConnected) return null;
      try {
        const log = await get(`${catalogUrl(catalog, `/logs/${encodeURIComponent(feedLogId)}`)}?${refQuery(catalog)}`);
        if (['SUCCESS', 'FAILED'].includes(log.status)) return log;
      } catch {
        /* tenta de novo */
      }
      await sleep(POLL_MS);
    }
    return null;
  }

  async function send() {
    if (sending || !queue.size) return;
    sending = true;
    drawQueue();
    const batches = toBatches([...queue.values()]);
    const total = { add: 0, update: 0, errors: 0, warn: 0, pending: 0, problems: [] };
    let sent = 0;
    let failure = null;
    for (const [index, batch] of batches.entries()) {
      setChildren(resultSlot, alertBox(`Enviando lote ${index + 1} de ${batches.length}…`, 'warning'));
      try {
        const res = await post(catalogUrl(catalog, '/products'), { connectionId: catalog.connectionId, bcId: catalog.bcId, products: batch });
        for (const p of batch) queue.delete(p.skuId);
        sent += batch.length;
        const log = await pollLog(res.feedLogId);
        if (!log) {
          total.pending += batch.length;
        } else {
          total.add += log.addCount;
          total.update += log.updateCount;
          total.errors += log.errorCount;
          total.warn += log.warnCount;
          total.problems.push(...log.errors.map((e) => ({ ...e, level: 'erro' })), ...log.warnings.map((e) => ({ ...e, level: 'aviso' })));
        }
      } catch (err) {
        failure = err.message;
        break;
      }
    }
    sending = false;
    drawQueue();
    if (sent) onUploaded?.();
    setChildren(resultSlot,
      sent ? alertBox(`${formatNumber(sent)} ${sent === 1 ? 'produto enviado' : 'produtos enviados'}: ${formatNumber(total.add)} novos, ${formatNumber(total.update)} atualizados${total.errors ? `, ${formatNumber(total.errors)} com erro` : ''}${total.pending ? `; ${formatNumber(total.pending)} ainda em processamento no TikTok` : ''}. A aprovação pode levar alguns minutos.`, total.errors ? 'warning' : 'success') : null,
      failure ? alertBox(`O envio parou: ${failure}${queue.size ? ` Os ${formatNumber(queue.size)} produtos restantes continuam na lista.` : ''}`) : null,
      total.problems.length ? errorTable(['', 'Campo', 'Problema', 'Como resolver', 'Produtos'], total.problems.slice(0, 20).map((p) => [
        badge(p.level, p.level === 'erro' ? 'danger' : 'warning'), p.field ?? '—', p.issue ?? '—', p.suggestion ?? '—',
        `${formatNumber(p.count)}${p.items.length ? ` (${p.items.map((i) => i.skuId ?? `linha ${i.index}`).join(', ')}${p.count > p.items.length ? '…' : ''})` : ''}`,
      ])) : null);
  }

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', class: 'catalog-add__file', 'aria-label': 'Escolher planilha CSV', disabled: !canWrite, onChange: (e) => onFile(e.target.files[0], e.target) });
  setChildren(root,
    h('div', { class: 'card card--pad catalog-add__intro' },
      h('p', null, 'Cada produto precisa de SKU, título, descrição, estoque, marca, imagem, condição, preço e página do produto.'),
      h('p', { class: 'muted' }, 'As imagens devem ser JPG ou PNG com pelo menos 500 × 500 px e abrir sem login (o TikTok as baixa). O mesmo SKU enviado de novo atualiza o produto.')),
    h('section', { class: 'form-section' },
      h('h3', { class: 'form-section__title' }, 'Importar planilha (CSV)'),
      h('p', { class: 'muted' }, `Até ${formatNumber(MAX_IMPORT_PRODUCTS)} produtos por importação. Aceita as colunas do modelo, do Google Merchant e do Meta (id, title, description, availability, condition, price, brand, image_link, link…).`),
      h('div', { class: 'catalog-add__file-row' }, fileInput, button('Baixar modelo', { small: true, onClick: downloadTemplate })), csvSlot),
    h('section', { class: 'form-section' },
      h('h3', { class: 'form-section__title' }, 'Adicionar um produto'),
      h('form', { class: 'form', novalidate: true, onSubmit: addFromForm },
        h('div', { class: 'form-grid' }, requiredFields),
        h('details', { class: 'catalog-add__more-fields' }, h('summary', null, 'Mais campos (opcionais)'), h('div', { class: 'form-grid' }, optionalFields)),
        button('Adicionar à lista de envio', { variant: 'primary', type: 'submit', disabled: !canWrite }))),
    h('section', { class: 'form-section' }, queueSlot, resultSlot));
  drawQueue();
  return root;
}
