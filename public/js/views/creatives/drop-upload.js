import { h, icon } from '../../dom.js';

/** Quantos arquivos lemos de uma pasta solta (o resto é ignorado, com aviso): impede que uma pasta enorme trave o navegador. */
export const MAX_FILES_PER_DIRECTORY = 200;
/** Nome do atributo que marca um destino de envio: valor = ID da pasta, ou "none" para "sem pasta". */
export const DROP_ATTR = 'data-drop-folder';

/** É um arraste de ARQUIVOS vindos do computador (e não de um cartão da própria tela)? */
export const isFileDrag = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** Pasta de destino indicada por um elemento (ou por um pai dele): número, null (= sem pasta) ou undefined (não é um destino). */
export function dropTargetOf(node) {
  const el = node instanceof Element ? node.closest(`[${DROP_ATTR}]`) : null;
  if (!el) return undefined;
  const value = el.getAttribute(DROP_ATTR);
  if (value === 'none') return null;
  return /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

// ---------- leitura do que foi solto (arquivos e pastas) ----------
const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/** Lê os arquivos que estão DIRETO dentro de uma pasta solta (subpastas não entram: a biblioteca tem um nível só). */
export async function readDirectory(entry, { max = MAX_FILES_PER_DIRECTORY } = {}) {
  const reader = entry.createReader();
  const files = [];
  let subfolders = 0;
  let ignored = 0;
  for (;;) {
    const batch = await readEntries(reader); // o navegador devolve de 100 em 100: repete até acabar
    if (!batch.length) break;
    for (const child of batch) {
      if (child.isDirectory) subfolders += 1;
      else if (!child.isFile || child.name.startsWith('.')) continue; // ocultos do sistema (.DS_Store) ficam de fora em silêncio
      else if (files.length < max) files.push(await fileOf(child));
      else ignored += 1;
    }
  }
  return { name: entry.name, files, subfolders, ignored };
}

/**
 * Separa o que foi solto em arquivos soltos e pastas. Os itens só podem ser lidos DURANTE o evento de soltar, por isso a primeira
 * parte é síncrona; a leitura do conteúdo das pastas (assíncrona) vem depois.
 * @returns {Promise<{ files: File[], directories: { name: string, files: File[], subfolders: number, ignored: number }[] }>}
 */
export async function readDropped(dataTransfer) {
  const items = Array.from(dataTransfer?.items ?? []).filter((item) => item.kind === 'file');
  if (!items.length) return { files: Array.from(dataTransfer?.files ?? []), directories: [] };
  const picked = items.map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }));
  const files = [];
  const directories = [];
  for (const { entry, file } of picked) {
    if (entry?.isDirectory) directories.push(await readDirectory(entry));
    else if (file) files.push(file);
  }
  return { files, directories };
}

/**
 * Envio por arrastar e soltar em QUALQUER lugar da página.
 *  - Soltar numa pasta (qualquer elemento com `data-drop-folder`) envia para ela; soltar em outro lugar envia para o lugar aberto agora.
 *  - Mostra uma faixa dizendo para onde os arquivos vão e destaca a pasta sob o ponteiro.
 *  - Ignora arrastos que não são de arquivos (cartões da própria tela) e não faz nada com um pop-up aberto.
 *  - Soltar um arquivo fora de uma área ativa nunca deixa o navegador abrir o arquivo e sair da página.
 * `currentFolder()`: pasta do lugar aberto (número ou null). `labelOf(id)`: nome para exibir. `onDrop({ files, directories, folderId })`.
 */
export function createFileDrop({ currentFolder, labelOf, onDrop }) {
  const text = h('strong', null);
  const hint = h('div', { class: 'drop-hint', hidden: true, role: 'status' }, icon('upload', 20), text);
  let highlighted = null;
  let lastLabel = '';

  const modalOpen = () => document.body.classList.contains('modal-open');
  const destination = (event) => {
    const target = dropTargetOf(event.target);
    return target === undefined ? currentFolder() : target;
  };
  const clearHighlight = () => {
    highlighted?.classList.remove('is-drop-files');
    highlighted = null;
  };
  const hide = () => {
    hint.hidden = true;
    document.body.classList.remove('is-file-drag');
    clearHighlight();
    lastLabel = '';
  };

  function onDragOver(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault(); // sem isto o navegador não deixa soltar (e abriria o arquivo)
    if (modalOpen()) {
      event.dataTransfer.dropEffect = 'none';
      hide();
      return;
    }
    event.dataTransfer.dropEffect = 'copy';
    const folderId = destination(event);
    const label = folderId === null ? 'Solte para enviar para a biblioteca (sem pasta)' : `Solte para enviar para a pasta “${labelOf(folderId) ?? 'pasta'}”`;
    if (label !== lastLabel) {
      lastLabel = label;
      text.textContent = label;
    }
    hint.hidden = false;
    document.body.classList.add('is-file-drag');
    const el = event.target instanceof Element ? event.target.closest(`[${DROP_ATTR}]`) : null;
    if (el !== highlighted) {
      clearHighlight();
      highlighted = el;
      highlighted?.classList.add('is-drop-files');
    }
  }
  function onDragLeave(event) {
    if (!event.relatedTarget) hide(); // saiu da janela (ou o navegador não informa para onde foi: o próximo dragover mostra de novo)
  }
  function onDropEvent(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const folderId = modalOpen() ? undefined : destination(event);
    hide();
    if (folderId === undefined) return;
    readDropped(event.dataTransfer).then(({ files, directories }) => {
      if (files.length || directories.length) onDrop({ files, directories, folderId });
    }).catch(() => onDrop({ files: [], directories: [], folderId, failed: true }));
  }

  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDropEvent);
  document.addEventListener('dragend', hide);

  return {
    hint,
    destroy() {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDropEvent);
      document.removeEventListener('dragend', hide);
      hide();
    },
  };
}
