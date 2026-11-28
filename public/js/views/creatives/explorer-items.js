import { h, icon } from '../../dom.js';
import { formatBytes, formatDate } from '../../format.js';
import { badge } from '../../ui.js';
import { plural } from './folders.js';
import { creativeThumb } from './thumb.js';

/**
 * Peças visuais do gerenciador de arquivos: cartão e linha de arquivo, e cartão de pasta. SÓ montam elementos: o clique, o duplo clique,
 * o menu de contexto, o arrastar e os botões (`data-action`) são tratados em um lugar só, na tela (delegação de eventos).
 * Todo texto (nome de arquivo, de pasta) entra como nó de texto, nunca como HTML.
 */

const kindLabel = (creative) => (creative.kind === 'video' ? 'Vídeo' : 'Imagem');
const sizeLabel = (creative) => (creative.sizeBytes === null ? 'No TikTok' : formatBytes(creative.sizeBytes));

/** Botão de ação do item. `action` é lido pela tela: view | move | rename | remove. */
function actionButton(action, label, iconName, creative, { danger = false } = {}) {
  return h('button', { type: 'button', class: `icon-btn${danger ? ' icon-btn--danger' : ''}`, 'data-action': action, title: label, 'aria-label': `${label}: ${creative.name}` }, icon(iconName, 16));
}

const actions = (creative) =>
  h(
    'div',
    { class: 'file-actions' },
    actionButton('view', 'Ver', 'eye', creative),
    actionButton('move', 'Mover para pasta', 'folder', creative),
    actionButton('rename', 'Renomear', 'edit', creative),
    actionButton('remove', 'Excluir', 'trash', creative, { danger: true }),
  );

const checkbox = (creative, selected) =>
  h('label', { class: 'file-check', title: 'Selecionar' }, h('input', { type: 'checkbox', checked: selected, 'data-check': '1', 'aria-label': `Selecionar ${creative.name}` }));

/** Atributos comuns de qualquer item de arquivo (a tela os usa para achar o item e o tornar arrastável). */
const itemProps = (creative, selected, extraClass) => ({
  class: `${extraClass}${selected ? ' is-selected' : ''}`,
  'data-creative-id': String(creative.id),
  draggable: true,
  tabindex: '0',
  'aria-label': `${creative.name}, ${kindLabel(creative)}, ${sizeLabel(creative)}`,
});

/** Cartão da visualização em grade. `folderName`: nome da pasta, só quando faz sentido mostrar (visão "Todos os arquivos"). */
export function fileCard(creative, { selected, folderName = null }) {
  const used = creative.tiktokAdvertisers.length;
  return h(
    'article',
    itemProps(creative, selected, 'creative-card'),
    checkbox(creative, selected),
    h('div', { class: 'creative-card__preview' }, creativeThumb(creative)),
    h(
      'div',
      { class: 'creative-card__body' },
      h('p', { class: 'creative-card__name', title: creative.name }, creative.name),
      h('p', { class: 'muted creative-card__meta' }, `${sizeLabel(creative)} · ${formatDate(creative.createdAt)}`),
      used || creative.aiGenerated || folderName
        ? h('p', { class: 'creative-card__tags' }, folderName ? h('span', { class: 'folder-tag', title: `Pasta: ${folderName}` }, icon('folder', 12), h('span', null, folderName)) : null, creative.aiGenerated ? badge('Gerado por IA', 'neutral') : null, used ? badge(`Enviado a ${used} conta${used > 1 ? 's' : ''}`, 'success') : null)
        : null,
    ),
    actions(creative),
  );
}

