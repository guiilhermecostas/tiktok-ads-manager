import { OBJECTIVES } from '../../../shared/campaign-spec.js';
import { AREAS } from '../../../shared/permissions.js';

/**
 * O que registrar em cada rota que ALTERA algo. Fica tudo aqui, num lugar só: os módulos (campanhas, criativos, catálogo, contas…) não sabem que o
 * registro existe. Cada regra: método, caminho completo (sem a parte "?…"), a ação do catálogo (`shared/activity.js`) e duas funções:
 *  - `before(ctx)` (opcional): roda ANTES da ação, para guardar o que sumiria depois (o nome do que vai ser excluído);
 *  - `describe(ctx)`: roda DEPOIS, só se deu certo (2xx), e devolve `{ target, details }` ou `null` (nada a registrar).
 * `ctx`: { actor (o dono do espaço), user (a pessoa), match, body (o que a pessoa enviou), result (a resposta JSON), snapshot (do `before`), lookups }.
 * REGRA DE OURO: de `body` só se copia o que é seguro mostrar (nomes, quantidades, IDs públicos); token, senha e chaves NUNCA entram.
 * `sanitizeDetails` ainda descarta qualquer campo fora da lista permitida.
 */

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const OBJECTIVE_LABEL = Object.fromEntries(OBJECTIVES.map((o) => [o.value, o.label]));
const LEVEL = { campaigns: 'campaign', adgroups: 'adgroup', ads: 'ad' };
const idList = (value, max = 100) => (Array.isArray(value) ? value.filter((v) => Number.isInteger(v)).slice(0, max) : []);
const named = (account) => (account ? `${account.name} (ID ${account.id})` : undefined);
const areasText = (areas) => (Array.isArray(areas) ? areas.map((a) => AREA_LABEL[a] ?? a) : undefined);
const money = (amount, currency) => (Number.isFinite(amount) ? `${currency ?? ''} ${amount.toFixed(2)}`.trim() : undefined);

