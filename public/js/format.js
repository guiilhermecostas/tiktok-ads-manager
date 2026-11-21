import { OBJECTIVES as OBJECTIVE_LIST } from '/shared/campaign-spec.js';

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export const formatMoney = (cents) => currency.format(cents / 100);

export function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date);
}

/** "12,50" | "12.50" | "1.250,90" -> centavos (ou null se inválido). */
export function parseMoneyToCents(text) {
  let value = String(text).trim().replace(/[R$\s]/g, '');
  if (!value) return null;
  if (value.includes(',')) value = value.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

export const centsToInput = (cents) => (cents / 100).toFixed(2).replace('.', ',');

// Rótulos dos objetivos vêm da especificação compartilhada (inclui 'CONVERSIONS', legado das campanhas simples).
export const OBJECTIVES = {
  ...Object.fromEntries(OBJECTIVE_LIST.map((o) => [o.value, o.label])),
  CONVERSIONS: 'Conversões',
};

export const CAMPAIGN_STATUS = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  active: { label: 'Ativa', tone: 'success' },
  paused: { label: 'Pausada', tone: 'warning' },
};

export const USER_STATUS = {
  pending: { label: 'Pendente', tone: 'warning' },
  approved: { label: 'Aprovada', tone: 'success' },
  rejected: { label: 'Rejeitada', tone: 'danger' },
  blocked: { label: 'Bloqueada', tone: 'danger' },
};

/** Valor monetário (unidade, não centavos) na moeda do anunciante; cai para BRL se a moeda for inválida. */
export function formatCurrency(value, currencyCode) {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: /^[A-Z]{3}$/.test(currencyCode ?? '') ? currencyCode : 'BRL' }).format(value);
  } catch {
    return currency.format(value);
  }
}

export const formatNumber = (value) => new Intl.NumberFormat('pt-BR').format(value);
export const formatPercent = (value) => `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value)}%`;

const TIKTOK_OBJECTIVES = {
  TRAFFIC: 'Tráfego',
  WEB_CONVERSIONS: 'Conversões no site',
  CONVERSIONS: 'Conversões',
  APP_PROMOTION: 'Promoção de app',
  LEAD_GENERATION: 'Geração de leads',
  REACH: 'Alcance',
  VIDEO_VIEWS: 'Visualizações de vídeo',
  ENGAGEMENT: 'Engajamento',
  PRODUCT_SALES: 'Vendas de produto',
};
export const tiktokObjective = (value) => TIKTOK_OBJECTIVES[value] ?? (value ? String(value).replaceAll('_', ' ').toLowerCase() : '—');

export function tiktokStatus(value) {
  if (value === 'ENABLE' || value === 'CAMPAIGN_STATUS_ENABLE') return { label: 'Ativa', tone: 'success' };
  if (value === 'DISABLE' || value === 'CAMPAIGN_STATUS_DISABLE') return { label: 'Pausada', tone: 'warning' };
  if (value === 'DELETE' || value === 'CAMPAIGN_STATUS_DELETE') return { label: 'Excluída', tone: 'danger' };
  return { label: value ? String(value).replaceAll('_', ' ').toLowerCase() : '—', tone: 'neutral' };
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
