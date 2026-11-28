/**
 * Regras e ajudantes das pastas da biblioteca de criativos, compartilhados entre o servidor e a tela.
 * As pastas chegam como uma lista simples (`{ id, name, parentId }`, `parentId` nulo = pasta de nível mais alto); aqui ela vira árvore.
 */

/** Quantos níveis de pasta cabem um dentro do outro (a pasta de nível mais alto é o nível 1). */
export const MAX_FOLDER_DEPTH = 5;
/** Separador usado para mostrar o caminho de uma pasta: "Oferta / Verão / Vídeos". */
export const PATH_SEPARATOR = ' / ';

/** Pastas agrupadas por pai (chave `null` = nível mais alto). Pasta cujo pai não está na lista conta como de nível mais alto. */
export function childrenMap(folders) {
  const ids = new Set(folders.map((f) => f.id));
  const map = new Map();
  for (const folder of folders) {
    const key = folder.parentId !== null && folder.parentId !== undefined && ids.has(folder.parentId) ? folder.parentId : null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(folder);
  }
  return map;
}

/** A lista inteira em ordem de árvore (cada pasta logo antes das suas subpastas), com `depth` (0 = nível mais alto). */
export function treeOrder(folders) {
  const children = childrenMap(folders);
  const out = [];
  const seen = new Set();
  const walk = (parentId, depth) => {
    for (const folder of children.get(parentId) ?? []) {
      if (seen.has(folder.id)) continue; // proteção: um ciclo (que não deveria existir) não trava a tela
      seen.add(folder.id);
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Pastas de dentro de `id`, em qualquer nível (sem incluir a própria `id`). */
export function descendantIds(folders, id) {
  const children = childrenMap(folders);
  const out = [];
  const stack = [id];
  const seen = new Set([id]);
  while (stack.length) {
    for (const child of children.get(stack.pop()) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

/** O caminho até a pasta, da de nível mais alto até ela (lista vazia se a pasta não existe). */
export function pathOf(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path = [];
  const seen = new Set();
  for (let cursor = byId.get(id); cursor && !seen.has(cursor.id); cursor = byId.get(cursor.parentId)) {
    seen.add(cursor.id);
    path.unshift(cursor);
  }
  return path;
}

/** "Oferta / Verão / Vídeos" (ou nulo se a pasta não existe). */
export const pathLabel = (folders, id) => {
  const path = pathOf(folders, id);
  return path.length ? path.map((f) => f.name).join(PATH_SEPARATOR) : null;
};

/** Quantos níveis a pasta tem do topo até ela (a de nível mais alto = 1; 0 se não existe). */
export const depthOf = (folders, id) => pathOf(folders, id).length;

/** Cada pasta com o total que há dentro dela somando as subpastas: `deepCount`, `deepSizeBytes` e `subfolderCount` (as diretas). */
export function withTotals(folders) {
  const children = childrenMap(folders);
  const totals = new Map();
  const sum = (folder, trail) => {
    if (totals.has(folder.id)) return totals.get(folder.id);
    const subs = children.get(folder.id) ?? [];
    const total = { deepCount: folder.count ?? 0, deepSizeBytes: folder.sizeBytes ?? 0, subfolderCount: subs.length };
    totals.set(folder.id, total);
    if (!trail.has(folder.id)) {
      const next = new Set(trail).add(folder.id);
      for (const sub of subs) {
        const inner = sum(sub, next);
        total.deepCount += inner.deepCount;
        total.deepSizeBytes += inner.deepSizeBytes;
      }
    }
    return total;
  };
  return folders.map((folder) => ({ ...folder, ...sum(folder, new Set()) }));
}
