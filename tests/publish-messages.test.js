import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmLabel, confirmMessage, doneLabel, renamedNotice, resultToasts, statusWord } from '../shared/publish-messages.js';

describe('Textos do publicar (ativa ou pausada, várias campanhas)', () => {
  it('statusWord concorda com a quantidade', () => {
    assert.deepEqual([statusWord(true, 1), statusWord(true, 3), statusWord(false, 1), statusWord(false, 2)], ['ativa', 'ativas', 'pausada', 'pausadas']);
  });

  it('a confirmação diz com todas as letras se vai gastar (ativa) ou não (pausada)', () => {
    const base = { what: 'a campanha, o grupo de anúncios e o anúncio de “X”', where: 'em 2 contas', accounts: 2 };
    const paused = confirmMessage(base);
    assert.match(paused, /Tudo será criado PAUSADO: nada começa a gastar/);
    assert.doesNotMatch(paused, /ATIVAS/);
    const active = confirmMessage({ ...base, activate: true });
    assert.match(active, /JÁ ATIVAS: começam a gastar o orçamento assim que o TikTok aprovar/);
    assert.doesNotMatch(active, /PAUSADO/);
  });

  it('com várias cópias a confirmação conta quantas campanhas serão criadas no total', () => {
    const text = confirmMessage({ what: 'x', where: 'em 3 contas', accounts: 3, copies: 5, activate: true });
    assert.match(text, /5 campanhas iguais \(cada uma com grupo de anúncios e anúncio\) em 3 contas, 15 campanhas no total/);
    assert.match(confirmMessage({ what: 'x', where: 'em 1 conta', accounts: 1, copies: 2 }), /2 campanhas iguais .* 2 campanhas no total/);
    assert.doesNotMatch(confirmMessage({ what: 'a campanha…', where: 'em 1 conta', accounts: 1 }), /no total/, 'com uma cópia o texto é o de sempre');
  });

  it('o botão de confirmar e o rótulo da conta seguem a escolha', () => {
    assert.equal(confirmLabel({ accounts: 1 }), 'Publicar (pausada)');
    assert.equal(confirmLabel({ accounts: 1, activate: true }), 'Publicar (ativa)');
    assert.equal(confirmLabel({ accounts: 3, activate: true }), 'Publicar em 3 contas (ativas)');
    assert.equal(confirmLabel({ accounts: 3, copies: 5 }), 'Publicar 15 campanhas (pausadas)');
    assert.equal(doneLabel({}), '✓ Publicada (pausada)');
    assert.equal(doneLabel({ activate: true }), '✓ Publicada (ativa)');
    assert.equal(doneLabel({ copies: 5, activate: true }), '✓ 5 campanhas publicadas (ativas)');
  });

  it('depois de publicar há UM resultado principal: tudo certo, parcial ou nenhum (nunca o aviso de falha junto com o de sucesso)', () => {
    const only = (input) => resultToasts({ requested: 3, copies: 1, ...input });
    const ok = only({ succeeded: 3, failed: 0 });
    assert.deepEqual(ok.map((t) => t.tone), ['success'], 'sucesso total: só o aviso de sucesso (o defeito antigo mostrava também "Nenhuma conta foi publicada")');
    assert.match(ok[0].message, /publicada em 3 contas \(pausadas\)/);
    assert.equal(only({ succeeded: 1, failed: 0, requested: 1 })[0].message, 'Campanha publicada no TikTok (pausada).');
    assert.equal(only({ succeeded: 1, failed: 0, requested: 1, activate: true })[0].message, 'Campanha publicada no TikTok (ativa).');
    const partial = only({ succeeded: 2, failed: 1 });
    assert.deepEqual(partial.map((t) => t.tone), ['danger']);
    assert.match(partial[0].message, /Publicada em 2 de 3 contas/);
    const none = only({ succeeded: 0, failed: 3 });
    assert.deepEqual(none.map((t) => t.tone), ['danger']);
    assert.match(none[0].message, /Nenhuma conta foi publicada/);
  });

  it('várias cópias: o resumo conta campanhas e contas; nomes numerados ganham um aviso à parte', () => {
    const many = resultToasts({ requested: 2, succeeded: 2, failed: 0, created: 10, copies: 5, activate: true });
    assert.equal(many.length, 1);
    assert.equal(many[0].message, '10 campanhas publicadas em 2 contas (ativas).');
    const renamed = resultToasts({ requested: 1, succeeded: 1, failed: 0, renamed: [{ id: '9001', name: 'Nome (2)' }] });
    assert.deepEqual(renamed.map((t) => t.tone), ['success', 'warning']);
    assert.match(renamed[1].message, /ficou como “Nome \(2\)”/);
    assert.equal(renamedNotice([]), null);
  });
});
