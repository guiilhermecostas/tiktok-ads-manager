import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTiktokClient } from '../../src/modules/tiktok/tiktok.client.js';

/**
 * Teste de CONTRATO contra a API REAL do TikTok. Não precisa de credenciais: usa um token FALSO e não envia
 * nenhum dado do sistema. Confirma que os endpoints existem nos caminhos usados, que o envelope de resposta é o
 * esperado e que "token inválido" (código 40105) é traduzido para 409 `tiktok_reauth`.
 *
 * Fica fora do `npm test` (usa rede). Rode com:  npm run test:live
 */
const enabled = process.env.TIKTOK_LIVE_CONTRACT === '1';
const FAKE_TOKEN = 'falso-0000000000000000000000000000';
const client = createTiktokClient({ config: { tiktok: { apiBase: 'https://business-api.tiktok.com' } } });

const calls = {
  'GET  bc/asset/get': () => client.listBusinessCenterAdvertiserIds(FAKE_TOKEN, '1'),
  'GET  advertiser/info': () => client.getAdvertiserInfo(FAKE_TOKEN, ['1']),
  'GET  campaign/get': () => client.getCampaigns(FAKE_TOKEN, '1'),
  'GET  report/integrated/get': () => client.getDailyReport(FAKE_TOKEN, '1', { startDate: '2026-11-01', endDate: '2026-11-02' }),
  'POST campaign/create': () => client.createCampaign(FAKE_TOKEN, { advertiser_id: '1', campaign_name: 'x', objective_type: 'TRAFFIC', operation_status: 'DISABLE' }),
  'POST adgroup/create': () => client.createAdGroup(FAKE_TOKEN, { advertiser_id: '1', campaign_id: '1', adgroup_name: 'x', operation_status: 'DISABLE' }),
  'POST ad/create': () => client.createAd(FAKE_TOKEN, { advertiser_id: '1', adgroup_id: '1', creatives: [] }),
};

describe('contrato real com a API do TikTok (token falso)', { skip: enabled ? false : 'defina TIKTOK_LIVE_CONTRACT=1 (use npm run test:live)' }, () => {
  for (const [name, run] of Object.entries(calls)) {
    it(`${name}: endpoint existe e "token inválido" vira 409 tiktok_reauth`, async () => {
      await assert.rejects(run(), (err) => err.status === 409 && err.code === 'tiktok_reauth');
    });
  }
});

// Autorização por link: endpoints e página de consentimento. Credenciais de app FALSAS (nada do sistema é enviado).
const FAKE_APP = { appId: '1234567890123456789', appSecret: 'segredo-falso-0000000000' };

describe('contrato real: autorização por link (app e código falsos)', { skip: enabled ? false : 'defina TIKTOK_LIVE_CONTRACT=1 (use npm run test:live)' }, () => {
  it('POST oauth2/access_token: endpoint existe e recusa app/código inválidos com erro de integração (sem vazar nada)', async () => {
    await assert.rejects(
      client.exchangeAuthCode({ ...FAKE_APP, authCode: 'codigo-falso-000000000000' }),
      (err) => err.status === 502 && err.code === 'tiktok_error' && !err.message.includes(FAKE_APP.appSecret),
    );
  });

  it('GET oauth2/advertiser/get: endpoint existe e token falso pede nova autorização', async () => {
    await assert.rejects(client.listAuthorizedAdvertiserIds(FAKE_TOKEN, FAKE_APP), (err) => err instanceof Error && ['tiktok_reauth', 'tiktok_error'].includes(err.code));
  });

  it('GET portal/auth: a página de consentimento do TikTok responde (o link gerado aponta para ela)', async () => {
    const url = new URL('/portal/auth', 'https://business-api.tiktok.com');
    url.searchParams.set('app_id', FAKE_APP.appId);
    url.searchParams.set('state', 'teste');
    url.searchParams.set('redirect_uri', 'https://exemplo.com/api/tiktok/callback');
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    assert.ok(res.status < 500, `status ${res.status}`);
  });
});
