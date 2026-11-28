import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmLabel, confirmMessage, doneLabel, renamedNotice, resultToasts, statusWord, verifyToasts } from '../shared/publish-messages.js';

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
    assert.equal(doneLabel({}), '✓ Publicada (pausada) · conferida no TikTok');
    assert.equal(doneLabel({ activate: true }), '✓ Publicada (ativa) · conferida no TikTok');
    assert.equal(doneLabel({ copies: 5, activate: true }), '✓ 5 campanhas publicadas (ativas) · conferida no TikTok');
    assert.equal(doneLabel({ activate: true, verified: false }), '✓ Publicada (ativa) · não deu para conferir no TikTok', 'sem conferência o rótulo não afirma mais do que se sabe');
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
    const unverified = resultToasts({ requested: 1, succeeded: 1, failed: 0, unverified: 1 });
    assert.deepEqual(unverified.map((t) => t.tone), ['success', 'warning']);
    assert.match(unverified[1].message, /não pôde ser conferida no TikTok/);
    assert.match(resultToasts({ requested: 3, succeeded: 3, failed: 0, unverified: 2 })[1].message, /^2 publicações não pôde ser conferida/);
  });

  it('depois de "Conferir no TikTok": diz o que existe, o que faltou (e que a conta voltou para tentar de novo) e o que não deu para conferir', () => {
    assert.deepEqual(verifyToasts([]).map((t) => t.tone), ['warning']);
    const ok = verifyToasts([{ advertiserId: '1', state: 'ok', missing: [] }]);
    assert.deepEqual(ok.map((t) => t.tone), ['success']);
    assert.match(ok[0].message, /a campanha, o conjunto de anúncios e o anúncio existem/);
    assert.match(verifyToasts([{ advertiserId: '1', state: 'ok', missing: [] }, { advertiserId: '2', state: 'ok', missing: [] }])[0].message, /2 publicações/);
    const broken = verifyToasts([{ advertiserId: '9001', state: 'ok', missing: [] }, { advertiserId: '9002', state: 'missing', missing: ['adGroup', 'ad'] }]);
    assert.deepEqual(broken.map((t) => t.tone), ['success', 'danger']);
    assert.match(broken[1].message, /Conta 9002: não encontramos o conjunto de anúncios e o anúncio no TikTok/);
    assert.match(broken[1].message, /voltou para “tentar de novo”/);
    const unknown = verifyToasts([{ advertiserId: '1', state: 'unverified', missing: [] }]);
    assert.deepEqual(unknown.map((t) => t.tone), ['warning'], 'sem conseguir conferir, nunca afirma que está tudo certo');
  });
});