export function createActivityRules() {
  const rule = (method, pattern, action, handlers) => ({ method, pattern, action, ...handlers });
  const B = '/api/tiktok/business-centers';
  const C = '/api/tiktok/catalogs';

  return [
    // ---------- campanhas ----------
    rule('POST', /^\/api\/campaigns$/, 'campaign.create', {
      describe: ({ result }) => (result?.campaign ? { target: result.campaign.name, details: { objective: OBJECTIVE_LABEL[result.campaign.objective] ?? result.campaign.objective } } : null),
    }),
    rule('PUT', /^\/api\/campaigns\/(\d+)$/, 'campaign.update', {
      describe: ({ result }) => (result?.campaign ? { target: result.campaign.name, details: { objective: OBJECTIVE_LABEL[result.campaign.objective] ?? result.campaign.objective } } : null),
    }),
    rule('DELETE', /^\/api\/campaigns\/(\d+)$/, 'campaign.delete', {
      before: async ({ actor, match, lookups }) => (await lookups.campaign(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
    // Publicar: quem publicou, onde (conta), com qual link, quais criativos e qual catálogo (lidos da campanha salva).
    rule('POST', /^\/api\/campaigns\/(\d+)\/publish$/, 'campaign.publish', {
      describe: async ({ actor, match, body, result, lookups }) => {
        const campaign = await lookups.campaign(actor.id, Number(match[1]));
        const ad = campaign?.config?.ad ?? {};
        const creativeIds = [ad.videoCreativeId, ad.coverCreativeId, ...(ad.imageCreativeIds ?? [])].filter((id) => Number.isInteger(id));
        const creatives = creativeIds.length ? await lookups.creatives(actor.id, [...new Set(creativeIds)]) : [];
        const account = typeof body?.advertiserId === 'string' ? await lookups.advertiser(body.advertiserId, actor.id) : null;
        const catalogId = campaign?.config?.adGroup?.catalogId;
        return {
          target: campaign?.name ?? result?.campaign?.name,
          details: {
            account: named(account) ?? (typeof body?.advertiserId === 'string' ? `ID ${body.advertiserId}` : undefined),
            link: ad.landingPageUrl,
            creatives: creatives.map((c) => c.name),
            catalog: catalogId ? `ID ${catalogId}` : undefined,
            objective: OBJECTIVE_LABEL[campaign?.objective] ?? campaign?.objective,
          },
        };
      },
    }),
    // Campanha one-click: criar, alterar, apagar e publicar uma configuração (a publicação em cada conta aparece como "campaign.publish").
    rule('POST', /^\/api\/automation\/one-click$/, 'template.create', {
      describe: ({ result }) => (result?.template ? { target: result.template.name, details: { objective: OBJECTIVE_LABEL[result.template.objective] ?? result.template.objective } } : null),
    }),
    rule('PUT', /^\/api\/automation\/one-click\/(\d+)$/, 'template.update', {
      describe: ({ result }) => (result?.template ? { target: result.template.name, details: { objective: OBJECTIVE_LABEL[result.template.objective] ?? result.template.objective } } : null),
    }),
    rule('DELETE', /^\/api\/automation\/one-click\/(\d+)$/, 'template.delete', {
      before: async ({ actor, match, lookups }) => (await lookups.template(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
    rule('POST', /^\/api\/automation\/one-click\/(\d+)\/launch$/, 'template.launch', {
      describe: async ({ actor, match, lookups }) => {
        const template = await lookups.template(actor.id, Number(match[1]));
        if (!template) return null;
        const ad = template.config?.ad ?? {};
        const creativeIds = [ad.videoCreativeId, ad.coverCreativeId, ...(ad.imageCreativeIds ?? [])].filter((id) => Number.isInteger(id));
        const creatives = creativeIds.length ? await lookups.creatives(actor.id, [...new Set(creativeIds)]) : [];
        const catalogId = template.config?.adGroup?.catalogId;
        return {
          target: template.name,
          details: { link: ad.landingPageUrl, creatives: creatives.map((c) => c.name), catalog: catalogId ? `ID ${catalogId}` : undefined, objective: OBJECTIVE_LABEL[template.objective] ?? template.objective },
        };
      },
    }),
    // Ativar/pausar no Gerenciador (campanhas, grupos e anúncios).
    rule('POST', /^\/api\/tiktok\/manager\/(campaigns|adgroups|ads)\/status$/, 'manager.status', {
      describe: async ({ actor, match, body, result, lookups }) => {
        const updated = Array.isArray(result?.updated) ? result.updated : [];
        if (!updated.length) return null;
        const account = typeof body?.advertiserId === 'string' ? await lookups.advertiser(body.advertiserId, actor.id) : null;
        return { details: { level: LEVEL[match[1]], status: result.status, count: updated.length, items: updated.slice(0, 10), account: named(account) ?? `ID ${body?.advertiserId}` } };
      },
    }),

    // ---------- criativos ----------
    rule('POST', /^\/api\/creatives$/, 'creative.upload', {
      describe: async ({ actor, result, lookups }) => {
        const creative = result?.creative;
        if (!creative) return null;
        const folder = creative.folderId ? await lookups.folder(actor.id, creative.folderId) : null;
        return { target: creative.name, details: { file: creative.originalFilename ?? undefined, folder: folder?.name } };
      },
    }),
    rule('POST', /^\/api\/creatives\/tiktok$/, 'creative.tiktok_ref', { describe: ({ result }) => (result?.creative ? { target: result.creative.name } : null) }),
    rule('PATCH', /^\/api\/creatives\/(\d+)$/, 'creative.update', {
      describe: async ({ actor, body, result, lookups }) => {
        if (!result?.creative) return null;
        const change = [];
        if (body?.name !== undefined) change.push('Renomeou');
        if (body?.folderId !== undefined) change.push(`Mudou de pasta (${body.folderId === null ? 'sem pasta' : (await lookups.folder(actor.id, body.folderId))?.name ?? 'outra pasta'})`);
        return { target: result.creative.name, details: { change: change.join(' e ') } };
      },
    }),
    rule('DELETE', /^\/api\/creatives\/(\d+)$/, 'creative.delete', {
      before: async ({ actor, match, lookups }) => (await lookups.creatives(actor.id, [Number(match[1])]))[0]?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
    rule('POST', /^\/api\/creatives\/delete$/, 'creative.delete', {
      before: async ({ actor, body, lookups }) => (await lookups.creatives(actor.id, idList(body?.ids))).map((c) => c.name),
      describe: ({ result, snapshot }) => (result?.removed > 0 ? { details: { count: result.removed, items: snapshot ?? undefined } } : null),
    }),
    rule('POST', /^\/api\/creatives\/move$/, 'creative.move', {
      before: async ({ actor, body, lookups }) => (await lookups.creatives(actor.id, idList(body?.ids))).map((c) => c.name),
      describe: async ({ actor, body, result, snapshot, lookups }) => ({
        details: { count: result?.moved, items: snapshot ?? undefined, folder: body?.folderId === null ? 'Sem pasta' : (await lookups.folder(actor.id, body?.folderId))?.name },
      }),
    }),
    rule('POST', /^\/api\/creatives\/folders$/, 'folder.create', { describe: ({ result }) => (result?.folder ? { target: result.folder.name } : null) }),
    rule('PATCH', /^\/api\/creatives\/folders\/(\d+)$/, 'folder.rename', { describe: ({ result }) => (result?.folder ? { target: result.folder.name } : null) }),
    rule('DELETE', /^\/api\/creatives\/folders\/(\d+)$/, 'folder.delete', {
      before: async ({ actor, match, lookups }) => (await lookups.folder(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
    rule('POST', /^\/api\/hooks$/, 'hook.create', { describe: ({ result }) => ({ details: { count: Array.isArray(result?.hooks) ? result.hooks.length : undefined } }) }),
    rule('POST', /^\/api\/hooks\/(\d+)\/apply$/, 'hook.apply', {
      describe: async ({ actor, body, lookups }) => ({ target: Number.isInteger(body?.creativeId) ? (await lookups.creatives(actor.id, [body.creativeId]))[0]?.name : undefined }),
    }),
    rule('DELETE', /^\/api\/hooks\/(\d+)$/, 'hook.delete', { describe: () => ({}) }),

    // ---------- catálogo ----------
    rule('POST', new RegExp(`^${C}$`), 'catalog.create', {
      describe: ({ body, result }) => ({ target: result?.catalog?.name ?? (typeof body?.name === 'string' ? body.name : undefined), details: { bc: typeof body?.bcId === 'string' ? body.bcId : undefined } }),
    }),
    rule('POST', new RegExp(`^${C}/(\\d+)/products$`), 'catalog.products', {
      describe: ({ match, body }) => ({ details: { catalog: `ID ${match[1]}`, count: Array.isArray(body?.products) ? body.products.length : undefined } }),
    }),
    rule('POST', new RegExp(`^${C}/(\\d+)/sets$`), 'catalog.set', { describe: ({ match, result }) => ({ target: result?.set?.name, details: { catalog: `ID ${match[1]}` } }) }),
    rule('POST', new RegExp(`^${C}/(\\d+)/feeds$`), 'catalog.feed_create', { describe: ({ match, result }) => ({ target: result?.feed?.name, details: { catalog: `ID ${match[1]}` } }) }),
    rule('POST', new RegExp(`^${C}/(\\d+)/feeds/([\\w-]+)/status$`), 'catalog.feed_status', {
      describe: ({ match, body }) => ({ details: { catalog: `ID ${match[1]}`, change: body?.status === 'ON' ? 'Ligou' : body?.status === 'OFF' ? 'Desligou' : undefined } }),
    }),
    rule('DELETE', new RegExp(`^${C}/(\\d+)/feeds/([\\w-]+)$`), 'catalog.feed_delete', { describe: ({ match }) => ({ details: { catalog: `ID ${match[1]}` } }) }),
    rule('PUT', new RegExp(`^${C}/(\\d+)/defaults$`), 'catalog.defaults_save', { describe: ({ match }) => ({ details: { catalog: `ID ${match[1]}` } }) }),
    rule('DELETE', new RegExp(`^${C}/(\\d+)/defaults$`), 'catalog.defaults_remove', { describe: ({ match }) => ({ details: { catalog: `ID ${match[1]}` } }) }),

    // ---------- contas, conexões, proxies e arquivos ----------
    rule('POST', new RegExp(`^${B}$`), 'bc.connect', {
      describe: ({ result }) => (result?.businessCenter ? { target: result.businessCenter.name, details: { bc: result.businessCenter.bcId ?? undefined, count: result.businessCenter.advertiserCount } } : null),
    }),
    rule('POST', /^\/api\/tiktok\/connect$/, 'bc.connect_link', { describe: ({ body }) => ({ target: typeof body?.name === 'string' ? body.name : undefined }) }),
    rule('PATCH', new RegExp(`^${B}/(\\d+)$`), 'bc.update', {
      describe: ({ body, result }) => {
        const change = [body?.name !== undefined && 'nome', body?.accessToken ? 'token de acesso' : null, body?.shared !== undefined && 'compartilhamento'].filter(Boolean); // só O QUE mudou, nunca o valor (o token nunca é copiado)
        return result?.businessCenter ? { target: result.businessCenter.name, details: { change: change.join(', ') } } : null;
      },
    }),
    rule('POST', new RegExp(`^${B}/(\\d+)/sync$`), 'bc.sync', { describe: ({ result }) => (result?.businessCenter ? { target: result.businessCenter.name, details: { count: result.businessCenter.advertiserCount } } : null) }),
    rule('DELETE', new RegExp(`^${B}/(\\d+)$`), 'bc.remove', {
      before: async ({ actor, match, lookups }) => (await lookups.businessCenter(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
    rule('POST', new RegExp(`^${B}/(\\d+)/advertisers$`), 'advertiser.create', {
      describe: ({ result }) => {
        const created = Array.isArray(result?.created) ? result.created : [];
        return created.length ? { target: result.businessCenter?.name, details: { count: created.length, accounts: created.map((c) => (c.name ? `${c.name} (ID ${c.id})` : `ID ${c.id}`)) } } : null;
      },
    }),
    rule('POST', /^\/api\/proxies$/, 'proxy.create', { describe: ({ result }) => ({ target: result?.proxy?.name }) }),
    rule('PATCH', /^\/api\/proxies\/(\d+)$/, 'proxy.update', { describe: ({ result }) => ({ target: result?.proxy?.name }) }),
    rule('DELETE', /^\/api\/proxies\/(\d+)$/, 'proxy.delete', {
      before: async ({ actor, match, lookups }) => (await lookups.proxy(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
    rule('POST', /^\/api\/proxies\/(\d+)\/activate$/, 'proxy.activate', { describe: ({ result }) => ({ target: result?.proxy?.name }) }),
    rule('POST', /^\/api\/proxies\/(\d+)\/deactivate$/, 'proxy.deactivate', { describe: ({ result }) => ({ target: result?.proxy?.name }) }),
    rule('POST', /^\/api\/files$/, 'file.upload', { describe: ({ result }) => ({ target: result?.file?.name }) }),
    rule('DELETE', /^\/api\/files\/(\d+)$/, 'file.delete', {
      before: async ({ actor, match, lookups }) => (await lookups.file(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),

    // ---------- dinheiro ----------
    rule('POST', /^\/api\/tiktok\/balance\/transfer$/, 'balance.transfer', {
      describe: ({ result }) => {
        const t = result?.transfer;
        if (!t || result.duplicate) return null; // repetição de uma operação já feita não é uma ação nova
        return { target: t.advertiserName ?? undefined, details: { amount: money(t.amount, t.currency), direction: t.direction, account: t.advertiserId ? `${t.advertiserName ?? 'Conta'} (ID ${t.advertiserId})` : undefined } };
      },
    }),

    // ---------- equipe (só o dono faz) ----------
    rule('POST', /^\/api\/team\/invites$/, 'team.invite', {
      describe: ({ result }) => (result?.invite ? { target: result.invite.name, details: { email: result.invite.email, areas: areasText(result.invite.areas) } } : null),
    }),
    rule('POST', /^\/api\/team\/invites\/(\d+)\/resend$/, 'team.resend', { describe: ({ result }) => (result?.invite ? { target: result.invite.name, details: { email: result.invite.email } } : null) }),
    rule('DELETE', /^\/api\/team\/invites\/(\d+)$/, 'team.cancel_invite', {
      before: async ({ actor, match, lookups }) => (await lookups.invite(actor.id, Number(match[1]))) ?? null,
      describe: ({ snapshot }) => ({ target: snapshot?.name, details: { email: snapshot?.email } }),
    }),
    rule('PATCH', /^\/api\/team\/members\/(\d+)$/, 'team.member_update', {
      describe: ({ result }) => (result?.member ? { target: result.member.name, details: { areas: areasText(result.member.areas) } } : null),
    }),
    rule('DELETE', /^\/api\/team\/members\/(\d+)$/, 'team.member_remove', {
      before: async ({ actor, match, lookups }) => (await lookups.member(actor.id, Number(match[1])))?.name ?? null,
      describe: ({ snapshot }) => ({ target: snapshot }),
    }),
  ];
}
