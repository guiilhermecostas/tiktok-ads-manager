import { get } from '../../api.js';
import { toast } from '../../ui.js';
import { openCampaignWizard } from '../campaign-wizard/index.js';
import { refQuery } from './detail.js';

/**
 * Abre o assistente de campanha já encaminhado para este catálogo. Sem `defaults` informado, busca o anúncio padrão salvo (criativos da biblioteca,
 * produtos, texto, botão, URL, identidade…) para a campanha já sair preenchida; se a busca falhar, abre mesmo assim, só com o catálogo.
 */
export async function openCatalogCampaign(ctx, catalog, defaults) {
  let chosen = defaults;
  if (chosen === undefined) {
    try {
      chosen = (await get(`/tiktok/catalogs/${encodeURIComponent(catalog.id)}/defaults?${refQuery(catalog)}`)).defaults;
    } catch {
      chosen = null;
      toast('Não foi possível carregar o anúncio padrão do catálogo. Abri a campanha só com o catálogo.', 'danger');
    }
  }
  openCampaignWizard(ctx, { catalog, defaults: chosen ?? null });
}
