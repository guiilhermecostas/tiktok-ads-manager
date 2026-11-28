import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_FOLDER_DEPTH, childrenMap, depthOf, descendantIds, pathLabel, pathOf, treeOrder, withTotals } from '../shared/creative-folders.js';

const folders = [
  { id: 1, name: 'Oferta A', parentId: null, count: 2, sizeBytes: 100 },
  { id: 2, name: 'Verão', parentId: 1, count: 3, sizeBytes: 50 },
  { id: 3, name: 'Vídeos', parentId: 2, count: 4, sizeBytes: 25 },
  { id: 4, name: 'Oferta B', parentId: null, count: 1, sizeBytes: 10 },
  { id: 5, name: 'Inverno', parentId: 1, count: 0, sizeBytes: 0 },
];

describe('Pastas dentro de pastas (ajudantes compartilhados)', () => {
  it('o limite de níveis é 5', () => assert.equal(MAX_FOLDER_DEPTH, 5));

  it('treeOrder põe cada pasta logo antes das suas subpastas, com a profundidade', () => {
    assert.deepEqual(treeOrder(folders).map(({ folder, depth }) => [folder.id, depth]), [[1, 0], [2, 1], [3, 2], [5, 1], [4, 0]]);
  });

  it('descendantIds devolve as subpastas de qualquer nível, sem a própria pasta', () => {
    assert.deepEqual(descendantIds(folders, 1).sort(), [2, 3, 5]);
    assert.deepEqual(descendantIds(folders, 3), []);
    assert.deepEqual(descendantIds(folders, 99), []);
  });

  it('pathOf / pathLabel / depthOf: do topo até a pasta; pasta inexistente não tem caminho', () => {
    assert.deepEqual(pathOf(folders, 3).map((f) => f.id), [1, 2, 3]);
    assert.equal(pathLabel(folders, 3), 'Oferta A / Verão / Vídeos');
    assert.equal(pathLabel(folders, 4), 'Oferta B');
    assert.equal(pathLabel(folders, 99), null);
    assert.equal(depthOf(folders, 3), 3);
    assert.equal(depthOf(folders, 1), 1);
    assert.equal(depthOf(folders, 99), 0);
  });

  it('withTotals soma os arquivos e o tamanho das subpastas e conta as subpastas diretas', () => {
    const byId = Object.fromEntries(withTotals(folders).map((f) => [f.id, f]));
    assert.deepEqual([byId[1].deepCount, byId[1].deepSizeBytes, byId[1].subfolderCount], [9, 175, 2]);
    assert.deepEqual([byId[2].deepCount, byId[2].deepSizeBytes, byId[2].subfolderCount], [7, 75, 1]);
    assert.deepEqual([byId[4].deepCount, byId[4].subfolderCount], [1, 0]);
    assert.equal(byId[1].count, 2, 'a contagem direta continua lá');
  });

  it('pasta cujo pai sumiu da lista aparece como de nível mais alto (nunca some da tela)', () => {
    const orphan = [{ id: 7, name: 'Solta', parentId: 999, count: 0, sizeBytes: 0 }];
    assert.deepEqual(treeOrder(orphan).map((x) => x.folder.id), [7]);
    assert.equal(childrenMap(orphan).get(null).length, 1);
  });

  it('um ciclo (que o servidor não permite) não trava a tela', () => {
    const loop = [{ id: 1, name: 'A', parentId: 2, count: 1, sizeBytes: 1 }, { id: 2, name: 'B', parentId: 1, count: 1, sizeBytes: 1 }];
    assert.doesNotThrow(() => { treeOrder(loop); pathOf(loop, 1); descendantIds(loop, 1); withTotals(loop); });
  });
});
