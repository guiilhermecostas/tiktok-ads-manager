import { balanceScreen } from './screen.js';

/** Saldo: abas "Business Centers" e "Contas de anúncio" (lista compacta com saldo, total gasto e histórico de depósitos). */
export const balanceBcView = () => balanceScreen('bc');
export const balanceAccountsView = () => balanceScreen('accounts');
