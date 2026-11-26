import { get, onSessionInvalid } from './api.js';
import { clear, h } from './dom.js';
import { can, isWorkspaceOwner, setSession, state } from './state.js';
import { spinner } from './ui.js';
import { renderLayout } from './views/layout.js';
import { loginView } from './views/login.js';
import { registerView } from './views/register.js';
import { statusView } from './views/status.js';
import { homeChatView } from './views/home-chat.js';
import { managerView } from './views/manager.js';
import { catalogView } from './views/catalog/index.js';
import { reportsView } from './views/reports.js';
import { balanceAccountsView, balanceBcView } from './views/balance.js';
import { reportsHourlyView } from './views/reports-hourly.js';
import { campaignsView } from './views/campaigns.js';
import { openCampaignWizard } from './views/campaign-wizard/index.js';
import { adminView } from './views/admin.js';
import { adminBillingView } from './views/admin-billing.js';
import { adminNotificationsView } from './views/admin-notifications.js';
import { billingView } from './views/billing.js';
import { tiktokAdsView } from './views/tiktok-ads.js';
import { businessCentersView } from './views/business-centers.js';
import { creativesView } from './views/creatives/library.js';
import { adAccountsView } from './views/ad-accounts.js';
import { filesView } from './views/files.js';
import { proxySettingsView } from './views/proxy-settings.js';
import { tiktokConnectedView } from './views/tiktok-connected.js';
import { inviteView } from './views/invite.js';
import { teamView } from './views/team.js';

const root = document.getElementById('app');

// `areas`: áreas liberadas para colaboradores (o dono da conta tem todas); `ownerOnly`: só o dono do espaço. O servidor é quem
// realmente barra; aqui só evitamos mostrar telas que dariam erro.
const PROTECTED_ROUTES = {
  '/': { title: 'Início', view: homeChatView },
  '/campaigns': { title: 'Campanhas', view: campaignsView, areas: ['campaigns'] },
  '/manager': { title: 'Gerenciador', view: managerView, areas: ['campaigns', 'reports'] },
  '/catalog': { title: 'Catálogo', view: catalogView, areas: ['campaigns'] },
  '/creatives': { title: 'Criativos', view: creativesView, areas: ['creatives'] },
  '/reports': { title: 'Relatórios', view: reportsView, areas: ['reports'] },
  '/reports/hourly': { title: 'Gasto por hora', view: reportsHourlyView, areas: ['reports'] },
  '/reports/accounts': { title: 'Relatórios por conta', view: tiktokAdsView, areas: ['reports'] },
  '/balance': { title: 'Saldo', view: balanceBcView, areas: ['accounts'] },
  '/balance/accounts': { title: 'Saldo das contas de anúncio', view: balanceAccountsView, areas: ['accounts'] },
  '/business-centers': { title: 'Contas TikTok', view: businessCentersView, areas: ['accounts'] },
  '/business-centers/accounts': { title: 'Contas de anúncio', view: adAccountsView, areas: ['accounts'] },
  '/business-centers/proxy': { title: 'Proxy', view: proxySettingsView, areas: ['accounts'] },
  '/business-centers/files': { title: 'Arquivos', view: filesView, areas: ['accounts'] },
  '/team': { title: 'Colaboradores', view: teamView, ownerOnly: true },
  '/admin': { title: 'Administração', view: adminView, adminOnly: true },
  '/admin/notifications': { title: 'Notificações', view: adminNotificationsView, adminOnly: true },
  '/admin/billing': { title: 'Assinaturas', view: adminBillingView, adminOnly: true },
  '/billing': { title: 'Plano e cobrança', view: billingView, ownerOnly: true },
};
const GUEST_ROUTES = { '/login': loginView, '/register': registerView };

let renderId = 0;
let cleanup = null;

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  return render();
}

export async function refreshSession() {
  try {
    setSession(await get('/auth/me'));
  } catch {
    setSession(null);
  }
}