/** Linha da visualização em lista. */
function fileRow(creative, { selected, showFolder, folderNameOf }) {
  const used = creative.tiktokAdvertisers.length;
  const folderName = showFolder && creative.folderId !== null ? folderNameOf(creative.folderId) : null;
  return h(
    'tr',
    itemProps(creative, selected, 'file-row'),
    h('td', { class: 'file-row__check' }, checkbox(creative, selected)),
    h(
      'td',
      { class: 'file-row__name' },
      h('div', { class: 'file-row__main' }, h('div', { class: 'file-row__thumb' }, creativeThumb(creative)), h('div', { class: 'file-row__text' }, h('strong', { title: creative.name }, creative.name), creative.aiGenerated || used ? h('span', { class: 'file-row__tags' }, creative.aiGenerated ? badge('Gerado por IA', 'neutral') : null, used ? badge(`Enviado a ${used} conta${used > 1 ? 's' : ''}`, 'success') : null) : null)),
    ),
    showFolder ? h('td', { class: 'file-row__folder' }, folderName ? h('span', { class: 'folder-tag', title: `Pasta: ${folderName}` }, icon('folder', 12), h('span', null, folderName)) : h('span', { class: 'muted' }, '—')) : null,
    h('td', { class: 'file-row__kind' }, kindLabel(creative)),
    h('td', { class: 'file-row__size' }, sizeLabel(creative)),
    h('td', { class: 'file-row__date' }, formatDate(creative.createdAt)),
    h('td', { class: 'file-row__actions' }, actions(creative)),
  );
}

const COLUMNS = [
  ['name', 'Nome'],
  ['kind', 'Tipo'],
  ['size', 'Tamanho'],
  ['date', 'Enviado em'],
];

/** Tabela da visualização em lista. Os títulos de coluna ordenam (botão `data-sort`); `aria-sort` marca a coluna atual. */
export function fileTable(creatives, { selected, showFolder, folderNameOf, sort, dir }) {
  const sortable = (key, label) => {
    const on = sort === key;
    return h(
      'th',
      { scope: 'col', class: `file-th file-th--${key}`, 'aria-sort': on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', class: 'file-th__btn', 'data-sort': key, title: `Ordenar por ${label.toLowerCase()}` }, h('span', null, label), on ? icon(dir === 'asc' ? 'arrow-up' : 'arrow-down', 13) : null),
    );
  };
  return h(
    'div',
    { class: 'file-table-wrap' },
    h(
      'table',
      { class: 'file-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'file-row__check' }, h('span', { class: 'visually-hidden' }, 'Selecionar')), sortable('name', 'Nome'), showFolder ? h('th', { scope: 'col', class: 'file-th file-row__folder' }, 'Pasta') : null, ...COLUMNS.slice(1).map(([key, label]) => sortable(key, label)), h('th', { scope: 'col', class: 'file-row__actions' }, h('span', { class: 'visually-hidden' }, 'Ações')))),
      h('tbody', null, creatives.map((creative) => fileRow(creative, { selected: selected.has(creative.id), showFolder, folderNameOf }))),
    ),
  );
}

/** Cartão de pasta (visão "Todos os arquivos"): abre com um clique; aceita soltar criativos e arquivos do computador. */
export function folderTile(folder) {
  // Os totais somam as subpastas (`withTotals`); sem eles (lista simples), vale o que há direto na pasta.
  const files = folder.deepCount ?? folder.count;
  const size = folder.deepSizeBytes ?? folder.sizeBytes ?? 0;
  const meta = [plural(files, 'arquivo', 'arquivos'), folder.subfolderCount ? plural(folder.subfolderCount, 'subpasta', 'subpastas') : null, files ? formatBytes(size) : null].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'folder-tile', 'data-folder-id': String(folder.id), 'data-drop-folder': String(folder.id) },
    h('button', { type: 'button', class: 'folder-tile__open', 'data-action': 'open-folder', 'aria-label': `Abrir a pasta ${folder.name}, ${meta}` }, h('span', { class: 'folder-tile__icon' }, icon('folder', 28)), h('span', { class: 'folder-tile__text' }, h('strong', { title: folder.name }, folder.name), h('span', { class: 'muted' }, meta))),
    h(
      'div',
      { class: 'file-actions' },
      h('button', { type: 'button', class: 'icon-btn', 'data-action': 'rename-folder', title: 'Renomear pasta', 'aria-label': `Renomear a pasta ${folder.name}` }, icon('edit', 16)),
      h('button', { type: 'button', class: 'icon-btn icon-btn--danger', 'data-action': 'delete-folder', title: 'Excluir pasta', 'aria-label': `Excluir a pasta ${folder.name}` }, icon('trash', 16)),
    ),
  );
}
