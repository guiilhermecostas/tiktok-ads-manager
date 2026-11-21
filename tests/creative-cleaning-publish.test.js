import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCreativeCleaner } from '../src/modules/creatives/creative-cleaner.js';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, one, startTestServer } from './helpers.js';
import { uploadCreative } from './media-fixtures.js';
import { makeImage, makeVideo, md5Of, sha256Of, tempDir } from './real-media.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000 };

/** Publicação de ponta a ponta com o FFmpeg DE VERDADE: o que chega ao TikTok é sempre uma versão limpa e única. */
describe('limpeza dos criativos na publicação (FFmpeg real)', () => {
  let ctx;
  let fake;
  let work;
  before(async () => {
    work = tempDir('publish-media-');
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn, cleaner: 'real' });
    const admin = await loginAdmin(ctx);
    assert.equal((await admin.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 201);
  });
  after(async () => {
    await ctx.stop();
    fs.rmSync(work, { recursive: true, force: true });
  });

  const newUser = async () => {
    const user = await createUser(ctx, { approve: true });
    assert.equal((await user.client.post('/api/tiktok/business-centers', { name: 'Agência', bcId: '222', accessToken: OTHER_TOKEN })).status, 201);
    return user;
  };
  /** Envia a mídia real para a biblioteca do usuário e devolve { id, file }. */
  const library = async (client, file, type) => {
    const res = await uploadCreative(client, { bytes: fs.readFileSync(file), type, filename: path.basename(file) });
    assert.equal(res.status, 201, res.text);
    return res.json.creative.id;
  };
  const draft = async (client, over) => (await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', over) })).json.campaign;
  const publish = (client, id, advertiserId) => client.post(`/api/campaigns/${id}/publish`, { confirm: true, advertiserId });
  const leftovers = () => fs.readdirSync(path.join(ctx.creativesDir, '.tmp'));

  it('a MESMA campanha em 3 contas envia 3 versões limpas e diferentes (vídeo e capa); o arquivo da biblioteca fica intacto', async () => {
    const { client } = await newUser();
    const videoFile = makeVideo(work, { name: 'promo.mp4' });
    const coverFile = makeImage(work, { name: 'capa.png' });
    const video = await library(client, videoFile, 'mp4');
    const cover = await library(client, coverFile, 'png');
    const { id } = await draft(client, { ad: { videoCreativeId: video, coverCreativeId: cover } });
    fake.state.calls.length = 0;

    for (const account of ['9001', '9002', '9101']) assert.equal((await publish(client, id, account)).status, 200, account);

    const videos = fake.callsTo('/file/video/ad/upload/');
    const covers = fake.callsTo('/file/image/ad/upload/');
    assert.equal(videos.length, 3);
    assert.equal(covers.length, 3);
    assert.deepEqual(videos.map((u) => u.body.advertiser_id), ['9001', '9002', '9101']);
    assert.deepEqual(videos.map((u) => u.token), [GOOD_TOKEN, GOOD_TOKEN, OTHER_TOKEN], 'cada conta com o token da sua BC');

    const original = await one(ctx.db, 'SELECT md5 FROM creatives WHERE id = $1', [video]);
    const originalCover = await one(ctx.db, 'SELECT md5 FROM creatives WHERE id = $1', [cover]);
    const videoSignatures = videos.map((u) => u.body.video_signature);
    const coverSignatures = covers.map((u) => u.body.image_signature);
    assert.equal(new Set(videoSignatures).size, 3, 'cada conta recebeu um vídeo com hash diferente');
    assert.equal(new Set(coverSignatures).size, 3, 'e uma capa com hash diferente');
    assert.ok(!videoSignatures.includes(original.md5) && !coverSignatures.includes(originalCover.md5), 'nenhuma versão é igual ao arquivo original');
    for (const upload of [...videos, ...covers]) {
      assert.match(upload.body.file_name, /^[a-f0-9]{16}\.(mp4|png)$/, 'nome aleatório: o nome original nunca é enviado');
      assert.ok((upload.body.video_file ?? upload.body.image_file).size > 0);
    }

    const rows = await all(ctx.db, 'SELECT creative_id, advertiser_id, variant_sha256 FROM campaign_creative_assets WHERE campaign_id = $1', [id]);
    assert.equal(rows.length, 6, '3 contas x (vídeo + capa)');
    assert.equal(new Set(rows.map((r) => r.variant_sha256)).size, 6, 'os 6 arquivos enviados são todos diferentes');
    assert.ok(rows.every((r) => r.variant_sha256 !== sha256Of(videoFile) && r.variant_sha256 !== sha256Of(coverFile)));

    // O arquivo da biblioteca nunca é alterado: o mesmo criativo continua servindo para outras campanhas.
    const stored = await one(ctx.db, 'SELECT storage_key, sha256 FROM creatives WHERE id = $1', [video]);
    assert.equal(sha256Of(path.join(ctx.creativesDir, stored.storage_key)), stored.sha256);
    assert.equal(md5Of(path.join(ctx.creativesDir, stored.storage_key)), original.md5);
    assert.deepEqual(leftovers(), [], 'nenhuma versão limpa ficou no disco depois do envio');
  });

  it('OUTRA campanha com o mesmo criativo, na mesma conta, também envia uma versão nova (não reaproveita)', async () => {
    const { client } = await newUser();
    const video = await library(client, makeVideo(work, { name: 'reuso.mp4' }), 'mp4');
    const a = await draft(client, { campaign: { name: 'Campanha A' }, ad: { videoCreativeId: video } });
    const b = await draft(client, { campaign: { name: 'Campanha B' }, ad: { videoCreativeId: video } });
    fake.state.calls.length = 0;
    assert.equal((await publish(client, a.id, '9001')).status, 200);
    assert.equal((await publish(client, b.id, '9001')).status, 200);
    const uploads = fake.callsTo('/file/video/ad/upload/');
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[0].body.video_signature, uploads[1].body.video_signature);
    const ids = fake.callsTo('/ad/create/').map((c) => c.body.creatives[0].video_id);
    assert.notEqual(ids[0], ids[1]);
  });

  it('arquivo que parece vídeo mas não é: 422 claro, NADA é criado no TikTok, o erro fica registrado na conta e nada sobra no disco', async () => {
    const { client } = await newUser();
    const fakeVideo = path.join(work, 'quebrado.mp4');
    fs.writeFileSync(fakeVideo, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(300, 5)]));
    const video = await library(client, fakeVideo, 'mp4');
    const { id } = await draft(client, { ad: { videoCreativeId: video } });
    fake.state.calls.length = 0;
    const res = await publish(client, id, '9001');
    assert.equal(res.status, 422);
    assert.equal(res.json.error.code, 'creative_clean_failed');
    assert.match(res.json.error.message, /quebrado|corrompido/);
    assert.ok(!/ffmpeg|libav|moov/i.test(res.text), 'sem detalhes internos do FFmpeg');
    assert.deepEqual(fake.state.calls.filter((c) => c.path.includes('/create/') || c.path.includes('/upload/')), [], 'nada foi enviado nem criado');
    const campaign = (await client.get(`/api/campaigns/${id}`)).json.campaign;
    assert.equal(campaign.publish.status, 'none');
    assert.match(campaign.publications[0].error, /corrompido/);
    assert.deepEqual(leftovers(), []);
  });

  it('servidor sem FFmpeg: 503 claro e NADA é enviado ao TikTok sem a limpeza (nunca publica o original)', async () => {
    const noFfmpeg = await startTestServer({
      limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true,
      cleaner: createCreativeCleaner({ ffmpegPath: null, tmpDir: path.join(work, 'tmp-sem-ffmpeg'), log: { error() {} } }),
    });
    try {
      const admin = await loginAdmin(noFfmpeg);
      await admin.post('/api/tiktok/business-centers', { name: 'Loja', bcId: '111', accessToken: GOOD_TOKEN, shared: true });
      const { client } = await createUser(noFfmpeg, { approve: true });
      const res = await uploadCreative(client, { bytes: fs.readFileSync(makeVideo(work, { name: 'sem.mp4' })), type: 'mp4' });
      const campaign = (await client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: res.json.creative.id } }) })).json.campaign;
      fake.state.calls.length = 0;
      const published = await client.post(`/api/campaigns/${campaign.id}/publish`, { confirm: true, advertiserId: '9001' });
      assert.equal(published.status, 503);
      assert.equal(published.json.error.code, 'creative_cleaner_unavailable');
      assert.deepEqual(fake.state.calls.filter((c) => c.path.includes('/upload/') || c.path.includes('/create/')), []);
    } finally {
      await noFfmpeg.stop();
    }
  });
});