async function render() {
  const current = ++renderId;
  cleanup?.();
  cleanup = null;

  const path = location.pathname.replace(/\/+$/, '') || '/';
  const ctx = { navigate, reload: () => render(), refreshSession: async () => { await refreshSession(); await render(); } };

  // 0) Retorno do TikTok após a autorização: página pública (pode abrir em outro navegador, sem sessão).
  if (path === '/tiktok/connected') {
    document.title = 'Conexão com o TikTok · TikTok Ads Manager';
    return mount(tiktokConnectedView());
  }

  // 0b) Convite de colaborador: página pública (a pessoa ainda não tem conta; o token vem no fragmento "#" do link).
  if (path === '/invite') {
    document.title = 'Convite · TikTok Ads Manager';
    return mount(inviteView(ctx));
  }

  // 1) Visitante: só login/cadastro.
  if (!state.user) {
    if (path !== '/login' && path !== '/register') return navigate('/login', { replace: true });
    document.title = `${path === '/login' ? 'Entrar' : 'Criar conta'} · TikTok Ads Manager`;
    return mount(GUEST_ROUTES[path](ctx));
  }

  // 2) Conta pendente/rejeitada/bloqueada: nenhuma navegação é permitida, em qualquer rota.
  if (state.user.status !== 'approved') {
    if (path !== '/') history.replaceState({}, '', '/');
    document.title = 'Acesso em análise · TikTok Ads Manager';
    if (state.user.status === 'pending') cleanup = pollStatus();
    return mount(statusView(ctx));
  }

  // 3) Conta aprovada.
  if (path === '/tiktok') return navigate('/reports/accounts', { replace: true }); // endereço antigo (TikTok Ads)
  if (path === '/login' || path === '/register') return navigate('/', { replace: true });
  // Endereços antigos do assistente (agora é um pop-up): abrem a lista de campanhas e o pop-up por cima.
  if ((path === '/campaigns/new' || path === '/campaigns/edit') && can('campaigns')) {
    const id = Number(new URLSearchParams(location.search).get('id'));
    history.replaceState({}, '', '/campaigns');
    await render();
    openCampaignWizard(ctx, { campaignId: path === '/campaigns/edit' && Number.isSafeInteger(id) && id > 0 ? id : null });
    return undefined;
  }
  const route = PROTECTED_ROUTES[path];
  const allowed = route && (!route.adminOnly || (state.user.role === 'admin' && isWorkspaceOwner())) && (!route.ownerOnly || isWorkspaceOwner()) && (!route.areas || can(...route.areas));
  if (!allowed) {
    document.title = 'Página não encontrada · TikTok Ads Manager';
    return mount(renderLayout(ctx, path, h('div', { class: 'card card--pad' }, h('h2', null, 'Página não encontrada'), h('p', { class: 'muted' }, 'O endereço acessado não existe ou você não tem permissão para vê-lo.'))));
  }
  document.title = `${route.title} · TikTok Ads Manager`;

  const content = h('div', { class: 'page' }, spinner());
  mount(renderLayout(ctx, path, content));
  try {
    const result = await route.view(ctx);
    if (current !== renderId) return; // navegação mais recente venceu
    cleanup = result.cleanup ?? null;
    content.replaceChildren(result.element);
  } catch (err) {
    if (current !== renderId) return;
    content.replaceChildren(h('div', { class: 'alert alert--danger', role: 'alert' }, err.message || 'Não foi possível carregar a página.'));
  }
}

/** Enquanto pendente, consulta o servidor e só re-renderiza quando o status mudar (ex.: admin aprovou). */
function pollStatus() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const before = state.user?.status;
      await refreshSession();
      if (state.user?.status !== before) await render();
    } finally {
      busy = false;
    }
  }, 15000);
  return () => clearInterval(timer);
}

function mount(node) {
  clear(root);
  root.append(node);
  return undefined;
}

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-link]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', render);

// Sessão expirada ou status alterado pelo admin enquanto o usuário navegava.
onSessionInvalid(async () => {
  await refreshSession();
  await render();
});

await refreshSession();
await render();
