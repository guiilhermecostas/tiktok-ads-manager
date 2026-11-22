import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_AREAS, AREAS, MAX_TEAM_SIZE, canAccess, hasFullAccess, isArea, normalizeAreas } from '../shared/permissions.js';

describe('Permissões por área (regras compartilhadas)', () => {
  it('as áreas do sistema têm nome e descrição, e a lista é imutável', () => {
    assert.deepEqual(ALL_AREAS, ['creatives', 'campaigns', 'reports', 'accounts']);
    assert.ok(AREAS.every((a) => a.label && a.description));
    assert.throws(() => { 'use strict'; ALL_AREAS.push('admin'); }, TypeError);
    assert.equal(MAX_TEAM_SIZE, 30);
  });

  it('só nomes de área conhecidos valem (nada herdado do protótipo)', () => {
    for (const id of ALL_AREAS) assert.equal(isArea(id), true);
    for (const bad of ['admin', 'team', 'toString', '__proto__', 'constructor', '', 'Creatives', null, undefined, 1, [], {}]) assert.equal(isArea(bad), false, String(bad));
  });

  it('normalizeAreas: valida, remove repetição e ordena; qualquer item inválido recusa tudo', () => {
    assert.deepEqual(normalizeAreas(['accounts', 'creatives', 'creatives']), ['creatives', 'accounts']);
    assert.deepEqual(normalizeAreas([...ALL_AREAS].reverse()), ALL_AREAS);
    for (const bad of [[], ['admin'], ['creatives', 'x'], 'creatives', null, undefined, {}, [...ALL_AREAS, 'creatives'], [1], [['creatives']]]) assert.equal(normalizeAreas(bad), null, JSON.stringify(bad));
  });

  it('canAccess: precisa de ao menos uma das áreas exigidas; sem exigência, passa', () => {
    assert.equal(canAccess(['creatives'], 'creatives'), true);
    assert.equal(canAccess(['creatives'], 'campaigns'), false);
    assert.equal(canAccess(['creatives'], 'accounts', 'creatives'), true);
    assert.equal(canAccess([], 'creatives'), false);
    assert.equal(canAccess([], ), true);
    assert.equal(canAccess(ALL_AREAS, 'reports'), true);
  });

  it('hasFullAccess só quando todas as áreas estão presentes', () => {
    assert.equal(hasFullAccess(ALL_AREAS), true);
    assert.equal(hasFullAccess(['creatives', 'campaigns']), false);
    assert.equal(hasFullAccess([]), false);
  });
});
