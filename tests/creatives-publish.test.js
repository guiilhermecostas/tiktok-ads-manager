import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, one, startTestServer } from './helpers.js';
import { mp4Bytes, pngBytes, uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, creativesRead: 5000, creativesWrite: 5000 };

describe('Criativos nas campanhas: validação ao salvar e envio ao TikTok na publicação', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    const admin = await loginAdmin(ctx);
    assert.equal((await admin.post('/api/tiktok/business-centers', { name: 'Loja', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
  });
  after(() => ctx.stop());

  const reset = () => {
    fake.state.calls.length = 0;
    fake.state.failCreate.clear();
    fake.state.failUpload.clear();
    fake.state.validTokens = new Set([GOOD_TOKEN, OTHER_TOKEN]);
  };
  const newUser = () => createUser(ctx, { approve: true });
  /** Rascunho de campanha (TRAFFIC, vídeo) pronto para publicar, com os ajustes de `ad`. A conta é escolhida ao publicar. */
  const draft = async (client, over = {}) => (await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', over) })).json.campaign;
  const publish = (client, id, advertiserId = '9001') => client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId });
  const pathsOf = () => fake.state.calls.map((c) => c.path);
  const creatingCalls = () => pathsOf().filter((p) => p.endsWith('/create/'));

  describe('ao salvar o rascunho', () => {
    it('recusa criativo de OUTRO usuário, inexistente ou de tipo errado (com o caminho do campo)', async () => {
      const a = await newUser();
      const b = await newUser();
      const mineVideo = await uploadedId(a.client, { type: 'mp4' });
      const mineImage = await uploadedId(a.client, { type: 'png' });
      const bVideo = await uploadedId(b.client, { type: 'mp4' });
      const check = async (over, path, text) => {
        const res = await a.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', over) });
        assert.equal(res.status, 400, JSON.stringify(over));
        assert.equal(res.json.error.code, 'validation_error');
        const found = res.json.error.details.find((d) => d.path === path);
        assert.ok(found, `faltou erro em ${path}: ${JSON.stringify(res.json.error.details)}`);
        assert.match(found.message, text);
      };
      await check({ ad: { videoCreativeId: bVideo } }, 'ad.videoCreativeId', /não encontrado/);
      await check({ ad: { videoCreativeId: 987654 } }, 'ad.videoCreativeId', /não encontrado/);
      await check({ ad: { videoCreativeId: mineImage } }, 'ad.videoCreativeId', /um vídeo/);
      await check({ ad: { videoCreativeId: mineVideo, coverCreativeId: mineVideo } }, 'ad.coverCreativeId', /uma imagem/);
      await check({ ad: { format: 'CAROUSEL_ADS', videoCreativeId: undefined, imageCreativeIds: [mineImage, bVideo] } }, 'ad.imageCreativeIds.1', /não encontrado|uma imagem/);
      await check({ ad: { format: 'SINGLE_IMAGE', videoCreativeId: undefined, imageCreativeIds: [mineVideo] } }, 'ad.imageCreativeIds.0', /uma imagem/);
      assert.equal((await a.client.get('/api/campaigns')).json.campaigns.length, 0, 'nada foi salvo');
    });

    it('vale também na edição (PUT) e ignora referências de campos que ficaram ocultos', async () => {
      const a = await newUser();
      const b = await newUser();
      const mine = await uploadedId(a.client, { type: 'mp4' });
      const theirs = await uploadedId(b.client, { type: 'mp4' });
      const { id } = await draft(a.client, { ad: { videoCreativeId: mine } });
      const bad = await a.client.put(`/api/campaigns/${id}`, { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: theirs } }) });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.details[0].path, 'ad.videoCreativeId');
      // formato imagem: o campo de vídeo fica oculto, o valor é descartado e não é conferido
      const image = await uploadedId(a.client, { type: 'png' });
      const ok = await a.client.put(`/api/campaigns/${id}`, { config: completeConfig('TRAFFIC', { ad: { format: 'SINGLE_IMAGE', videoCreativeId: theirs, imageCreativeIds: [image] } }) });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.campaign.config.ad.videoCreativeId, undefined);
      assert.deepEqual(ok.json.campaign.config.ad.imageCreativeIds, [image]);
    });

    it('rascunho sem criativo ainda é salvo (obrigatório só para publicar)', async () => {
      const { client } = await newUser();
      const res = await client.post('/api/campaigns', { config: { campaign: { objective: 'TRAFFIC', name: 'Sem mídia' }, ad: { format: 'SINGLE_VIDEO' } } });
      assert.equal(res.status, 201);
      reset();
      const published = await publish(client, res.json.campaign.id);
      assert.equal(published.status, 400);
      assert.ok(published.json.error.details.some((d) => d.path === 'ad.videoCreativeId'));
      assert.equal(fake.state.calls.length, 0);
    });

    it('rejeita IDs de criativo malformados (texto, negativo, decimal, enorme)', async () => {
      const { client } = await newUser();
      for (const bad of ['abc', -1, 0, 1.5, 2 ** 40, [1], { a: 1 }, '1; DROP TABLE creatives']) {
        const res = await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: bad } }) });
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.equal(res.json.error.details[0].path, 'ad.videoCreativeId');
      }
      // null equivale a campo vazio: o rascunho é salvo sem criativo (obrigatório só para publicar)
      assert.equal((await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: null } }) })).status, 201);
      assert.equal((await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { format: 'CAROUSEL_ADS', videoCreativeId: undefined, imageCreativeIds: Array.from({ length: 11 }, (_, i) => i + 1) } }) })).status, 400);
    });
  });

  describe('na publicação', () => {
    it('envia o vídeo ao TikTok ANTES de criar qualquer coisa, com a assinatura MD5, e usa o ID devolvido no anúncio', async () => {
      const { client } = await newUser();
      const bytes = mp4Bytes('publica', 4000);
      const video = await uploadedId(client, { bytes, type: 'mp4' });
      const { id } = await draft(client, { ad: { videoCreativeId: video } });
      reset();
      const res = await publish(client, id);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.campaign.publish.status, 'published');

      const order = pathsOf();
      assert.deepEqual(order.slice(0, 4), ['/file/video/ad/upload/', '/campaign/create/', '/adgroup/create/', '/ad/create/']);
      const upload = fake.callsTo('/file/video/ad/upload/')[0];
      const row = await one(ctx.db, 'SELECT md5, size_bytes FROM creatives WHERE id = $1', [video]);
      assert.equal(upload.token, GOOD_TOKEN, 'usa o token da BC dona da conta');
      assert.equal(upload.method, 'POST');
      assert.deepEqual({ ...upload.body }, { advertiser_id: '9001', upload_type: 'UPLOAD_BY_FILE', video_signature: row.md5, file_name: `${video}.mp4`, video_file: { fileName: `${video}.mp4`, size: bytes.length } });
      const mapped = await one(ctx.db, 'SELECT tiktok_id FROM creative_tiktok_assets WHERE creative_id = $1 AND advertiser_id = $2', [video, '9001']);
      assert.match(mapped.tiktok_id, /^v10033g5000video\d+$/);
      assert.equal(fake.callsTo('/ad/create/')[0].body.creatives[0].video_id, mapped.tiktok_id, 'o anúncio usa o ID que o TikTok devolveu');
      assert.ok(!('video_creative_id' in fake.callsTo('/ad/create/')[0].body.creatives[0]));
    });

    it('REAPROVEITA o envio: mesma conta não reenvia; outra conta de anúncio envia de novo', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const first = await draft(client, { campaign: { name: 'Primeira' }, ad: { videoCreativeId: video } });
      const second = await draft(client, { campaign: { name: 'Segunda' }, ad: { videoCreativeId: video } });
      const other = await draft(client, { campaign: { name: 'Outra conta' }, ad: { videoCreativeId: video } });
      reset();
      assert.equal((await publish(client, first.id)).status, 200);
      assert.equal((await publish(client, second.id)).status, 200);
      assert.equal(fake.callsTo('/file/video/ad/upload/').length, 1, 'segundo uso na mesma conta não reenvia');
      const [ad1, ad2] = fake.callsTo('/ad/create/');
      assert.equal(ad1.body.creatives[0].video_id, ad2.body.creatives[0].video_id);

      assert.equal((await publish(client, other.id, '9002')).status, 200);
      assert.equal(fake.callsTo('/file/video/ad/upload/').length, 2, 'conta diferente = envio novo');
      assert.equal(fake.callsTo('/file/video/ad/upload/')[1].body.advertiser_id, '9002');
      const assets = await all(ctx.db, 'SELECT advertiser_id FROM creative_tiktok_assets WHERE creative_id = $1 ORDER BY advertiser_id', [video]);
      assert.deepEqual(assets.map((a) => a.advertiser_id), ['9001', '9002']);
    });

    it('imagem única, carrossel (ordem preservada) e capa de vídeo', async () => {
      const { client } = await newUser();
      const [i1, i2, i3, cover, video] = [await uploadedId(client, { type: 'png' }), await uploadedId(client, { type: 'jpg' }), await uploadedId(client, { type: 'png' }), await uploadedId(client, { type: 'png' }), await uploadedId(client, { type: 'mp4' })];
      const carousel = await draft(client, { campaign: { name: 'Carrossel' }, ad: { format: 'CAROUSEL_ADS', videoCreativeId: undefined, imageCreativeIds: [i3, i1, i2] } });
      const single = await draft(client, { campaign: { name: 'Imagem' }, ad: { format: 'SINGLE_IMAGE', videoCreativeId: undefined, imageCreativeIds: [i1] } });
      const withCover = await draft(client, { campaign: { name: 'Capa' }, ad: { videoCreativeId: video, coverCreativeId: cover } });
      reset();

      assert.equal((await publish(client, carousel.id)).status, 200);
      assert.equal(fake.callsTo('/file/image/ad/upload/').length, 3);
      assert.equal(fake.callsTo('/file/video/ad/upload/').length, 0);
      const ids = new Map((await all(ctx.db, 'SELECT creative_id, tiktok_id FROM creative_tiktok_assets')).map((r) => [r.creative_id, r.tiktok_id]));
      const carouselAd = fake.callsTo('/ad/create/')[0].body.creatives[0];
      assert.deepEqual(carouselAd.image_ids, [ids.get(i3), ids.get(i1), ids.get(i2)], 'mesma ordem escolhida');
      assert.ok(!('video_id' in carouselAd));
      const imageUpload = fake.callsTo('/file/image/ad/upload/')[0].body;
      assert.deepEqual(Object.keys(imageUpload).sort(), ['advertiser_id', 'file_name', 'image_file', 'image_signature', 'upload_type']);
      assert.match(imageUpload.file_name, /^\d+\.(png|jpg)$/);

      assert.equal((await publish(client, single.id)).status, 200);
      assert.equal(fake.callsTo('/file/image/ad/upload/').length, 3, 'imagem já enviada não é reenviada');
      assert.deepEqual(fake.callsTo('/ad/create/')[1].body.creatives[0].image_ids, [ids.get(i1)]);

      assert.equal((await publish(client, withCover.id)).status, 200);
      const coverAd = fake.callsTo('/ad/create/')[2].body.creatives[0];
      assert.equal(fake.callsTo('/file/video/ad/upload/').length, 1);
      assert.equal(fake.callsTo('/file/image/ad/upload/').length, 4, 'a capa é uma imagem enviada à parte');
      assert.equal(coverAd.image_ids.length, 1);
      assert.match(coverAd.video_id, /^v10033g5000video/);
    });

    it('falha no envio do arquivo: NADA é criado no TikTok, o motivo é registrado e a nova tentativa funciona', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const { id } = await draft(client, { ad: { videoCreativeId: video } });
      reset();
      fake.state.failUpload.add('video');
      const failed = await publish(client, id);
      assert.equal(failed.status, 502);
      assert.match(failed.json.error.message, /Video file is invalid/);
      assert.deepEqual(creatingCalls(), [], 'nenhuma campanha, grupo ou anúncio foi criado');
      const detail = (await client.get(`/api/campaigns/${id}`)).json.campaign;
      assert.equal(detail.publish.status, 'none');
      assert.match(detail.publish.error, /Video file is invalid/);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int AS c FROM creative_tiktok_assets WHERE creative_id = $1', [video])).c, 0);

      fake.state.failUpload.clear();
      assert.equal((await publish(client, id)).status, 200);
      assert.equal((await client.get(`/api/campaigns/${id}`)).json.campaign.publish.error, null);
    });

    it('envio que falha na 2ª imagem: a 1ª (já enviada antes) é reaproveitada e a nova tentativa envia só o que faltou', async () => {
      const { client } = await newUser();
      const first = await uploadedId(client, { type: 'png' });
      const second = await uploadedId(client, { type: 'png' });
      const { id } = await draft(client, { ad: { format: 'CAROUSEL_ADS', videoCreativeId: undefined, imageCreativeIds: [first, second] } });
      // a 1ª imagem já foi enviada à conta 9001 em uma publicação anterior
      await ctx.db.query("INSERT INTO creative_tiktok_assets (creative_id, advertiser_id, tiktok_id) VALUES ($1, '9001', 'ad-site-i18n/anterior1')", [first]);
      reset();
      fake.state.failUpload.add('image');
      const failed = await publish(client, id);
      assert.equal(failed.status, 502);
      assert.equal(fake.callsTo('/file/image/ad/upload/').length, 1, 'só a 2ª tentou enviar; a 1ª já tinha ID');
      assert.deepEqual(creatingCalls(), [], 'nada criado no TikTok');
      fake.state.failUpload.clear();
      assert.equal((await publish(client, id)).status, 200);
      assert.equal(fake.callsTo('/ad/create/')[0].body.creatives[0].image_ids[0], 'ad-site-i18n/anterior1');
      assert.equal(fake.callsTo('/file/image/ad/upload/').length, 2, 'na 2ª tentativa só a 2ª imagem foi enviada');
    });

    it('token da BC revogado durante o envio: 409 de reautorização e BC marcada com erro', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const { id } = await draft(client, { ad: { videoCreativeId: video } });
      reset();
      fake.state.validTokens.delete(GOOD_TOKEN);
      const res = await publish(client, id);
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, 'tiktok_reauth');
      const admin = await loginAdmin(ctx);
      assert.equal((await admin.get('/api/tiktok/business-centers')).json.businessCenters[0].status, 'error');
      // restaura a BC para os próximos testes
      reset();
      const bc = (await admin.get('/api/tiktok/business-centers')).json.businessCenters[0];
      assert.equal((await admin.patch(`/api/tiktok/business-centers/${bc.id}`, { accessToken: GOOD_TOKEN })).status, 200);
    });

    it('criativo que já existe no TikTok: usa o ID guardado (sem enviar) na mesma conta e recusa em outra', async () => {
      const { client } = await newUser();
      const ref = (await client.post('/api/creatives/tiktok', { name: 'Já no TikTok', kind: 'video', advertiserId: '9001', tiktokId: 'v10033g50000existente1' })).json.creative.id;
      const same = await draft(client, { campaign: { name: 'Mesma conta' }, ad: { videoCreativeId: ref } });
      const other = await draft(client, { campaign: { name: 'Outra conta' }, ad: { videoCreativeId: ref } });
      reset();
      assert.equal((await publish(client, same.id)).status, 200);
      assert.equal(fake.callsTo('/file/video/ad/upload/').length, 0, 'não há arquivo para enviar');
      assert.equal(fake.callsTo('/ad/create/')[0].body.creatives[0].video_id, 'v10033g50000existente1');

      reset();
      const wrong = await publish(client, other.id, '9002');
      assert.equal(wrong.status, 400);
      assert.equal(wrong.json.error.code, 'creative_wrong_account');
      assert.equal(fake.state.calls.length, 0, 'nada foi chamado no TikTok');
    });

    it('criativo apagado do banco depois de salvar: erro 400 claro (nunca 500) e nada é enviado', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const { id } = await draft(client, { ad: { videoCreativeId: video } });
      await ctx.db.query('DELETE FROM creatives WHERE id = $1', [video]);
      reset();
      const res = await publish(client, id);
      assert.equal(res.status, 400);
      assert.ok(res.json.error.details.some((d) => /não encontrado/.test(d.message)));
      assert.equal(fake.state.calls.length, 0);
    });

    it('cada usuário envia com o token da SUA Business Center e só enxerga as próprias contas', async () => {
      const owner = await newUser();
      assert.equal((await owner.client.post('/api/tiktok/business-centers', { name: 'Privada', bcId: '222', accessToken: OTHER_TOKEN })).status, 201);
      const video = await uploadedId(owner.client, { type: 'mp4' });
      const { id } = await draft(owner.client, { ad: { videoCreativeId: video } });
      reset();
      assert.equal((await publish(owner.client, id, '9101')).status, 200);
      assert.equal(fake.callsTo('/file/video/ad/upload/')[0].token, OTHER_TOKEN);

      const stranger = await newUser();
      const strangerVideo = await uploadedId(stranger.client, { type: 'mp4' });
      const attempt = await draft(stranger.client, { ad: { videoCreativeId: strangerVideo } });
      reset();
      assert.equal((await publish(stranger.client, attempt.id, '9101')).status, 404, 'conta de anúncio alheia');
      assert.equal(fake.state.calls.length, 0, 'o arquivo do usuário nunca vai para a conta de outro');
    });

    it('depois de publicada, a campanha não bloqueia mais a exclusão do criativo', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const { id } = await draft(client, { ad: { videoCreativeId: video } });
      assert.equal((await client.delete(`/api/creatives/${video}`)).status, 409);
      assert.equal((await publish(client, id)).status, 200);
      assert.equal((await client.delete(`/api/creatives/${video}`)).status, 204);
      assert.equal((await client.get(`/api/campaigns/${id}`)).json.campaign.publish.status, 'published');
    });

    it('publicações simultâneas que usam o mesmo criativo funcionam (cada uma recebe um ID válido)', async () => {
      const { client } = await newUser();
      const video = await uploadedId(client, { type: 'mp4' });
      const drafts = await Promise.all([1, 2, 3].map((n) => draft(client, { campaign: { name: `Paralela ${n}` }, ad: { videoCreativeId: video } })));
      reset();
      const results = await Promise.all(drafts.map((d) => publish(client, d.id)));
      assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int AS c FROM creative_tiktok_assets WHERE creative_id = $1', [video])).c, 1, 'um único vínculo por conta');
    });
  });

  it('o tamanho do arquivo no TikTok simulado corresponde ao que a biblioteca guardou (transmissão do disco, sem corromper)', async () => {
    const { client } = await newUser();
    const bytes = pngBytes('integridade', 50_000);
    const image = await uploadedId(client, { bytes, type: 'png' });
    const { id } = await draft(client, { ad: { format: 'SINGLE_IMAGE', videoCreativeId: undefined, imageCreativeIds: [image] } });
    reset();
    assert.equal((await publish(client, id)).status, 200);
    assert.equal(fake.callsTo('/file/image/ad/upload/')[0].body.image_file.size, bytes.length);
  });
});
