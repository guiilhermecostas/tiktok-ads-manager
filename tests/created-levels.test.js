import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropMissing } from '../src/lib/created-levels.js';

const all = { campaignId: '1', adGroupId: '2', adId: '3' };

describe('Conferência do que foi criado no TikTok: quais IDs soltar', () => {
  it('nada faltando: os IDs ficam como estão', () => {
    assert.deepEqual(dropMissing(all, []), all);
  });

  it('falta só o anúncio: solta só o anúncio', () => {
    assert.deepEqual(dropMissing(all, ['ad']), { campaignId: '1', adGroupId: '2', adId: null });
  });

  it('falta o grupo de anúncios: solta o grupo E o anúncio (o anúncio dele não vale)', () => {
    assert.deepEqual(dropMissing(all, ['adGroup']), { campaignId: '1', adGroupId: null, adId: null });
    assert.deepEqual(dropMissing(all, ['adGroup', 'ad']), { campaignId: '1', adGroupId: null, adId: null });
  });

  it('falta a campanha: solta os três (sem campanha nada vale)', () => {
    assert.deepEqual(dropMissing(all, ['campaign']), { campaignId: null, adGroupId: null, adId: null });
    assert.deepEqual(dropMissing(all, ['campaign', 'ad']), { campaignId: null, adGroupId: null, adId: null });
  });

  it('não altera o objeto original e aceita IDs que já eram nulos (publicação parcial)', () => {
    const partial = { campaignId: '1', adGroupId: null, adId: null };
    const result = dropMissing(partial, ['ad']);
    assert.deepEqual(result, partial);
    assert.notEqual(result, partial);
    assert.deepEqual(all, { campaignId: '1', adGroupId: '2', adId: '3' });
    assert.deepEqual(dropMissing({}, ['campaign']), { campaignId: null, adGroupId: null, adId: null });
  });
});
