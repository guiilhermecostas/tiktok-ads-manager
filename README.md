# TikTok Ads Manager

Plataforma web para gerir a operação de TikTok Ads, com painel estilo Shopify Admin, paleta TikTok
(preto `#010101`, ciano `#25F4EE`, vermelho `#FE2C55`), cadastro/login e **aprovação de contas pelo administrador**.

## Como rodar

```bash
npm install
cp .env.example .env     # defina ADMIN_PASSWORD, TOKEN_ENCRYPTION_KEY e DATABASE_URL (Supabase)
npm run db:migrate       # cria/atualiza as tabelas no banco (idempotente)
npm start                # http://localhost:3100
npm test                 # suíte automatizada (sem rede, Postgres embutido)
npm run lint             # análise estática (ESLint), inclui proibição de innerHTML
npm run check            # lint + testes
npm run test:live        # (opcional, usa rede) contrato real com a API do TikTok usando um token FALSO
npm run test:db-live     # (opcional, usa o banco do .env) testa o banco REAL em uma transação sempre desfeita
npm run db:check         # diagnóstico do banco (conexão, TLS, schema, migrações, RLS), sem alterar nada
npm run import:sqlite    # importação ÚNICA dos dados do banco antigo (SQLite) para o banco atual
```

Requer Node >= 22.13 (`scrypt`, `fetch` e test runner nativos). Dependências de produção: `express`, `helmet` e `pg`.

## Banco de dados (Supabase / PostgreSQL)

- O sistema usa **PostgreSQL** pela connection string `DATABASE_URL` (Supabase). Conexão por pool, **TLS com verificação do
  certificado sempre ligada** (CA oficial do Supabase em `certs/supabase-ca.crt`, informada em `DATABASE_SSL_CA_PATH`).
- **Isolamento:** o sistema usa um **papel próprio** (`tiktok_ads_app`, sem superusuário, sem `BYPASSRLS`) e um **schema próprio**
  (`tiktok_ads`, `DATABASE_SCHEMA`), que não é exposto pela API REST do Supabase e não encosta no schema `public` nem em outros
  sistemas do mesmo projeto. Preparação (uma vez): `scripts/supabase-setup.sql`.
- **RLS ligado em todas as tabelas, sem políticas, e nenhum privilégio** para `anon`, `authenticated` e `service_role`: mesmo que uma
  chave da API do Supabase vaze, estas tabelas continuam inacessíveis pela API REST. O sistema só acessa o banco pelo servidor.
  As migrações revogam privilégios **apenas das tabelas e sequências do próprio app** e, ao subir, uma checagem recusa tabela nova
  do app sem RLS (em produção).
- **Migrações** (`src/db/migrations.js`): versionadas na tabela `schema_migrations`, aplicadas em uma transação com trava
  (várias instâncias subindo juntas não se atropelam). Nunca edite uma migração já aplicada: crie a próxima versão.
- **Pooler:** use o *Session pooler* (porta 5432) ou a conexão direta. Em modo *transaction* (6543) funciona, mas prefira sessão.
- **Sem `DATABASE_URL`** (somente desenvolvimento/testes) o sistema usa um Postgres embutido (PGlite, em `data/pglite`). Em produção
  `DATABASE_URL` é obrigatória.
- **Migrar dados do SQLite antigo:** `npm run import:sqlite -- --dry-run` (simulação) e depois `npm run import:sqlite`. Preserva IDs e
  senhas (hash), é tudo-ou-nada e só roda em banco de destino vazio. Sessões não são copiadas (todos entram de novo).

## Fluxo de contas

1. Qualquer pessoa se cadastra em `/register` em **duas etapas**: (1) preenche os dados e o sistema envia um **código de 6 dígitos** para o e-mail; (2) digita o código e **só então a conta é criada**, com status **pendente** e já com o **plano padrão (US$ 0 de mensalidade + 10% do gasto em anúncios)**, que o admin pode mudar depois por pessoa.
   - O código vale **10 minutos**, aceita **5 tentativas** (depois o cadastro é descartado) e só pode ser reenviado **1 vez por minuto, no máximo 5 vezes**. No banco ficam só os *hashes* do código e da senha.
   - Um **ticket secreto** (que só o navegador de quem se cadastrou tem) liga o código ao cadastro certo: ninguém troca os dados do cadastro de outra pessoa. E-mail que já tem conta (e o do admin) recebem a mesma resposta, sem envio, para não revelar quem tem conta. Há limite por e-mail (5 códigos/hora) e por IP.
   - Precisa do envio de e-mail configurado (`RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`, os mesmos dos convites): sem isso o cadastro responde 503, nunca pula a verificação.
   - Contas que entram por **convite de colaborador** não passam por este fluxo (o link do convite já prova o e-mail) e não recebem plano: a cobrança é do dono do espaço.
2. Pendente/rejeitada/bloqueada vê apenas uma tela de status; **toda** a API (exceto login/cadastro/`me`/logout) responde `403`.
3. O admin (`ADMIN_EMAIL`) acessa **Administração**, e aprova, rejeita, bloqueia ou reativa. A mudança vale na próxima requisição; rejeitar/bloquear derruba as sessões na hora.

## Administrador

- E-mail: `ADMIN_EMAIL` (padrão `contato.guilhermecostas@gmail.com`). A conta é criada na inicialização com a senha de `ADMIN_PASSWORD`.
- Esse e-mail **não pode ser usado no cadastro público**, e ninguém consegue "tomar" a conta de admin registrando-o antes.
- Sem `ADMIN_PASSWORD`, uma senha aleatória é gerada e exibida uma vez no console.
- Para trocar a senha: altere `ADMIN_PASSWORD` e reinicie (sessões antigas do admin são encerradas).

### Administração: acessar a conta de um usuário, bloquear e registro de ações

Em **Administração → Contas**, cada conta aprovada tem **Acessar conta** (um clique) e **Bloquear**:

- **Acessar conta** abre a conta da pessoa **como ela vê**, só para **consulta**: qualquer alteração (criar campanha, transferir saldo, mudar perfil, pausar anúncio…) é recusada com `403 impersonation_read_only`
  e os **arquivos com logins** nem abrem. Só vale para contas **comuns e aprovadas** (nunca outro admin, nunca a própria conta), dura **1 hora**, tem limite de 30 entradas por hora e fica
  no registro. É uma **sessão nova** marcada com o admin (`sessions.impersonator_id`); se o admin deixar de ser admin aprovado, ela cai na hora, e bloquear a pessoa também a derruba.
  Uma faixa fixa no topo mostra “Você está na conta de …” com **Voltar ao admin** (`POST /api/auth/impersonation/exit` devolve uma sessão nova do admin).
- **Bloquear/Reativar** derruba as sessões na hora (inclusive as abertas por admin).
- **Registro de ações** (`admin_audit_log`, só acrescenta linhas): entrar/sair da conta de alguém, mudanças de status e envio/alteração de notificações. Aparece no fim da tela.

### Assinaturas (planos e faturas em REAL, câmbio, gasto guardado e bloqueio de BC com débito)

**Tudo o que se cobra e se paga é em REAL (R$)**, em centavos inteiros; o gasto das contas em outra moeda é convertido (veja "Câmbio"). Em **Administração → Assinaturas** cada pessoa tem o **próprio plano, negociável**: mensalidade + percentual do gasto em anúncios
(ex.: A = R$ 0 + 10%, B = R$ 99,90 + 5%, C = R$ 199,90 + 0%). O plano vale "este mês" (o mês inteiro) ou "próximo mês"; o plano de cada mês é guardado, então mudar o acordo nunca
altera o passado. A pessoa vê o próprio extrato em **Plano e cobrança** (só leitura).

- **Gasto que não some:** a coleta por hora também grava o gasto em `spend_ledger` (por dono e conta, **sem ligação com a conexão da BC**): remover a BC não apaga nem reduz nada. O valor
  de uma hora só sobe (apagar anúncios depois não baixa a cobrança). Uma vez por dia por conta o sistema reconfere os últimos 3 dias (recupera horas se o servidor ficou fora do ar), e **antes de
  remover uma BC faz uma última coleta**. Quem tem histórico não pode ser excluído (`ON DELETE RESTRICT`).
- **Meses:** em UTC; o mês fecha **uma vez**, 2 dias depois de acabar, guardando plano e cotações da época. O mês em andamento é calculado ao vivo. Saldo = cobrado − pago; débito = saldo positivo.
  O admin registra pagamentos (não podem ser apagados) e vê o extrato de cada pessoa; tudo vai para o registro de ações.
- **Bloqueio por débito:** se a pessoa **remove uma BC com débito**, a BC e as contas dela ficam bloqueadas para **outras pessoas** (`409 billing_locked`, sem revelar de quem é a dívida), tanto por token quanto por link.
  Cai sozinho quando a dívida zera, quando a própria dona reconecta ou quando o admin libera. Falha fechada: se não der para gravar o bloqueio, a remoção da BC **não** acontece.
- **Câmbio (tudo vira real):** o gasto de cada conta, na moeda dela (USD, EUR, ARS…), é convertido para real com aritmética inteira (`convertToBrlCents` em `shared/billing.js`, sem erro de ponto flutuante, arredondando o meio centavo para cima).
  As cotações (`billing_rates`: quantos reais vale 1 unidade) são **atualizadas sozinhas a cada 6 h** de uma fonte pública e **sem chave** (Frankfurter, https://frankfurter.dev, API v2 `GET /v2/rates?base=BRL&quotes=…`; a resposta "1 BRL = X moeda" é invertida);
  na requisição vai só a lista de moedas, nenhum dado de pessoa, conta ou valor. O admin pode **fixar uma cotação à mão** (nunca é sobrescrita pela automática) e "voltar para automática"; há o botão "Atualizar cotações agora". Se a fonte
  falhar, as últimas cotações guardadas continuam valendo e o erro aparece no painel (sem endereços). O mês em andamento usa a cotação de agora; **ao fechar, o gasto por moeda e a cotação usada ficam guardados** no fechamento (mudar a cotação depois não altera o passado).
  Moeda sem cotação NÃO entra na conta e é avisada ("sem cotação"). Configuração: `BILLING_FX_AUTO=false` desliga a automática; `BILLING_FX_URL` só aceita https no domínio frankfurter.dev (`/v2`). A tela mostra, por mês, "US$ 96,00 × R$ 5,4321".
- **Faturas (método de pagamento dentro da plataforma):** quando os meses fechados, somados e ainda sem fatura, chegam a **R$ 50,00** (`INVOICE_MIN_CENTS`), a plataforma emite uma **fatura** com esse valor, cobrindo os meses desde a anterior, com vencimento em 5 dias. Abaixo de R$ 50,00 o valor
  **acumula** e entra na fatura seguinte (ninguém recebe fatura menor que isso). A situação de cada fatura (**paga / paga em parte / vencida / em aberto**) é **calculada** a partir dos pagamentos, que quitam as faturas da mais antiga para a mais nova: não existe "marcador de pago" que possa
  ficar fora de sincronia. A pessoa vê as faturas em **Plano e cobrança** (e o que está acumulando).
- **Marcar fatura como paga (admin):** em **Administração → Assinaturas → Faturas**, o admin marca a fatura mais antiga em aberto como paga quando o cliente pagou por fora (data e observação opcionais). Isso registra um pagamento do valor que FALTA da fatura (o valor nunca vem do navegador), ligado a ela, e entra no extrato
  e no registro de ações. Duas marcações ao mesmo tempo pagam uma vez só. Também há o pagamento avulso (qualquer valor). API: `POST /api/admin/billing/users/:id/invoices/:invoiceId/pay`, `PUT/DELETE /api/admin/billing/rates/:moeda`, `POST /api/admin/billing/rates/refresh`.
- Valores antigos em dólar (planos, fechamentos, pagamentos e dívidas de bloqueio) foram convertidos uma única vez na migração 27 por uma cotação de referência fixa de R$ 5,50 por dólar (as cotações antigas, em dólar, foram descartadas). **Se houver valores reais antigos, o admin deve conferi-los.**
- Não há cobrança automática (cartão/PIX): o sistema calcula, emite a fatura, mostra e registra o que foi pago; quem confirma o pagamento é o admin.


### Notificações (o sino do topo)

O sino fica no canto direito do topo: selo com as não lidas e um painel com as 30 mais recentes (atualiza a cada minuto com a aba visível). Em **Administração → Notificações** o admin escreve
título, mensagem, **tipo** (aviso, novidade, atenção, urgente), **quem recebe** (todos ou uma pessoa), um atalho para uma tela do sistema (só caminhos internos) e a **validade**; a lista mostra
quantas pessoas já leram e permite desativar, reativar ou excluir. A leitura é de cada pessoa (`notification_reads`); o servidor só mostra e só marca o que é da pessoa (sem IDOR).
Rotas: `GET /api/notifications`, `POST /api/notifications/read`; admin: `/api/admin/notifications`. Colaboradores recebem as notificações **deles** (a pessoa), não as do dono do espaço.

### Assistente do Início: perguntas sobre a operação

A tela é limpa: só o campo de escrever (bordas 100% arredondadas), com **microfone** (ditado pelo navegador, quando disponível) e **sugestões enquanto você digita** (`shared/chat-suggest.js`; a tecla `/` mostra tudo o que o assistente sabe responder).

Além dos tutoriais, o chat responde, com os mesmos dados das telas e citando o período ("hoje", "ontem", "nos últimos 7 dias", "este mês"): **quantas BCs e contas**, **contas que caíram**, **anúncios reprovados**,
**criativos enviados**, **gasto total**, **melhores criativos** e **melhores anúncios em custo**. Não há modelo de linguagem: a pergunta é reconhecida por palavras-chave (`shared/assistant-intents.js`) e as
contas/rankings são funções puras (`shared/assistant-ops.js`). Limites ditos nas respostas: "caiu" = mudança de situação **vista** pela coleta a cada 30 min (`advertiser_status_events`, a partir de
quando o acompanhamento começou); o TikTok não dá o horário exato da reprovação de um anúncio; "criativo" é o anúncio (o TikTok não liga o anúncio ao arquivo da biblioteca); valores de moedas diferentes não se misturam.

## Integração TikTok (Business Centers)

1. Qualquer usuário aprovado abre **Contas TikTok → Conectar Business Center**. Há dois caminhos:
   - **Por link (recomendado):** informa só um nome, o sistema gera um **link de autorização** (vale 15 min, uso único). O usuário
     copia o link, abre no navegador/perfil em que está logado na Business Center do TikTok, escolhe as contas de anúncio e confirma.
     A janela do sistema acompanha sozinha e conclui a conexão. Não é preciso copiar tokens nem IDs. Requer o app do TikTok
     configurado no servidor (abaixo).
   - **Por token (avançado):** informa o **ID da BC** e um **token de acesso** da Marketing API. O servidor valida o token no TikTok
     antes de gravar e sincroniza as contas de anúncio. Fica disponível em “Prefiro colar um token” e é o caminho usado quando o app
     do TikTok não está configurado.
2. **Cartões compactos e minimalistas:** cada conexão da aba **Business Centers** é um cartão baixo (cerca de 170 px, vários por linha; antes mais de 330 px), todos da mesma linha com a MESMA altura e os botões alinhados na base: uma bolinha de situação (verde = funcionando, vermelha = com erro), o nome, o número de contas, uma linha de detalhes
   ("Por link/Por token · Só você/Compartilhada · Via proxy"), a moeda e a data da última atualização em texto simples, as Business Centers em fichinhas com o ID (clique copia; só a primeira aparece e o resto fica em "+N", para a altura não depender de quantas BCs a conexão tem) e **só dois botões à vista**
   (**+ CA** e **Atualizar**) mais o menu **⋯** (Renovar acesso, Editar, Remover — o menu de contexto compartilhado `public/js/views/context-menu.js`). Com erro, o motivo aparece em destaque e o botão principal vira o que resolve (**Renovar acesso** ou **Editar**).
   As telas de Proxy e Contas de anúncio seguem com o cartão padrão (`hubCard`).
   **Contas TikTok** tem três sub-abas, no mesmo layout centralizado (cabeçalho, abas segmentadas e cartões de largura igual; no celular as
   listas viram cartões empilhados): **Business Centers** (as conexões), **Contas de anúncio** (todas as contas disponíveis, cada uma com
   a Business Center de origem, tipo de conexão, moeda, fuso e status; com busca por nome/ID e filtro por BC).
   **ID da BC em conexões por link:** a autorização do TikTok não devolve o ID da Business Center, por isso ele não é digitado nem
   guardado na conexão. O sistema o obtém na sincronização: lê o campo `owner_bc_id` de cada conta de anúncio (`advertiser/info`) e, se o
   TikTok não o informar, consulta `/bc/get/` e só usa o resultado quando o token enxerga **exatamente uma** BC (nunca adivinha). O ID é
   gravado por conta (`tiktok_advertisers.owner_bc_id`, só dígitos) e aparece no cartão da BC e na lista de contas. Se o TikTok não
   informar, o cartão mostra “—” com uma explicação; “Sincronizar” tenta de novo (conexões criadas antes disso preenchem o ID assim).
   Os dois endpoints são tratados de forma defensiva (resposta sem o campo não gera erro); a resposta real do TikTok ainda precisa ser
   conferida com um token de verdade.
   **Etiqueta “Conta de agência”:** na aba “Contas de anúncio” cada conta tem um seletor de tipo (conta comum ou conta de agência),
   individual ou em lote (marque várias e use a barra “Marcar como conta de agência”). Só o dono da BC e o admin etiquetam; contas de BCs
   compartilhadas aparecem com a etiqueta, mas somente o admin a altera. A etiqueta é do sistema (não vem do TikTok), fica em
   `tiktok_advertisers.label` e **sobrevive à sincronização e à troca de token**. Na aba, e também no passo “Publicar em” da campanha, há
   filtros por **tipo** (todas, comuns, de agência) e por **situação** (ativas, inativas = BC com erro de acesso); na publicação, o atalho
   “Marcar todas as listadas” seleciona só o que o filtro mostra, o resumo detalha “N de agência, M comuns” e um aviso lembra de publicar
   um tipo de cada vez quando a seleção mistura os dois. API: `PATCH /api/tiktok/business-centers/:id/advertisers` com
   `{ "advertiserIds": ["…"], "label": "agency" | null }` (1 a 200 contas da mesma BC; tudo ou nada). Regras e nomes em `shared/account-labels.js`.
   **Criar contas de anúncio (“+ CA”):** o botão no cartão da conexão abre um pop-up que cria de 1 a 10 contas de leilão (AUCTION) dentro de uma
   Business Center do TikTok da conexão (`POST /open_api/v1.3/bc/advertiser/create/`, uma chamada por conta, em sequência, com pausa). Só pede a
   **quantidade** e um **nome** (várias viram “Nome 01”, “Nome 02”…); moeda, fuso, empresa, país e e-mail de contato vêm **pré-preenchidos** de uma conta
   que a BC já tem (`GET /api/tiktok/business-centers/:id/advertiser-defaults?bcId=`, melhor esforço) e podem ser corrigidos. Pede confirmação antes
   (a criação não se desfaz por aqui). Regras: só o dono da conexão/admin (ou colaborador com a área “Contas TikTok”), BC do TikTok precisa ser uma da
   conexão, uma criação por vez por conexão (409), no máximo 6 pedidos a cada 10 minutos por usuário, e se uma conta falhar as seguintes **não** são
   tentadas (o resultado diz o que já foi criado). Ao final a conexão é relida para as contas aparecerem; se não aparecerem (o TikTok pode demorar, ou o
   token do link só lista contas autorizadas), a tela orienta a usar “Atualizar contas”/“Renovar acesso”. API: `POST /api/tiktok/business-centers/:id/advertisers`
   com `{ bcId, count, name, currency, timezone, company, registeredArea, industry?, contactEmail?, contactName? }`. Regras em `shared/advertiser-create.js`.
   **Contrato oficial (conferido na documentação do TikTok):** obrigatórios `bc_id`, `advertiser_info` (`name` até 100, `currency` = a da BC, `timezone` = código da tabela oficial, `type`
   AUCTION), `customer_info` (`company`, `industry` = ID de nível 2 como NÚMERO, `registered_area`). O sistema lê a BC em `/bc/get/` e: usa a **moeda da BC** (travada), o **fuso** e o **país** dela
   como sugestão, só aceita **fusos da tabela oficial** (`Etc/GMT+5` e parecidos dão "Information for this time zone does not exist"), mostra a lista **oficial de ramos** do tipo da BC
   (autoatendimento ou não; com busca), exige `qualification_info.promotion_link` (site da empresa) em BC de **agência** (AGENCY/SELF_SERVICE_AGENCY), NÃO envia `qualification_info` em BC DIRECT,
   bloqueia quem não é **administrador** da BC e recusa países que exigem documentos (BR, MX, FR, CN, HK: licença/CNPJ, imagens, e-mail e cobrança, ainda não enviados por aqui). Erros comuns do
   TikTok viram instruções em português (com a mensagem original entre parênteses). Listas oficiais em `shared/tiktok-timezones.js`, `tiktok-locations.js` e `tiktok-industries.js`.
   **E-mail de contato:** o TikTok devolve o e-mail da conta **mascarado** (`l***@***`, documentação de `/advertiser/info/`); ele nunca é pré-preenchido nem enviado (só um endereço completo). O e-mail só é obrigatório para BR, MX e FR.
   **Pop-up em 3 etapas** (Contas → Empresa e região → Revisar e criar), de tamanho fixo: só o miolo rola e o rodapé fica sempre visível; qualquer pop-up do sistema tem altura máxima = a da tela, com rolagem interna.
   **Pendente de conferência com o TikTok real:** a permissão do token (precisa ser de administrador da BC com acesso à gestão de contas), o formato da
   resposta (o ID é lido de forma defensiva) e as exigências por país (ex.: Brasil, México e França pedem documentos/CNPJ e e-mail; o sistema mostra o
   erro do TikTok quando faltarem — ainda não há envio de documentos).
   **Situação das contas de anúncio (ativa, encerrada, punida, em análise…):** “Atualizar” (e a conexão, e a coleta por hora a cada 30 min) lê `status` em `/advertiser/info/` (tabela “Advertiser Status” do TikTok) e
   guarda em `advertiser_status` (a mesma tabela do assistente: cada mudança vira um evento, então uma conta que cai aparece em “contas que caíram” já ao atualizar). A aba **Contas de anúncio** mostra o
   selo de cada conta (Ativa, Encerrada, Punida pelo TikTok, Reprovada, Em análise…, “Acesso com erro” se a conexão caiu, “Sem informação” se ainda não foi lida) com desde quando e quando foi lida; o filtro
   “Somente ativas/inativas” e a publicação de campanhas usam essa situação (conta sem leitura ainda conta como ativa); o cartão da conexão mostra “N inativas” e o aviso do “Atualizar” diz quantas.
   Regras de rótulo e tom em `shared/account-labels.js` (`accountHealth`). A leitura é melhor esforço: se falhar, a atualização das contas continua. API: `GET /api/tiktok/advertisers` traz `accountStatus`, `accountStatusSince`,
   `accountStatusCheckedAt`; os cartões (`GET /api/tiktok/business-centers`) trazem `inactiveCount`.
   **Vincular pixel a contas de anúncio (“⋯ → Vincular pixel…”):** faz pela API o que se faz no Gerenciador de Eventos (pixel → Ativos → escolher a conta de
   anúncio), para várias contas de uma vez. O pop-up lista os pixels que uma conta da conexão já enxerga (`/pixel/list/`, com nome, **código** e a BC dona
   `owner_bc_id`) ou aceita digitar o código; as contas da conexão aparecem com uma marca “Vinculada” quando já têm o pixel (`/bc/pixel/link/get/`).
   “Vincular (N)” / “Desvincular (N)” chamam `POST /open_api/v1.3/bc/pixel/link/update/` (`bc_id`, `pixel_code`, `advertiser_ids`, `relation_status` = `LINK`/`UNLINK`);
   desvincular pede confirmação e depois o vínculo é lido de volta para conferir. O mesmo pop-up abre pelo botão “Vincular pixel…” ao lado da lista de pixels
   do campo “ID do Pixel” do assistente (só para quem é dono da conexão), e a lista da conta é atualizada na hora. API (dono da conexão ou admin; área “Contas TikTok”):
   `GET /api/tiktok/business-centers/:id/pixel-links?bcId=&pixelCode=` → `{ advertiserIds }` e `POST /api/tiktok/business-centers/:id/pixel-links` com
   `{ bcId, pixelCode, advertiserIds: [1 a 50], action: 'LINK' | 'UNLINK' }`. Regras: o código tem 6 a 40 letras/números; a BC do TikTok precisa ser uma da conexão
   (400); só contas DESTA conexão (404, nada é enviado ao TikTok); um vínculo por vez por conexão (409); no máximo 30 pedidos a cada 10 minutos por usuário; só a conexão
   ativa; o token nunca sai do servidor; a ação entra no registro de atividades (“Vinculou ou desvinculou um pixel…”). Regras e limites em `shared/pixel-link.js`.
   **Pendente de conferência com o TikTok real:** a permissão do token (administrador do pixel e das contas na BC), e se `/bc/pixel/link/get/` pagina (a documentação não
   tem parâmetros de página; o código pede as páginas seguintes só se a resposta disser que há mais e para quando nada novo chega).
   **Cada usuário enxerga e usa apenas as próprias BCs** (Início, TikTok Ads e publicação de campanhas). Nunca vê as de outros.
3. **Compartilhamento:** somente o admin pode marcar uma BC como "compartilhada com a equipe" (em Conectar/Editar). BCs
   compartilhadas aparecem para todos como somente leitura. As BCs que existiam antes desta mudança ficaram compartilhadas.
4. **Gerenciar** (editar, trocar token, sincronizar, remover) cabe ao dono e ao admin. O admin supervisiona todas as BCs (com o
   nome do dono) na aba Contas TikTok, mas os dados nas telas dele usam só as BCs dele e as compartilhadas.
5. Token revogado/expirado: a BC fica marcada com erro e deixa de servir dados até o dono informar um novo token (Editar).
6. Requer `TOKEN_ENCRYPTION_KEY` no `.env` (32 bytes em base64). Sem ela o cadastro fica desligado.

### Proxy nas chamadas ao TikTok

Para vender em outro país (ex.: Estados Unidos) sem o TikTok bloquear por causa do IP, cadastre uma proxy em **Contas TikTok → Proxy**.

- **Tipos:** HTTP, HTTPS, SOCKS4 e SOCKS5, com usuário e senha. Dá para colar a proxy como o provedor entrega
  (`socks5://usuario:senha@host:porta` ou `host:porta:usuario:senha`) e o formulário se preenche sozinho.
- **Testar:** conecta pela proxy, mostra o **IP e o país de saída** e confirma que a API do TikTok responde.
- **Ativar:** só uma proxy fica ativa por usuário. Com ela ativa, **TODAS** as chamadas à API do TikTok das Business Centers
  desse usuário saem por ela: sincronizar, relatórios, campanhas, envio de criativos, criação de campanha/grupo/anúncio,
  validação do token e a conexão por link (inclusive a troca do código com o App Secret).
- **Sem vazamento do IP:** se a proxy ativa falhar, a chamada **falha** (`proxy_error`); o sistema nunca tenta de novo pela
  conexão direta. Quando a proxy volta, tudo volta a funcionar sozinho.
- **De quem é a proxy:** vale a proxy do **dono da Business Center** (assim o IP daquela BC é sempre o mesmo). Uma BC
  compartilhada pelo administrador usa a proxy do administrador; o admin mexendo na BC de um usuário usa a proxy desse usuário.
  As telas mostram o selo "Via proxy" nas BCs, sem revelar nome ou endereço da proxy a outras pessoas.
- **Segurança:** usuário e senha ficam criptografados (AES-256-GCM, mesma chave dos tokens) e a senha nunca volta ao navegador.
  O TLS com o TikTok é de ponta a ponta (a proxy só vê bytes cifrados e não consegue ler o token). Como o servidor se conecta
  ao endereço que o usuário informa, redes internas (loopback, privadas, link-local/metadados da nuvem, IPv6 equivalentes) são
  **bloqueadas** e o IP é validado a cada uso (contra DNS rebinding). Limite de 20 proxies por usuário e de testes por minuto.
- Se o servidor já está nos EUA (ex.: Render em Ohio), a proxy ainda é útil quando você quer um IP fixo ou residencial.
  O uso de proxy pode ser restrito pelas regras do TikTok: confira os termos antes de usar.

### Conexão por link: como habilitar

1. No [portal de desenvolvedores do TikTok](https://business-api.tiktok.com/portal/apps), crie um app (Marketing API) e peça as permissões
   de leitura de contas/relatórios e gestão de anúncios que o sistema usa.
2. No app, cadastre a **Redirect URL** = `TIKTOK_REDIRECT_URI` (endereço público do sistema + `/api/tiktok/callback`, https em produção).
3. No `.env`, defina `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` e `TIKTOK_REDIRECT_URI`; reinicie. Para o administrador, a tela de conexão
   mostra a URI esperada enquanto o link não estiver habilitado.

Como funciona e como é protegido: o link leva um `state` aleatório de 256 bits (no banco fica só o SHA-256), de **uso único** e 15 min,
emitido para um usuário logado e aprovado; o retorno do TikTok (`GET /api/tiktok/callback`) é público de propósito (chega de outro
navegador/perfil, sem a sessão do sistema), mas só é aceito com um `state` válido, tem limite por IP e redireciona para uma página
que mostra apenas o resultado. O código de autorização é trocado no servidor (App Secret nunca vai ao navegador nem à URL), o token
recebido é guardado criptografado e a tela só vê o resultado da **própria** tentativa. Reautorizar as mesmas contas atualiza a conexão
existente. Atenção: quem autoriza por um link liga as próprias contas ao usuário que o gerou; por isso a tela avisa para usar
apenas links gerados por você e não os compartilhar. Se o usuário fechar a janela, o link é invalidado.

Segurança dos tokens: AES-256-GCM no banco, nunca enviados ao navegador nem registrados em log (nem para o admin), campo
`password` no formulário, rate limit nas operações de escrita, `advertiser_id` só aceito se pertencer a uma BC visível ao usuário
(acesso a BC alheia responde 404 para não revelar que existe), cache de 1–5 min contra rate limit do TikTok.

> **Verificação da API do TikTok.** Os 7 endpoints usados (`bc/asset/get`, `advertiser/info`, `campaign/get`, `report/integrated/get`,
> `campaign/create`, `adgroup/create`, `ad/create`) foram confirmados contra a API real com `npm run test:live`: caminhos,
> cabeçalho `Access-Token`, envelope `{code, message, request_id, data}` e erro de token (40105). Os nomes dos campos de criação seguem
> os modelos do SDK oficial (`tiktok/tiktok-business-api-sdk`). **Ainda não validado com um token real**: o formato das respostas de
> *sucesso* e os valores aceitos em cada campo (enums) dependem de uma conta; eles são lidos de forma defensiva e testados com um
> TikTok simulado (`tests/fake-tiktok.js`). O limite de requisições do TikTok vira erro 429 com `Retry-After`.
> Ao usar um token real, confira em *Contas TikTok → Sincronizar* se as contas aparecem; ajustes de campo ficam isolados em
> `src/modules/tiktok/tiktok.client.js`.

## Colaboradores (acesso por e-mail, sem compartilhar login)

O dono da conta convida pessoas em **Colaboradores** (menu “Gestão”). Cada colaborador entra com o **próprio e-mail e senha** e
trabalha dentro do espaço do dono (mesmas Business Centers, criativos e campanhas), **só nas áreas liberadas**:

| Área | Libera |
|---|---|
| **Criativos** | Biblioteca: enviar, renomear, excluir. |
| **Campanhas** | Criar, editar e publicar campanhas; inclui ver os criativos e as contas de anúncio. |
| **Relatórios** | Início e TikTok Ads (gasto, cliques, conversões). |
| **Contas TikTok** | Business Centers, contas de anúncio, etiquetas e proxy. |
| **Acesso total** | Todas as áreas acima. **Nunca** inclui gerenciar colaboradores nem a administração do sistema. |

- **Fluxo:** o dono informa nome, e-mail e as áreas → o sistema envia o convite pelo **Resend** → a pessoa abre o link, define a senha
  (mínimo de 10 caracteres) e já entra. O convite vale **7 dias**, é de **uso único** e pode ser reenviado (o link anterior morre) ou cancelado.
  Mudar as áreas ou remover o colaborador vale **na hora** (a conta dele é apagada e as sessões caem). Os dados criados por ele ficam com o dono.
- **Segurança:** token de 256 bits só no e-mail (no banco só o SHA-256); o link leva o token no fragmento `#…` (o navegador não o envia
  em requisição nem aparece em log) e ele segue apenas no corpo de POSTs; a mesma resposta para convite inexistente, expirado ou já usado;
  limites por IP e por conta (`429`); toda rota exige a área certa **no servidor** (o menu só esconde o que daria erro); colaborador nunca é
  admin (nem no espaço de um admin), não compartilha BC com a equipe e não gerencia equipe; se o dono for bloqueado, a equipe cai junto.
  Se o e-mail já tiver conta no sistema, o aceite avisa (o convite não é gasto). Limite de 30 colaboradores + convites por conta.
- **Abas da tela:** **No time** (quem já entrou: editar acesso ou remover), **Pendentes** (convites: reenviar ou cancelar) e **Atividade** (o que cada pessoa fez).
- **Atividade da equipe (registro de ações):** o dono vê **quem fez o quê e a que horas**: ativou/pausou no Gerenciador (nível, quantidade e conta), publicou campanha (conta, **link de destino**, **criativos**, **catálogo**, objetivo),
  enviou/alterou/excluiu criativos e pastas, hooks com IA, catálogos (produtos, conjuntos, sincronizações, anúncio padrão), conexões/BCs, contas de anúncio criadas, proxies, arquivos, transferências de saldo, convites e entradas
  (o login dos colaboradores também é registrado). Filtros por **pessoa**, **tipo de ação** e **período** (24 h a 1 ano), cartões de **resumo por pessoa** (campanhas publicadas, ativações/pausas, criativos, contas) e linha do tempo
  por dia, com "Carregar mais". API (só o dono): `GET /api/team/activity?actor=&group=&range=&page=` e `GET /api/team/activity/summary?range=`.
  Como funciona: um observador central (`src/modules/activity/activity.trail.js`) olha as rotas por regras declarativas (`activity.rules.js`), então nenhum módulo precisou ser alterado; só registra **depois de sucesso (2xx)**, guarda o
  nome de quem agiu (continua aparecendo se a pessoa for removida), **nunca grava token, senha ou corpo da requisição** (só campos permitidos em `shared/activity.js`) e falha de registro nunca derruba a ação. É somente de acréscimo
  (a única remoção é a limpeza do que passa de 1 ano). Tabela `workspace_activity` (migração 25, RLS).
- **Configuração do e-mail** (segredos do servidor, nunca no navegador nem no repositório): `RESEND_API_KEY` (a chave pode ser só de
  envio), `EMAIL_FROM` (padrão `TikTok Ads Manager <convites@payfac.dev>`, o domínio precisa estar verificado no Resend) e `APP_URL`
  (endereço público, usado nos links; **nunca** deduzido do cabeçalho Host). Sem elas o convite fica indisponível e a tela avisa.
- **Para criar uma área nova:** acrescente-a em `shared/permissions.js`, proteja as rotas com `requireArea` e crie uma migração que
  amplie o CHECK das colunas `areas`. Regras em `shared/permissions.js`; espaço de trabalho em `src/middleware/workspace.js`.

## Foto de perfil (Minha conta)

Clicar na conta, no canto do menu, abre **Minha conta**: a pessoa escolhe uma foto, ajusta o recorte (arrastar, zoom, girar, teclado) e salva;
também troca o nome e remove a foto. A foto aparece no menu e para a equipe (na tela **Colaboradores** o dono vê a foto de cada um).
Colaboradores configuram a própria foto sem precisar de nenhuma área.

**Nível de gasto em anúncios (só o titular):** a janela tem as abas **Meu nível** e **Meus dados**. A barra tem **13 níveis** (US$ 0–1 mil · 1–10 mil · 10–50 mil · 50–100 mil · 100–250 mil · 250–500 mil · 500 mil–1 mi · 1–2,5 mi · 2,5–5 mi ·
5–10 mi · 10–20 mi · 20–50 mi · 50–100 mi, o último), **uma cor por nível**, quanto falta para o próximo, uma frase de incentivo, a escada completa e uma mensagem de comemoração ao subir de nível. Regras em `shared/spend-levels.js`.
O gasto é **vitalício e em dólar**: vale o **maior** entre o relatório oficial do TikTok (gasto de cada conta, conta repetida em duas BCs conta uma vez) e o livro permanente de gasto por hora (continua valendo se a BC for removida);
outras moedas só entram com a **cotação** cadastrada pelo admin (sem ela, a tela avisa). Se o TikTok estiver fora do ar, o nível sai do livro e a tela avisa. `GET /api/profile/level` devolve `{ level: null }` para colaborador
(ele nunca vê o gasto do dono).

- **O arquivo enviado nunca é guardado como veio.** O navegador recorta e reduz (JPEG 512 px); o servidor confirma pelo **conteúdo** que é JPG/PNG
  (o `Content-Type` é só dica; SVG, HTML, GIF e afins são recusados), lê as dimensões do cabeçalho (recusa imagens enormes, contra “bomba de
  descompressão”) e **recodifica no FFmpeg** (mesmo cuidado dos criativos: sem shell, formato fixo, só protocolo `file`, tempo e tamanho
  limitados) para um JPEG 256×256 **sem metadados** e sem qualquer conteúdo escondido. Limite de 1 MB no envio.
- Guardada no banco (`user_avatars`, `BYTEA` até 200 KB, só `image/jpeg`; RLS sem políticas), em tabela própria para não pesar as consultas.
- `GET /api/avatars/:userId` só entrega a foto à própria pessoa, ao dono do espaço e aos colegas de equipe (e ao admin); qualquer outro caso é 404.
  A URL leva `?v=<versão>`, então a troca aparece na hora e o navegador reaproveita o cache (`private`) enquanto a foto não muda.
- API: `POST /api/profile/avatar` (corpo binário `image/jpeg` ou `image/png`), `DELETE /api/profile/avatar`, `PATCH /api/profile` (`{ name }`; e-mail,
  função e status nunca vêm do cliente). Limite de 20 trocas por minuto por pessoa.

## Início (chat), Relatórios, Arquivos e demais telas

- **Botões** mais arredondados (14 px; os pequenos 12 px), definidos por duas variáveis de CSS (`--radius-btn`, `--radius-btn-sm`) usadas por botões, abas e controles segmentados.
- **Menu lateral por grupos:** **Início** (sem título, é a porta de entrada) → **Ads** (Gerenciador, Criativos, Catálogo) → **BC e CA** (Contas TikTok, Saldo) → **Gestão** (Colaboradores, Administração) → **KPI** (Relatórios). O título de um grupo só aparece se a pessoa vê algum item dele. **Os grupos mostram só o título: as opções aparecem logo abaixo ao passar o mouse** (ex.: passar em "Ads" mostra Gerenciador, Criativos e Catálogo),
  abrem com um pequeno atraso para não piscar ao só atravessar o menu, fecham ao tirar o mouse, e **clicar no título fixa** o painel (é o que vale no toque). Teclado: ↓ no título abre e vai às opções, ↑/↓ andam entre elas, Esc fecha. O título do grupo da tela atual fica em destaque (ponto vermelho/ciano). Clicar de novo no título já fixado fecha e **não reabre sozinho** enquanto o mouse continuar parado nele. A animação é leve: só `opacity` e `transform` (compostas pela GPU, sem recalcular layout), entra com desaceleração em ~0,2 s e sai em ~0,1 s; quem ativa "reduzir movimento" no sistema recebe o painel sem animação. O posicionamento lê o layout uma vez e escreve uma vez (2 layouts por abertura em vez de 2,7, medidos). Só um grupo fica aberto por vez; o painel é `position: fixed`
  (não empurra o menu nem é cortado pela rolagem). Com o menu recolhido (só ícones) o painel abre **ao lado**; no celular o menu horizontal continua mostrando as opções direto. A busca do menu mostra as opções que combinam em lista, sem painel (`public/js/views/nav-groups.js`).
- **Assistente do Início (chat):** não há um modelo de linguagem por trás; ele reconhece os assuntos abaixo (pelas 4 sugestões ou por palavras-chave na pergunta digitada, em `shared/chat-topics.js`) e responde de verdade:
  **Resumo do desempenho** e **Onde estou gastando** consultam as contas (últimos 7 dias, com variação sobre o período anterior, por moeda, nunca somando moedas diferentes, e observações automáticas; exigem a área Relatórios);
  **Ideias de criativo** (5 ganchos com roteiro e como transformá-los em anúncio aqui) e **Nova campanha** (tutorial detalhado: antes de começar, as 5 etapas do assistente, o que fazer depois de publicar) são tutoriais; também há **catálogo** e **conectar a Business Center**.
  Sem contas conectadas, ele ensina a conectar. O que não reconhece recebe uma resposta honesta com os assuntos disponíveis e botões para cada um. As respostas são blocos (`public/js/views/chat/`) desenhados sem HTML; o texto digitado nunca é interpretado.

- **Início** é um chat no estilo ChatGPT (por enquanto só o design: sugestões clicáveis, campo que cresce, "Enter envia", botão de avião de papel, respostas de exemplo; sem logo).
  O chat ocupa a altura da tela: a conversa rola dentro da própria área e o campo de mensagem fica fixo embaixo, sem cobrir nada. A
  conversa fica só na memória do navegador (nada vai ao servidor) e é descartada se outra pessoa entrar. O texto entra sempre como texto.
- **Relatórios** (área "Relatórios" dos colaboradores) tem três abas: Visão geral, **Por hora** e Por conta. **Visão geral**: 7 indicadores (gasto, impressões, cliques, CTR, CPC, conversões e
  custo por conversão) com variação contra o período anterior e mini gráfico; gráfico de linha com **curva suave** (spline cúbica monótona, SVG puro, sem
  biblioteca, com dica ao passar o mouse e navegação por setas); "O que chama atenção" (observações automáticas); ranking por conta com busca e ordenação.
  Filtros: período (7/14/30 dias), conta, moeda (valores de moedas diferentes nunca se somam) e comparar. API: `GET /api/tiktok/overview?days=&advertiserId=&compare=1`
  (série diária contínua por moeda, `previous`, `accounts`, `accountOptions`). **Por conta**: desempenho e campanhas de uma conta (o antigo "TikTok Ads"; `/tiktok` redireciona).
- **Por hora** (`/reports/hourly`): gasto (e cliques, impressões e conversões) de **cada hora**, em gráfico de linha suave, com período (24 h, 48 h, 7 dias),
  conta, moeda e métrica. O TikTok **fornece** esse dado (`/report/integrated/get/` com a dimensão `stat_time_hour`, no máximo 1 dia por consulta e com algum
  atraso). O sistema o **coleta a cada 30 minutos** (`hourly.service.js`, ligado em `server.js`) e guarda em `tiktok_hourly_spend` (migração v12): uma linha por conta
  e hora em **UTC** (a hora do TikTok vem no fuso da conta e é convertida; o navegador mostra no horário de quem olha); a hora em andamento é regravada a cada
  coleta (upsert), contas novas recebem uma carga inicial de 3 dias, logo depois da meia-noite o dia anterior é reconferido, e o histórico é mantido por 90 dias.
  A série só começa na primeira hora COM coleta (nada de zeros falsos). Falha de uma conta não derruba as outras, token revogado marca a conexão com erro, e
  as chamadas saem pela proxy do dono. Valores de moedas diferentes nunca se somam; conta repetida em conexão própria e compartilhada conta uma vez só.
  API: `GET /api/tiktok/hourly?hours=24|48|168&advertiserId=` e `POST /api/tiktok/hourly/refresh` ("Atualizar agora": só as conexões do usuário, 3 por 5 minutos).
  **Atenção na hospedagem:** a coleta roda DENTRO do servidor; num plano que "dorme" por inatividade (Render gratuito) ela só acontece enquanto o serviço estiver
  acordado. O plano `starter` do `render.yaml` fica sempre ligado; o gratuito não serve para isso. Pendente de conferência com um token real: o formato exato da resposta por hora.
- **Hook com IA** (botão na biblioteca de Criativos; área "Criativos"): gera com a **Kling** um começo de **2 a 3 segundos**, fora do padrão, para prender a
  **Roda no servidor, não no navegador:** gerar (Kling) e juntar ao vídeo (FFmpeg) continuam mesmo que a pessoa feche o pop-up, o site ou o navegador. O botão "Hook com IA" mostra uma **bolinha piscando** enquanto houver algo gerando ou sendo juntado (ela volta sozinha ao reabrir o site e some ao terminar, com um aviso e a biblioteca atualizada). Se o **servidor reiniciar** no meio da junção (ex.: uma atualização), o pedido fica guardado no banco (`apply_creative_id`, `apply_name`, `apply_with_video`) e a junção é **retomada** sozinha ao subir (até 2 retomadas; vídeo apagado nesse meio tempo ou pedido sem dados falha com mensagem clara, nunca guarda só o hook por engano).
  atenção (9 estilos "quebra-padrão" + ideia extra opcional; não precisa falar do produto), mostra a prévia e, com a sua escolha, **junta o hook ao início de um vídeo
  da biblioteca** (FFmpeg, no tamanho do vídeo, com áudio mudo no trecho do hook) ou guarda só o hook. O vídeo original **nunca é alterado**: o resultado é um criativo
  NOVO marcado como **"Gerado por IA"** (selo na biblioteca e aviso para ativar a divulgação de conteúdo de IA do TikTok ao publicar). A Kling gera no mínimo 3 s
  (`kling-3.0`, vertical 9:16, 720p, sem áudio, sem marca d'água); o servidor corta para 2, 2,5 ou 3 s. Fluxo: pedido (1 a 3 opções) → fila → gerando → ajustando → pronto,
  tudo em segundo plano e guardado no banco (`creative_hooks`, migração v13; sobrevive a reinício). A barra de andamento é uma estimativa (a Kling não informa %).
  Segurança e custo: a chave fica só no servidor (`KLING_API_KEY`, nunca no navegador, nos logs ou no repositório); erros da Kling viram mensagens próprias; o download do vídeo
  pronto só aceita https em domínios da lista (`KLING_DOWNLOAD_HOSTS`), nunca IP/localhost/redirecionamento, com limite de tamanho; limites por usuário (`KLING_DAILY_LIMIT`,
  padrão 20 a cada 24 h), no sistema (`KLING_GLOBAL_DAILY_LIMIT`, 100), 6 pedidos ativos por usuário e `KLING_CONCURRENCY` tarefas simultâneas (3). Prompts em `hook-prompts.js`
  (sempre com "sem texto, marcas, pessoas reais, violência ou nudez"). API: `GET/POST /api/hooks`, `GET /api/hooks/:id/file`, `POST /api/hooks/:id/apply`, `DELETE /api/hooks/:id`.
  **Atenção:** a API da Kling cobra por um pacote de créditos próprio; sem saldo ela responde "Account balance not enough" (a tela mostra só "Avise o administrador do sistema.", sem detalhes da conta). Se o sistema avisar
  que um endereço de vídeo foi recusado, acrescente o domínio em `KLING_DOWNLOAD_HOSTS`.
- **Criativos como gerenciador de arquivos:** barra lateral de pastas ("Todos os arquivos", "Sem pasta" e uma por oferta, com contagem), caminho no topo ("Criativos › Oferta X"), cartões de pasta na visão "Todos os arquivos" (com
  quantidade e tamanho), **grade ou lista** (a lista tem colunas Nome, Pasta, Tipo, Tamanho e Enviado em, e os títulos ordenam) e **ordenação** por data, nome, tamanho ou tipo (a escolha fica salva neste navegador). Seleção como no Explorador/Finder:
  clique seleciona, **⌘/Ctrl+clique** soma, **Shift+clique** marca o intervalo, duplo clique abre a pré-visualização, **botão direito** abre o menu (Ver, Renomear, Mover, Excluir), e atalhos **Ctrl/⌘+A**, **Esc**, **Delete** (pergunta antes), **Enter** e **F2**.
  **Arrastar para enviar:** solte vídeos e imagens em QUALQUER lugar da página para enviar; com uma pasta aberta eles entram nela, e soltar em cima de uma pasta (na barra lateral ou no cartão dela) envia direto para ela. Uma faixa mostra o destino
  ("Solte para enviar para a pasta “Oferta X”") e a pasta sob o ponteiro fica destacada. A pasta de destino é fixada **na hora de soltar** (trocar de pasta com arquivos na fila não muda para onde vão). Soltar uma **pasta do computador** cria uma pasta de mesmo nome
  na biblioteca (ou usa a que já existe, sem diferenciar maiúsculas) e envia os arquivos dela (um nível só: subpastas e arquivos ocultos como `.DS_Store` são ignorados, com aviso; até 200 arquivos por pasta). Se o servidor pedir para esperar ("muitos envios seguidos"),
  o arquivo volta para a fila e tenta de novo sozinho (até 3 vezes). Arrastar cartões da lista até uma pasta continua movendo (a seleção inteira vai junto). API nova: `GET /api/creatives?sort=date|name|size|kind&dir=asc|desc` (valores fora da lista = 400; só texto fixo
  entra no SQL), `POST /api/creatives/delete` (`{ ids }`, até 100, cada um com as regras do excluir normal: um criativo usado em rascunho de campanha fica e vem em `failed` com o motivo) e `sizeBytes` em cada pasta de `GET /api/creatives/folders`.
- **Pastas de criativos** (biblioteca de Criativos): uma pasta por oferta (um nível), com contagem, "Sem pasta" e "Todos". Criar, renomear (nome único por usuário, sem
  diferenciar maiúsculas; até 100 pastas) e apagar (**apagar a pasta não apaga criativos**: voltam para "Sem pasta"). Enviar com uma pasta aberta já coloca o arquivo nela;
  mover um criativo (ícone da pasta no cartão), vários de uma vez (caixas de seleção → "Mover para pasta…", com opção de criar a pasta na hora) ou **arrastando** o cartão
  até o nome da pasta. O seletor de criativos da campanha tem filtro por pasta, e o vídeo "hook + vídeo" fica na mesma pasta do original. API: `GET/POST /api/creatives/folders`,
  `PATCH/DELETE /api/creatives/folders/:id`, `POST /api/creatives/move` (`{ ids, folderId|null }`, tudo ou nada), `PATCH /api/creatives/:id` (`{ name?, folderId? }`),
  `GET /api/creatives?folderId=ID|none` e `POST /api/creatives?folderId=ID`. Tabela `creative_folders` + `creatives.folder_id` (migração v14). Nomes entram sempre como texto.
- **Conferência com a documentação oficial:** o portal de documentação do TikTok publica o conteúdo em `GET https://business-api.tiktok.com/gateway/api/doc/client/node/get/v2/?doc_id=ID`
  (ou `content_slug=...&version=1.3`). Conferidos: `/bc/advertiser/create/`, `/bc/get/`, `/bc/balance/get/`, `/advertiser/balance/get/`, `/report/integrated/get/` (hora: 1 dia por consulta; dia: até 30),
  `/pixel/list/` (**page_size 1 a 20**), `/bc/asset/get/` (1 a 50), `/campaign/get/` (até 1000), `/advertiser/info/` (campo de e-mail é `email`) e os apêndices de fuso, país e ramo.
- **Saldo** (menu "Saldo", área "Contas TikTok"): duas subabas SEPARADAS e em **lista compacta**, **Business Centers** (`/balance`) e **Contas de anúncio** (`/balance/accounts`). Cada linha segue o formato
  **nome · ID · saldo · total gasto · botão "Depósitos"**; a aba das BCs só mostra BCs (nada de contas) e a das contas só mostra contas (nada de BC), porque uma BC sem saldo pode ter contas com saldo e o contrário. O nome da BC vem do TikTok
  (`/bc/get/`, em cache por 1 h). O ID copia com um clique. O saldo mostra a situação pela cor (verde = com saldo, vermelho = sem saldo, "—" com o motivo = sem informação) e, ao passar o mouse, **todos** os valores que o TikTok devolveu
  (saldo total, dinheiro, bônus, bloqueado, impostos, orçamento…). Os títulos Nome, Saldo e Total gasto ordenam; filtros por situação (com a quantidade), busca por nome ou ID, e dois totais por moeda (**Saldo total** e **Gasto total**; moedas diferentes nunca se somam).
  - **Total gasto** = gasto vitalício (desde sempre): o servidor pede ao TikTok o relatório oficial `/report/integrated/get/` (`report_type` BASIC, `data_level` AUCTION_ADVERTISER, `query_lifetime`, `advertiser_ids` de até 5 contas por chamada, sempre dentro de UMA conexão: exigência do TikTok),
    na moeda de cada conta. A BC soma o gasto das contas dela. Carrega em segundo plano (a lista aparece primeiro, com "···" no lugar), fica em cache por 10 min (`?refresh=1` refaz, com limite próprio) e, se uma conta for recusada, só ela mostra "—" e a BC mostra o valor parcial com "*". API: `GET /api/tiktok/balance/spend`.
  - **Histórico de depósitos** (botão em cada linha): janela com **só depósitos** (`ADD_BALANCE` e `INCREASE_BALANCE`) ou **todas as movimentações**, nos últimos 90 dias, 6 meses ou 12 meses (máximo do TikTok: 365 dias), 20 por página com "Carregar mais"; entradas em verde (+) e saídas em vermelho (−), com o tipo em português e a fatura quando houver.
    Fonte oficial: `/bc/account/transaction/get/` (`transaction_level` BC ou ADVERTISER com `account_ids`). Só quem tem função financeira (Finance Manager/Analyst) na BC vê; sem ela a janela explica o motivo. API: `GET /api/tiktok/balance/history?kind=bc|account&connectionId=&bcId=|advertiserId=&range=&filter=&page=`
    (a BC de uma conta é descoberta no servidor e NUNCA vem do cliente; conexão, BC e conta são conferidas contra o que a pessoa tem; só as conexões do próprio dono; 40 consultas por minuto; em cache por 30 s). Regras em `shared/balance-history.js` e `shared/balance-list.js`.
  Código da tela em `public/js/views/balance/` (`screen.js`, `list.js`, `history-dialog.js`). Dados da API real: `GET /bc/balance/get/` e `GET /advertiser/balance/get/` (documentação oficial v1.3,
  conferida; só devolve contas em que a BC é administradora e só usuários com função financeira veem o saldo). **Como o saldo é calculado (regras da documentação):**
  - **"Saldo disponível" é `valid_account_balance`** (o que dá para gastar). `account_balance` é o TOTAL (= disponível + bloqueado + impostos): conta com dinheiro só bloqueado aparece **sem saldo**.
  - **Os valores da CONTA vêm de `balance_info`**; os mesmos campos no topo da resposta, com *Payment Portfolio* ativo, são os do **portfólio** (compartilhado), não os da conta.
  - **Portfólio compartilhado (`SHARED`):** o dinheiro é do portfólio e usado por todas as contas ligadas a ele; o disponível mostrado é o do portfólio e **entra UMA vez na soma** (antes cada conta somava o mesmo valor).
  - **BC em alocação automática** (`budget_mode` mensal/diário/único): a conta gasta do saldo da BC dentro do orçamento; o disponível é o `budget_remaining` (pedido em `fields`) limitado pelo saldo da BC, e **não entra na soma** (já está no saldo da BC).
  - Se o TikTok recusar o parâmetro `fields`, a consulta é repetida sem ele. Campos desconhecidos continuam aparecendo (nome humanizado). Regras em `shared/balance-fields.js` e `src/modules/tiktok/balance.service.js`.

  **Transferir saldo (BC ↔ conta de anúncio):** botão **Transferir** em cada conta da aba "Contas de anúncio", pela rota oficial `POST /bc/transfer/` (`transfer_level: ADVERTISER`, só em espécie):
  **adicionar** = da BC para a conta (`RECHARGE`); **retirar** = da conta de volta para a BC (`REFUND`). Isto só move dinheiro que JÁ está no TikTok: **colocar dinheiro novo na BC (cartão, PIX,
  boleto) continua sendo no portal do TikTok** (a API não faz isso). O TikTok só deixa quem tem a função **Finance Manager** na BC concluir. Como é dinheiro de verdade, há várias travas:
  - **só o DONO** das conexões move dinheiro (colaborador vê o saldo, o botão some e a API devolve 403) e **toda transferência pede a senha** (5 senhas erradas = bloqueio de 15 minutos);
  - duas etapas na tela (preencher → **revisar** com a frase "US$ X da BC … para a conta …" e o saldo de cada lado depois) e **o servidor reconfere tudo** com o saldo ATUAL antes de chamar o TikTok
    (valor até 2 casas, nunca arredondado; teto de 100.000 por vez e 20 por hora; dentro do saldo da BC ou do valor transferível da conta; mesma moeda);
  - **não aparece** para contas de portfólio compartilhado (o dinheiro é do portfólio) nem para contas que gastam do saldo da BC por orçamento (não há saldo próprio), com o motivo nos detalhes;
  - **nunca duas vezes:** cada pedido tem um identificador de operação e vira um registro `balance_transfers` ANTES de falar com o TikTok (chave única por pessoa e operação); clique repetido, reenvio ou
    duas ao mesmo tempo na mesma conta não movem o dinheiro de novo, e a chamada ao TikTok nunca é repetida sozinha;
  - **histórico** (tabela `balance_transfers`, só da pessoa, nunca apagado junto com a conexão): `success`, `failed` (o TikTok recusou, nada se moveu) ou `unknown` (o TikTok não respondeu: o dinheiro PODE ter
    se movido, então a tela manda conferir o saldo e não tenta de novo). Nem senha nem token são gravados. API: `POST /api/tiktok/balance/transfer`, `GET /api/tiktok/balance/transfers`. Regras em `shared/balance-transfer.js`.

  Só as conexões do PRÓPRIO usuário (nada compartilhado), cache de 60 s que muda sozinho ao conectar/remover/sincronizar, "Atualizar agora" com limite (6 por 5 minutos) e consulta de poucas BCs ao
  mesmo tempo; falha em uma BC (ex.: sem permissão financeira) aparece naquela BC e não derruba as outras. API: `GET /api/tiktok/balance[?refresh=1]`. **Pendente de conferência com um
  token real:** como o SEU TikTok devolve `balance_info`/portfólio/orçamento (os testes usam um TikTok simulado seguindo a documentação) e se o token da conexão tem permissão financeira na BC.
- **Arquivos** (aba de Contas TikTok): anexos para a equipe (ex.: arquivos de logins). Gravados **criptografados** (AES-256-GCM, dono autenticado; desligado sem
  `TOKEN_ENCRYPTION_KEY`), só txt/csv/log/md/pdf/png/jpg/docx/xlsx **conferidos pelo conteúdo**, sempre entregues como **download** (`octet-stream`, `attachment`,
  `nosniff`, sem cache). Limites: 5 MB por arquivo, 50 arquivos e 100 MB por conta. Para senhas, um gerenciador de senhas é mais seguro.
- **Moeda das contas**: selo por conta (BRL neutro, outras em amarelo), "Moedas das contas" no cartão da conexão, filtro por moeda, e o campo de valor do
  assistente mostra a moeda ("BRL / USD") com o aviso de que o valor **não é convertido**.
- **Pixels existentes**: no passo "Conversão" (e nos ajustes por conta) o assistente lista os pixels da conta (`GET /api/tiktok/advertisers/:id/pixels`, cache de
  60 s, `?fresh=1` no botão Atualizar) e ainda permite digitar o ID.
- **Passo "Público" compacto**: botões (poucas opções) e lista suspensa com busca e chips (muitas), com respeito ao máximo de itens.

## Biblioteca de criativos

- **Criativos** (menu lateral): cada usuário guarda os próprios arquivos (JPG/PNG até 10 MB, MP4/MOV até 200 MB, cota de 2 GB por padrão,
  configuráveis por `CREATIVES_*`) e, no assistente de campanha, **seleciona** do que já está armazenado. Também é possível registrar um
  criativo que já está na conta do TikTok (por ID).
- Envio com barra de progresso, miniaturas, pré-visualização, busca, filtros (imagens/vídeos), renomear e excluir. Arquivo repetido não duplica.
- **Pastas e subpastas:** os criativos se organizam em pastas por oferta e **cada pasta pode ter subpastas, até 5 níveis** (no máximo 100 pastas por usuário, todas contadas).
  O nome é único só entre pastas **irmãs** (sem diferenciar maiúsculas); em lugares diferentes pode repetir. Na tela: a barra lateral mostra as pastas de nível mais alto e,
  sob a pasta aberta, o caminho até ela e as subpastas dela (com recuo); o **caminho** (“Criativos › Oferta A › Verão”) tem atalhos para cada nível; dentro de uma pasta há os
  cartões das **subpastas** e o botão “Nova subpasta” (também no menu de contexto); a etiqueta de um arquivo em “Todos os arquivos” mostra o caminho inteiro. A contagem de uma
  pasta soma as subpastas; a lista de arquivos de uma pasta mostra só os arquivos **diretos** dela. **Apagar** uma pasta apaga também as subpastas, mas **nunca os criativos**:
  todos voltam para “Sem pasta” (a confirmação diz quantas subpastas e quantos criativos). API: `POST /api/creatives/folders` com `{ name, parentId? }` (409 `folder_too_deep` no 6º nível,
  404 se o pai não é seu, 409 `folder_exists` entre irmãs); `GET /api/creatives/folders` devolve `parentId` e a contagem direta de cada pasta; `DELETE` devolve `{ moved, subfolders }`.
  Migração 28: `creative_folders.parent_id` (`ON DELETE CASCADE`) e índice único por (usuário, pai, nome sem maiúsculas). **Ainda não há** mover uma pasta para dentro de outra
  (o pai é definido ao criar) nem enviar uma pasta do computador com subpastas (as subpastas soltas são ignoradas com aviso; arraste cada uma). Regras da árvore em `shared/creative-folders.js`.
- Ao publicar, o sistema envia a versão limpa dos arquivos escolhidos para a conta de anúncio no TikTok e usa os IDs devolvidos.
- **Criativos blindados:** a cada publicação, em **cada conta de anúncio e em cada campanha**, vídeos e imagens passam por uma limpeza e o
  que vai ao TikTok é uma versão **nova e única** (o arquivo da biblioteca nunca é alterado). A limpeza (`src/modules/creatives/creative-cleaner.js`,
  FFmpeg) descarta metadados e o hash original, refaz a mídia por completo (vídeo decodificado e recodificado quadro a quadro em
  H.264/AAC; imagem recodificada) e altera os 4 cantos com cores muito próximas (variação de 3 a 7 níveis em 255): nos **primeiros e nos
  últimos 0,1 s** do vídeo, e na imagem inteira. O sorteio é novo a cada execução, então a mesma campanha em 3 contas envia 3 versões
  diferentes. O hash da versão enviada fica em `campaign_creative_assets` (auditoria); uma nova tentativa da mesma campanha na mesma
  conta reaproveita o envio. Se a limpeza falhar (arquivo corrompido ou sem FFmpeg), a publicação é recusada: o original nunca é enviado.
  O FFmpeg roda sem shell, com formato de entrada fixo, só protocolo `file`, tempo e tamanho máximos e no máximo
  `CREATIVES_CLEAN_CONCURRENCY` processos por vez. Vídeos grandes pedem CPU/memória: em planos pequenos a publicação de cada conta pode demorar.
  Criativos que já existiam no TikTok (referência por ID) não têm arquivo e, por isso, não passam pela limpeza.
- Segurança: o tipo é conferido pelo **conteúdo** do arquivo (não pela extensão), o envio é em fluxo com limite de tamanho, os arquivos
  recebem nome aleatório fora da pasta pública e só o dono os acessa (de outro usuário responde 404); são servidos com `nosniff` e CSP restrita.
- Os arquivos ficam em disco no servidor (`CREATIVES_DIR`, padrão `data/creatives`): inclua essa pasta no backup. O armazenamento está
  atrás de uma interface (`src/modules/creatives/creative-storage.js`) para trocar por S3/Supabase Storage no futuro.

## Gerenciador de anúncios

O Gerenciador tem **três abas, uma por nível da hierarquia do TikTok: Campanhas → Grupos de anúncios → Anúncios**, cada uma com os dados do próprio nível (a aba mostra a contagem
depois de carregar). **Clicar no nome de uma campanha abre os grupos dela; clicar num grupo abre os anúncios dele** (um aviso mostra o filtro, com o botão “Ver todos”). Cada aba tem
as colunas que fazem sentido: **campanha** = objetivo e orçamento; **grupo** = meta de otimização, orçamento e campanha; **anúncio** = campanha e grupo. Status, ativar/pausar (interruptor
e em massa), período, filtros, colunas e visualizações salvas valem para os três níveis. Pausar uma campanha muda o status do que está dentro dela: as outras abas buscam de novo.
Cada nível é uma consulta própria, guardada enquanto a pessoa troca de aba no mesmo período (a troca de aba é instantânea depois da primeira vez).

**Barra de ferramentas enxuta:** à vista ficam só **busca, período, Filtros, Visualização, Colunas e Atualizar**. Conta, situação e “só com gasto” ficam dentro de **Filtros** (o botão mostra
quantos estão ligados e cada um vira um **chip** removível); a **visualização** em uso é um menu único (escolher, salvar alterações, salvar como nova, abrir sempre com esta, excluir).
Os painéis (`popover.js`) fecham ao clicar fora e com Esc, e cabem na largura do celular.

- **Contrato oficial por nível (conferido na documentação):** `GET /campaign/get/`, `GET /adgroup/get/` e `GET /ad/get/` (campos em `fields`, `filtering.primary_status = STATUS_NOT_DELETE`,
  `page_size` até 1000); desempenho em `GET /report/integrated/get/` com `data_level` **`AUCTION_CAMPAIGN` / `AUCTION_ADGROUP` / `AUCTION_AD`** e **uma** dimensão de ID (`campaign_id`, `adgroup_id`
  ou `ad_id`; o TikTok não aceita duas); ativar/pausar em `POST /campaign/status/update/` (`campaign_ids`), `/adgroup/status/update/` (`adgroup_ids`) e `/ad/status/update/` (`ad_ids`), de 1 a 20
  por chamada. **Só `ENABLE`/`DISABLE`: o sistema nunca envia `DELETE`.** Campanhas/grupos/anúncios excluídos não são listados (padrão do TikTok).
- **Status em português** (`shared/ad-status.js`): tabelas de campanha (`CAMPAIGN_STATUS_*`), grupo (`ADGROUP_STATUS_*`) e anúncio (`AD_STATUS_*`), mais os estados da conta que o TikTok repete em
  qualquer nível (ex.: `ADVERTISER_ACCOUNT_PUNISH` → “Conta penalizada pelo TikTok”). Valor desconhecido aparece “humanizado”.
- API: `GET /api/tiktok/manager/{campaigns|adgroups|ads}?preset=&from=&to=&refresh=1` (a lista vem em `campaigns`, `adgroups` ou `ads`) e `POST /api/tiktok/manager/{campaigns|adgroups|ads}/status`
  (`campaignIds` | `adgroupIds` | `adIds` + `status`). Níveis e rótulos em `shared/manager-levels.js`.

**Gerenciador** (menu lateral; exige a área “Campanhas” ou “Relatórios”) mostra, em uma única tabela por aba, **os itens de todas as contas** das Business Centers ativas
da pessoa, carregados de uma vez (contas consultadas 6 por vez, com cache de 60 s; “Atualizar” ignora o cache). Colunas padrão: **anúncio** (com ID e campanha), **status**,
**ativo** (interruptor), **publicado em**, **resultado**, **valor gasto**, **CPC (link)**, **cliques (link)** e **CTR**; opcionais: conta, campanha, grupo, impressões,
custo por resultado, conversões, custo por conversão e editado em. Rodapé com **total por moeda** (moedas diferentes nunca são somadas).

- **Período:** o padrão é **Hoje**; também Ontem, Últimos 7/14/30 dias, Este mês, Mês passado e Personalizado (até 90 dias). **Cada conta usa o próprio fuso** para saber o que é
  “hoje” (o relatório do TikTok trabalha no fuso da conta). Conta com erro aparece num aviso e as demais seguem normalmente.
- **Filtros** (instantâneos, no navegador): conta, situação (ativos, pausados, em veiculação, com problema), só com gasto, e busca por nome, ID, campanha, grupo ou conta.
- **Colunas:** arraste o título para mudar a ordem ou use a janela **Colunas** (marcar/desmarcar, setas ↑↓, restaurar padrão). “Anúncio” é sempre visível.
- **Visualizações salvas (por pessoa, até 20):** guardam colunas, ordem, ordenação, filtros e período (não a busca nem datas personalizadas). Dá para salvar, atualizar, salvar como nova,
  excluir e marcar **uma** como padrão (abre sozinha). Tabela `manager_views` (RLS, sem acesso direto pela API do banco; nome único sem diferenciar maiúsculas).
- **Ativar/pausar:** interruptor por anúncio e ação em massa (seleção + “Ativar”/“Pausar” com confirmação), em lotes de 20 por conta; o interruptor responde na hora e volta se o TikTok recusar.
  Exige a área “Campanhas”. **Nunca exclui** anúncios (o sistema só envia `ENABLE`/`DISABLE`); anúncio encerrado (`FROZEN`) não pode ser ativado.
- **Contrato oficial do TikTok (conferido na documentação):** lista em `GET /ad/get/` (campos pedidos em `fields`, `filtering.primary_status = STATUS_NOT_DELETE`, `page_size` até 1000,
  `secondary_status` traduzido em `shared/ad-status.js`); desempenho em `GET /report/integrated/get/` (`report_type BASIC`, `data_level AUCTION_AD`, `dimensions ["ad_id"]`, métricas
  `spend, impressions, clicks, ctr, cpc, result, cost_per_result, conversion, cost_per_conversion`; “clicks” e “cpc” são os de **destino**, isto é, cliques no link); mudança de status em
  `POST /ad/status/update/` (1 a 20 anúncios por chamada). Se o TikTok recusar a métrica `result`, repete sem ela e a coluna Resultado mostra “—”.
- **Pendente de conferência com o TikTok real:** as respostas de `/ad/get/` e do relatório por anúncio com um token de verdade (os testes usam um TikTok simulado e o teste de contrato
  `npm run test:live` confirma que os endpoints existem). API: `GET /api/tiktok/manager/ads?preset=&from=&to=&refresh=1`, `POST /api/tiktok/manager/ads/status`,
  `GET/POST/PATCH/DELETE /api/tiktok/manager/views`. Regras de colunas/períodos em `shared/manager-columns.js` (servidor e tela usam a mesma fonte).

## Catálogo de produtos (Catalog API do TikTok)

**Catálogo** (menu lateral, grupo **Ads**; exige a área “Campanhas”) mostra os catálogos de **todas** as Business Centers da pessoa e é o passo que faltava para campanhas de
**Vendas de produtos** (um catálogo com produtos aprovados é obrigatório). Tudo segue a documentação oficial v1.3 (conferida na API pública de documentação):

- **Detalhe em sub-abas** (`public/js/views/catalog/`): **Produtos · Adicionar produtos · Sincronização · Conjuntos · Campanha**, cada uma começando por uma frase que explica para que serve, com um resumo de produtos aprovados/em análise/reprovados no topo.
  O botão **Salvar anúncio padrão** fica no rodapé do cartão (não flutua). Todas as telas de carregamento usam o indicador no estilo TikTok (bolinha ciano e vermelha indo de um lado a outro; só `transform` anima e respeita "reduzir movimento"): `loader()`/`spinner()` em `public/js/ui.js`.
- **Listar** (`GET /catalog/get/`, paginado): nome, ID, BC, país/moeda e se o catálogo já serve para anúncios (`ad_creation_eligible`). Falha em uma BC (ex.: o acesso não inclui “Catálogo”) aparece
  naquela BC e as outras seguem. O cache de 60 s inclui as conexões, então conectar uma BC mostra os catálogos na hora.
- **Filtros** na lista: **Business Center** (UMA opção por BC, com o nome e a quantidade de catálogos; várias conexões da mesma BC não repetem a opção), **situação** (prontos para anúncios / sem produtos disponíveis), **país e moeda** e busca por nome, ID ou
  nome da BC (ignora acento e maiúsculas). Os filtros se combinam, "Limpar filtros" aparece quando algum está ativo e a contagem mostra "3 de 16 catálogos". Regras puras em `shared/catalog-filters.js` (testadas).
- **Ocultar catálogos da lista** (só visual, por pessoa): "Ocultar" em cada linha ou em vários de uma vez (caixas de seleção → "Ocultar N"; o cabeçalho seleciona todos). Pede confirmação e explica que **nada muda no TikTok** nem para as outras pessoas.
  Os ocultos saem da lista e do seletor de catálogo ao criar campanha; **"Mostrar ocultos (N)"** traz de volta (com a marca "Oculto" e o botão "Mostrar"). Fica salvo no servidor (tabela `catalog_hidden`, migração v24: por pessoa, não por espaço de trabalho, então um
  colaborador não esconde catálogos do dono; até 1.000 por pessoa; só vale para BCs que a pessoa enxerga). API: `PUT /api/tiktok/catalogs/hidden` (`{ items: [{ bcId, catalogId }], hidden: true|false }`, até 100 por pedido); `GET /api/tiktok/catalogs` passa a trazer `hidden` em cada catálogo e `hiddenCount`.
- **Criar** (`POST /catalog/create/`), pop-up em 3 etapas (Catálogo → País e moeda → Revisar e criar): `bc_id`, `name` (até 128), `catalog_type` ECOM e `catalog_conf` (`region_code` + `currency`).
  Os países vêm de `/catalog/available_country/get/` e as moedas de cada país de `/catalog/location_currency/get/`; o servidor confere os dois **antes** de criar. País e moeda **não podem ser alterados
  depois** (regra do TikTok), por isso a revisão avisa e pede confirmação. Só o dono da conexão (ou admin) cria; BC compartilhada é somente leitura.
  Só o tipo **E-commerce** é criado por aqui (hotel, voo, automóvel etc. usam outros esquemas e não servem a Vendas de produtos; multi-país e “entretenimento/minissérie” dependem de allowlist do TikTok).
- **Produtos** (`POST /catalog/product/upload/`, até 5.000 por chamada; a tela envia em lotes de até 500 produtos e ~1,5 MB): formulário ou **importação de CSV** (aceita as colunas do modelo para baixar, do Google
  Merchant e do Meta: `id`, `title`, `availability` “in stock”, `price` “79,90”…). Campos obrigatórios da API: `sku_id` (100, sem emoji), `title` (500), `description` (10.000), `availability`, `brand` (150),
  `image_url`, `product_detail.condition`, `price_info.price` e `landing_page.landing_page_url`. Valida no navegador e **de novo no servidor** com as mesmas regras (`shared/catalog.js`); um produto inválido
  recusa o lote inteiro. O envio é incremental (mesmo SKU atualiza) e o TikTok processa em segundo plano: a tela acompanha `/catalog/product/log/` e mostra novos, atualizados e erros (campo, problema, sugestão, SKUs).
  Imagens: JPG/PNG de pelo menos 500 × 500 px e públicas (senão o produto é reprovado).
- **Produtos do catálogo** (`GET /catalog/product/get/`, `/catalog/overview/`): aprovação (aprovado/reprovado/em análise), estoque e se o produto **pode ser usado em anúncios** (aprovado + ativo + em estoque, sob encomenda ou pré-venda).
- **Sincronização automática** (`/catalog/feed/create|get|switch|delete|log/`): em vez de enviar produtos na mão, aponte a URL do **feed** da loja (CSV, TSV ou XML Google Merchant/RSS/ATOM, até 8 GB; http, https, ftp ou sftp; login opcional) e o **próprio TikTok** busca o feed de hora em hora, por dia ou por mês, atualizando preço e
  disponibilidade (`INCREMENTAL` mantém quem sair do feed; `OVERWRITE` espelha o feed e remove o que não está nele, com confirmação). A aba lista as sincronizações (agenda, situação, próxima execução, produtos), liga/desliga, exclui e mostra o histórico das últimas 10 execuções. Validação com os limites oficiais
  (horas 1–23, dias 1–30, meses 1–12, dia do mês 1–28, fuso da tabela oficial) e **segurança**: a URL precisa ser pública (recusa localhost, redes privadas e link-local), sem usuário/senha embutidos; o **login do feed vai direto ao TikTok e nunca é guardado, devolvido ou registrado em log**, e credenciais embutidas na URL de um feed criado fora daqui são removidas antes de aparecer na tela.
- **Quantidade em estoque:** o TikTok **não guarda número de estoque**, só a disponibilidade (`IN_STOCK`, `OUT_OF_STOCK`…). No formulário e no CSV (colunas `quantity`, `qty`, `estoque`…) a quantidade é convertida (maior que 0 = em estoque; 0 = sem estoque; a disponibilidade escolhida tem prioridade) e **não é enviada**. O vídeo do produto é o campo opcional `video_url`; o anúncio "Vídeo do catálogo" também gera o vídeo a partir das imagens, títulos e preços do catálogo.
- **Gerar produtos em lote (aba "Adicionar produtos"):** preencha UMA vez nome base, link de destino, imagem, preço (na moeda do catálogo), marca, descrição e a quantidade (1 a 5.000) e um clique cria e envia todos. Cada produto ganha SKU próprio (`NOME-sufixo-número`, o sufixo aleatório impede que uma segunda geração sobrescreva a primeira) e título numerado ("AD-EX-01 · 1"). "Numerar a partir de" continua a contagem em gerações seguintes. Regras em `shared/catalog-bulk.js` (as mesmas do envio manual; o servidor valida cada produto de novo) e tela em `public/js/views/catalog/bulk-generator.js`. O TikTok exige imagem (JPG/PNG ≥ 500 × 500 px, aberta sem login), por isso o campo é obrigatório.
- **Anúncio padrão do catálogo (aba "Campanha"):** monte UMA vez o que a campanha de catálogo precisa — **criativos da biblioteca** (vídeo e capa), quais produtos mostrar (todos, um conjunto ou até 20 SKUs), texto, botão, URL de destino (+ UTM), identidade, meta/pixel/orçamento e público básico — e a campanha já **sai preenchida e completa** (só falta escolher as contas de anúncio). Um painel mostra **quanto falta** por grupo e fica "Pronto" quando a campanha sai completa. Usa os MESMOS campos, listas e validações do assistente (`shared/campaign-spec.js`; regras em `shared/catalog-defaults.js`).
  Guardado por pessoa e catálogo (`catalog_defaults`, migração v17; só campos permitidos, nunca o catálogo, a BC, nomes nem rastreamento; os dois criativos ficam em colunas com chave estrangeira: apagar o criativo só limpa o vínculo). O servidor valida tudo de novo e confere que cada criativo é **da própria pessoa** e do tipo certo. É preferência da pessoa (não altera nada no TikTok), então quem só enxerga um catálogo compartilhado pode ter o próprio padrão sem mexer no do dono. API: `GET/PUT/DELETE /api/tiktok/catalogs/:id/defaults`.
  Onde é usado: o botão **"Criar campanha com este catálogo"** (abre o assistente já preenchido, usando o que está na tela ou o salvo) e, no assistente normal, o botão **"Usar o anúncio padrão deste catálogo"** sob o seletor de catálogo (também sugere os nomes do grupo e do anúncio se estiverem em branco). Na publicação, os criativos da biblioteca seguem o caminho de sempre (cada conta recebe a própria versão limpa).
- **Atalho de campanha:** "Criar campanha com este catálogo" abre o assistente já no passo Campanha, com Vendas de produtos, o catálogo e a BC dona, vídeo do catálogo, o país do catálogo como destino e nomes sugeridos.
- **Conjuntos de produtos** (`/catalog/set/get/` e `/catalog/set/create/`): filtros simples (marcas, palavras do título, preço mínimo/máximo, estoque, condição) viram as `conditions` oficiais (campo + operador da tabela “Product set operators and fields”).
- API: `GET /api/tiktok/catalogs`, `GET .../meta`, `POST /api/tiktok/catalogs`, `GET .../:id/overview|products|logs/:feedLogId|sets`, `POST .../:id/products|sets`. **Toda** chamada traz a conexão e a BC; o servidor confere que a
  conexão é do usuário e que a BC é uma das dela (nunca aceita BC solta) e que o ID do catálogo é numérico. O token nunca sai do servidor. Limites próprios de leitura, atualização e escrita.

**Campanha de catálogo** (assistente → objetivo “Vendas de produtos”) agora segue o contrato oficial de **Catalog Ads** (Video Shopping Ads com produtos de catálogo):

| Nível | O que é enviado |
|---|---|
| Campanha | `objective_type: PRODUCT_SALES` + `campaign_product_source: CATALOG`; **sem** otimização de orçamento (CBO é allowlist para catálogo) nem categorias especiais: o orçamento fica no grupo |
| Grupo de anúncios | `shopping_ads_type: VIDEO`, `product_source: CATALOG`, `catalog_id`, `catalog_authorized_bc_id` (a BC dona do catálogo), `promotion_type: WEBSITE`, `shopping_ads_retargeting_type: OFF`, posicionamento automático ou só TikTok; sem identidade no grupo |
| Metas | **Cliques** (cobrança CPC, sem pixel), **Conversões** (pixel + evento, oCPM; lance manual em `conversion_bid_price`) e **Valor/ROAS** (pixel + evento “Compra”, menor custo + `deep_bid_type: VO_HIGHEST_VALUE`) |
| Anúncio | `identity_type: CUSTOMIZED_USER`, `catalog_id`, `product_specific_type` (**todos**, **conjunto** com `product_set_id` ou **até 20 SKUs** em `sku_ids`), `ad_format: SINGLE_VIDEO` com `vertical_video_strategy` **CATALOG_VIDEOS** (vídeo gerado com os produtos) ou **SINGLE_VIDEO** (o seu vídeo + capa), `dynamic_format: UNSET`, texto e botão obrigatórios, destino dinâmico (`DLP`) nas metas de conversão e a URL da loja como plano B (`shopping_ads_fallback_type: CUSTOM`) |

Na tela, o catálogo e o conjunto de produtos são **escolhidos de listas** (o ID da BC dona é preenchido junto; os campos para digitar o ID continuam). As combinações que o TikTok recusa (ex.: pixel na meta Cliques, Pangle, ritmo acelerado
com menor custo) são bloqueadas no assistente e no servidor. Fora do escopo: catálogo por app (`APP_ANDROID`/`APP_IOS`), carrossel de catálogo (exige música), vídeos próprios do catálogo (allowlist), retargeting e **TikTok Shop** (a partir
do 3º trimestre de 2025 o TikTok exige o GMV Max). “Catalog Ads” é liberado automaticamente para anunciantes de comércio na web; para app é por allowlist.
**Pendente de conferência com o TikTok real:** as respostas de `/catalog/*` e a criação de anúncio de catálogo com um token de verdade (os testes usam um TikTok simulado que **recusa** tudo o que fugir do contrato oficial).

## Limites de frequência do TikTok

O TikTok limita as chamadas **por endpoint e por app** (nível Basic: **10 por segundo e 600 por minuto**, somando todos os usuários e a coleta por hora). Passou disso, responde `40100`; no limite por minuto o endpoint fica
suspenso por 5 minutos. Com dezenas de contas isso aparecia no Gerenciador (“O TikTok limitou as consultas”). O que o sistema faz agora:
- **Ritmo único por endpoint** no processo inteiro (`TIKTOK_MIN_INTERVAL_MS`, 120 ms = no máximo ~8 por segundo) e **repetição com espera crescente** das consultas recusadas por frequência (`TIKTOK_RATE_LIMIT_RETRIES`, `TIKTOK_RETRY_DELAY_MS`). Criações
  nunca são repetidas (poderiam duplicar); ativar/pausar anúncio, por ser idempotente, é.
- **Gerenciador:** pede o desempenho só das contas que **têm anúncios** (conta vazia = 1 chamada), consulta 4 contas por vez, guarda o resultado **por conta** e, se o TikTok pedir pausa, não insiste nas demais: avisa e o “Atualizar” consulta **só**
  as contas que faltaram (as que carregaram há menos de 15 s são reaproveitadas).
- Se o app subir de nível (Advanced/Premium/Ultimate, em Meus apps → Autorização), reduza `TIKTOK_MIN_INTERVAL_MS`.

## Automação → Campanha one-click

Menu **Automação → Campanha one-click** (exige a área “Campanhas”). A pessoa monta **uma vez** a campanha completa (campanha, grupo de anúncios e anúncio, com os mesmos passos e textos de ajuda do assistente), dá um nome
(“Campanha para os Estados Unidos”, “Campanha para o Brasil”) e ela vira um **cartão** com dois botões: **Apagar** e **Publicar**. O **+** cria uma configuração nova; **Duplicar** abre uma cópia já no passo do anúncio (para trocar os criativos sem montar tudo de novo; o nome sugerido é “… (cópia)” e só vira cartão quando você salva); clicar no título do cartão a edita.

- **Publicar** abre um pop-up com **todas as contas de anúncio** em lista, agrupadas por Business Center, com **busca por nome ou ID da conta**, filtro por **Business Center**, por **tipo** (comuns/agência), por **situação** (ativas/inativas)
  e por moeda (quando há mais de uma), mais "marcar todas as listadas". O botão **Publicar** fica sempre visível. Cada conta tem andamento, erro e retomada próprios e **entra já ATIVA ou PAUSADA, como você escolher** (veja “Publicar já ativa e várias campanhas por conta”). Os IDs próprios de cada conta (pixel, identidade…) podem ser ajustados ali.
- **Como funciona (reaproveita o que já existe):** a configuração é guardada em `campaign_templates` (migração 26, RLS, nome único por dono, até 50 por dono, sempre **completa**). Publicar chama `POST /api/automation/one-click/:id/launch`, que
  cria uma **campanha nova** a partir da configuração (re-validada no servidor, criativos conferidos) e a tela publica essa campanha conta por conta em `POST /api/campaigns/:id/publish` (mesmas travas, limites, criativos refeitos por conta e registro de atividades).
  A configuração **nunca é “gasta”**: serve para quantas publicações a pessoa quiser; apagar o cartão não apaga campanhas já publicadas. Se algumas contas falharem, tentar de novo na mesma janela retoma só as que faltam.
- API (`src/modules/automation/`): `GET/POST /api/automation/one-click`, `GET/PUT/DELETE /api/automation/one-click/:id`, `POST /api/automation/one-click/:id/launch`. Tudo escopado pelo dono do espaço (colaborador com a área “Campanhas” usa as configurações do dono; sem a área recebe 403).
  Criar, alterar, apagar e publicar entram no **registro de atividades** da equipe.

## Campanhas (assistente passo a passo)

- Cada etapa começa com uma frase simples dizendo o que fazer ali, cada bloco do formulário tem uma explicação curta (`GROUP_HELP` em `shared/campaign-spec.js`) e os campos que mais confundem têm dica própria (`help`).

- O botão flutuante **Publicar campanha** (canto inferior direito, em todas as telas) abre o assistente em um **pop-up**, já no passo
  Objetivo, com 5 etapas: **Objetivo → Campanha → Grupo de anúncios → Anúncio → Revisão e publicação**, espelhando a hierarquia do TikTok
  (campanha, grupo de anúncios, anúncio). Fechar com alterações não salvas pede confirmação; clicar fora não fecha. A lista de rascunhos e
  campanhas publicadas fica em **Início → Gerenciar campanhas** (endereço `/campaigns`; fora da barra lateral).
- No passo **Grupo de anúncios**, a seção **Meta e conversão** reúne, nesta ordem e juntos, a **meta de otimização**, o **pixel** (lista os pixels da conta) e o **evento de conversão** (só aparecem o pixel e o evento quando a meta
  é de conversão); lance, cobrança e ritmo ficam logo abaixo em **Lance e cobrança**. Em campanha de catálogo, o catálogo vem antes.
- **A conta de anúncio é escolhida no FINAL** (etapa de revisão), não no começo: a mesma campanha pode ser publicada em **várias contas, de
  várias Business Centers**, de uma vez. As contas aparecem agrupadas por Business Center (com a moeda de cada uma). O sistema publica
  **uma conta por vez**, mostra o progresso e o resultado de cada uma, e a falha de uma não impede as outras; dá para tentar de novo só as
  que falharam (retoma de onde parou, sem duplicar). Cada publicação (campanha × conta) é registrada em `campaign_publications`.
- IDs que pertencem a uma conta específica (pixel, app, catálogo, conjunto de produtos, formulário de leads e identidade) podem ser
  **ajustados por conta** na publicação ("Ajustar IDs desta conta"); o restante da campanha continua igual. Orçamentos e lances são enviados
  como o mesmo número em cada conta, **na moeda dela** (sem conversão): o sistema avisa quando as contas escolhidas têm moedas diferentes.
- Depois que uma conta conclui, a configuração da campanha fica travada (a mesma vale para todas as contas), mas dá para publicar em
  novas contas depois ("Detalhes e novas contas" na lista). Para mudar o anúncio, crie uma nova campanha.
- Cobre os **8 objetivos** (tráfego, conversões no site, vendas de produtos, leads, app, alcance, vídeo, engajamento) e as
  configurações de cada nível: orçamento (sem limite/diário/total, na campanha ou no grupo), agenda, posicionamentos, público
  (países, gênero, idades, idiomas, sistema, interesses e públicos por ID), meta de otimização, evento de cobrança, lance, ritmo,
  frequência, pixel/app/catálogo/formulário, identidade, criativo (vídeo, imagem, carrossel), texto, botão, URLs, UTM e rastreamento.
- Os campos, opções por objetivo e regras ficam em **um único arquivo**, `shared/campaign-spec.js`, usado pelo navegador (para montar
  o formulário e validar na hora) e pelo servidor (que valida de novo e é a autoridade). Para suportar uma nova opção, edite só esse arquivo.
- **Rascunhos:** salve em qualquer etapa (basta ter escolhido o objetivo). Campos obrigatórios só são exigidos para publicar.
- **Publicar no TikTok:** cria campanha, grupo e anúncio **pausados ou já ativos, como você escolher** (veja abaixo), exige confirmação,
  só aceita contas de anúncio das suas Business Centers (ou das compartilhadas) e, se um nível falhar, **retoma** de onde parou sem duplicar.
  O que já foi criado no TikTok (em qualquer conta) não pode mais ser alterado na configuração.
- **Criativos:** o vídeo, a capa e as imagens do anúncio são escolhidos da sua **biblioteca de criativos** (menu Criativos).
  Identidade, pixel, app, catálogo e formulário continuam sendo **referenciados por ID** (já cadastrados no TikTok).
- As combinações (objetivo × meta × cobrança) e os valores seguem a estrutura documentada da Marketing API, mas **não foram validados
  contra a API real** (sem credenciais): o TikTok valida na publicação e a mensagem dele é exibida. Ajustes ficam em
  `shared/campaign-spec.js` e `src/modules/tiktok/tiktok.payloads.js`.
- **Publicação segura:** uma trava por campanha impede publicações simultâneas (sem itens duplicados no TikTok) e bloqueia editar/excluir
  enquanto publica. O início do grupo de anúncios é sempre enviado (obrigatório no TikTok), no fuso da conta.
- O banco evolui por **migrações** (`src/db/migrations.js`), sem perder dados.

### Publicar já ativa e várias campanhas por conta

No painel “Publicar em” (assistente de campanha e Automação → Campanha one-click) há duas opções, valendo para todas as contas marcadas:
- **Publicar já ativa** (ligada por padrão): campanha, grupo de anúncios e anúncio nascem `ENABLE`. **Começa a gastar o orçamento assim que o TikTok aprovar o anúncio** (a análise do TikTok continua valendo). A confirmação diz isso com todas as
  letras e o botão mostra “(ativa)”/“(pausada)”. Desmarcada, tudo nasce `DISABLE` como antes. A API (`POST /api/campaigns/:id/publish`) aceita `activate` (booleano; **sem ele o padrão da API continua PAUSADA**; outro tipo é 400) e responde `activated`;
  a campanha local fica “ativa” ou “pausada” e o registro de atividades guarda “Publicada já ativa/pausada”. Se uma tentativa anterior criou níveis pausados (publicação retomada ou campanha reaproveitada), eles recebem a situação
  pedida agora (`/campaign|adgroup|ad/status/update/`).
- **Campanhas iguais por conta (1 a 10):** cria N campanhas idênticas em cada conta marcada (ex.: 5 campanhas para testar fatias de público; depois você ajusta o público de cada uma no TikTok). Cada cópia é um rascunho próprio com nome numerado
  (“Nome 01”, “Nome 02”…; com 1 só, o nome fica como está), com o mesmo grupo de anúncios e anúncio. **Teto de 60 campanhas por rodada** (cópias × contas): ao marcar mais contas, a quantidade máxima encolhe (`maxCopiesFor`). O servidor cria as
  cópias em `POST /api/campaigns/:id/copies` (`{ count: 2 a 10 }`, a campanha original não muda) e `POST /api/automation/one-click/:id/launch` aceita `{ count }`. As publicações vão uma conta de cada vez e, em cada conta, uma cópia de cada vez; se uma cópia
  falha as seguintes daquela conta não são tentadas e, ao publicar de novo na mesma tela, as que já existem são puladas. Ao bater o limite de pedidos por minuto (429), a tela **espera sozinha** e continua (“aguardando o limite de pedidos…”).
- Os textos (confirmação, resumo, avisos) ficam em `shared/publish-messages.js` e as regras das cópias em `shared/campaign-copies.js`, ambos testados. Isso também corrigiu um aviso enganoso no assistente (mostrava “Nenhuma conta foi publicada”
  mesmo quando a publicação dava certo).

### Publicada de verdade: conferência no TikTok (campanha sem conjunto de anúncios e sem anúncio)

Uma publicação só é dada como concluída se **campanha, conjunto de anúncios e anúncio existem de verdade no TikTok**. O sistema não confia só na resposta de "criado": depois de criar, **confere por ID**
(`/campaign/get/`, `/adgroup/get/` e `/ad/get/` com `campaign_ids`/`adgroup_ids`/`ad_ids`, sem os excluídos), tentando algumas vezes porque o TikTok pode demorar um instante para listar o que acabou de criar
(esperas em `config.tiktok.verifyBackoffMs`, padrão 0,4 s, 1,2 s e 3 s). O que acontece:
- **Falta algum nível:** a publicação **não** vira "publicada": o erro aparece na tela (“O TikTok respondeu que criou, mas não encontramos o conjunto de anúncios…”, 502 `tiktok_not_found`), o ID do nível que não existe (e o dos que dependem
  dele) é esquecido (`src/lib/created-levels.js`) e a próxima tentativa recria **só o que falta**, na mesma campanha.
- **Retomada com IDs guardados:** os IDs de uma tentativa anterior são conferidos ANTES de retomar; o que foi excluído no TikTok é recriado (antes, o sistema pulava o nível e dava "publicada" sem criar nada).
- **"Já publicada":** a recusa (409) agora também confere por ID; se faltar algo no TikTok, a conta volta para "tentar de novo" e recria o que falta.
- **Não deu para conferir** (a consulta falhou): publica mesmo assim e **avisa** (“não deu para conferir no TikTok”, `verified: false` na resposta): nunca afirma mais do que sabe, e nunca bloqueia por não conseguir ler.
- **"Conferir no TikTok":** botão em cada conta publicada (assistente e Campanha one-click) e `POST /api/campaigns/:id/verify` (`{ advertiserId? }`; sem ele, todas as contas publicadas da campanha, até 60). Se faltar algo, a conta volta para "tentar de novo"
  (sem excluir nada no TikTok). **Ao abrir uma campanha já publicada**, a conferência roda sozinha (até 5 contas, uma vez por abertura) e só fala se achar problema.
- A linha de cada conta publicada mostra os três IDs (“Campanha … · Conjunto … · Anúncio …”) e o rótulo “conferida no TikTok”, para você comparar com o Gerenciador do TikTok.
Campanhas vazias que tentativas antigas que falharam deixaram no TikTok **continuam lá** (este sistema nunca exclui nada no TikTok): apague-as pelo Gerenciador ou use "Conferir no TikTok" na campanha para completá-las.

### Nome de campanha repetido (erro “Campaign name already exists”)

O TikTok não aceita duas campanhas com o mesmo nome na mesma conta de anúncio. Rodar a mesma configuração one-click de novo cria um rascunho NOVO com o mesmo nome, então isso acontecia quando
uma tentativa anterior tinha parado no meio (campanha criada no TikTok, grupo recusado) ou quando a configuração já tinha sido publicada naquela conta. Agora:
- **Campanha que sobrou de uma tentativa que falhou é reaproveitada:** se este usuário já criou, NESTA conta, uma campanha de outro rascunho com o mesmo nome e ela ficou sem grupo de anúncios, e a parte
  da campanha (objetivo, orçamento…) é idêntica, a nova publicação continua dela (sem criar outra) e a publicação antiga solta o ID (`campaign_publications.tiktok_campaign_id` nulo) para ninguém reivindicá-la
  duas vezes. Nunca adota campanha de outra conta de anúncio nem de outra pessoa.
- **Nome já usado por outra campanha:** o sistema tenta “Nome (2)”, “Nome (3)”… (até 20 tentativas, sempre dentro dos 100 caracteres) em vez de falhar; o rascunho local mantém o nome original, a resposta de
  `POST /api/campaigns/:id/publish` traz `renamedTo` e a tela avisa (“Já existia uma campanha com esse nome na conta: a nova ficou como …”). Se todos os números estiverem ocupados, volta o erro do TikTok.
- Qualquer outro erro do TikTok na criação da campanha segue como antes (uma única tentativa).

### Evento de conversão do pixel (erro “This pixel event type does not exist”)

Em campanha de **conversões**, o grupo de anúncios otimiza por um **evento do pixel** (Compra, Início de pedido…) e o TikTok só aceita se o evento **já existir no pixel**; vincular o pixel
à conta **não** cria eventos. O campo “Evento de conversão” oferece agora exatamente os **12 eventos web da tabela oficial** (`shared/pixel-events.js`: `SHOPPING`, `INITIATE_ORDER`,
`ON_WEB_CART`, `ADD_BILLING`, `ON_WEB_DETAIL`, `FORM`, `ON_WEB_REGISTER`, `ON_WEB_SUBSCRIBE`, `ON_WEB_SEARCH`, `ON_WEB_ADD_TO_WISHLIST`, `CONSULT`, `DOWNLOAD_START`). As versões antigas ofereciam
“Pagamento concluído” (`COMPLETE_PAYMENT`) e “Adicionar ao carrinho” (`ADD_TO_CART`), valores que **não existem** no TikTok: campanhas e configurações salvas com eles são corrigidas sozinhas
(Pagamento concluído → Compra; Carrinho → `ON_WEB_CART`).
- **Seletor de pixel:** ao escolher um pixel da lista, mostra os **eventos que ele já tem** (`events` de `/pixel/list/`, só os padrões) e, se o evento da campanha não estiver entre eles, um aviso com o botão
  **“Criar ‘Compra’ no pixel”**. O pop-up cria o evento pela API (`POST /api/tiktok/advertisers/:id/pixel-events` com `{ pixelId, eventType, name? }` → `/pixel/event/create/`, sem regras, estatística
  “toda vez”): só mostra os eventos que o pixel ainda não tem; o servidor confere que o pixel está na lista da conta (404 se não) e não recria evento que já existe; limite de 20 criações a cada 10 min por usuário; entra
  no registro de atividades. **Para o evento contar conversões o site precisa enviá-lo** (código do pixel ou API de Eventos): criar o evento só o registra no pixel.
- **Antes de publicar:** se o pixel aparece na lista da conta COM eventos e o escolhido não está entre eles, a publicação é recusada **antes de criar qualquer coisa** (422 `pixel_event_missing`, dizendo o que o pixel
  tem e o que fazer). Pixel novo (lista vazia: o TikTok atualiza essa lista a cada 2 a 4 horas), pixel que não aparece ou falha na consulta **não bloqueiam**; se o TikTok recusar mesmo assim, o erro vem
  **explicado em português** (mantendo a mensagem original entre parênteses) e a campanha retoma de onde parou depois de criar o evento.
- **“Pixel cannot be modified.”** O TikTok recusa criar o evento quando a conta não pode alterar o pixel (ele só foi compartilhado com ela, ou o usuário do acesso não tem permissão de edição). `/pixel/list/`
  informa `asset_ownership` (`ownership` verdadeiro = a conta é a dona; `SHARED`/`UNBOUND` = só compartilhado), que o seletor mostra como aviso. Ao criar o evento de um pixel só compartilhado, o servidor procura, entre as
  contas da mesma conexão (até 40), a que é DONA do pixel e cria o evento por ela; se não houver dona na conexão (ou o TikTok recusar mesmo assim), o erro vem explicado (422 `pixel_not_modifiable`: causas prováveis e o que
  fazer, com a mensagem original entre parênteses). O caminho que sempre funciona é criar o evento no Gerenciador de Eventos do TikTok, na conta que criou o pixel (Pixel → Configurar eventos).
**Pendente de conferência com o TikTok real:** se `/pixel/event/create/` sem regras registra o evento em todos os tipos de pixel (a documentação não detalha) e a permissão do token para alterar o pixel.

### Identidade do anúncio (identidade personalizada com nome e foto)

No passo **Anúncio** (e nos ajustes por conta da publicação), o campo **“ID da identidade”** lista as identidades que a conta de anúncio já tem, do tipo escolhido
(`GET /api/tiktok/advertisers/:id/identities?type=CUSTOMIZED_USER|TT_USER|BC_AUTH_TT`, que lê `/identity/get/` do TikTok, em cache de 60 s; `BC_AUTH_TT` usa a
BC dona da conta; `AUTH_CODE` não é listado pelo TikTok e continua sendo só o campo para colar). O ID **não é o @ do perfil**: é o que o TikTok dá à identidade.
Para o tipo **identidade personalizada** há o botão **“Criar identidade”**: pede o **nome** (1 a 100) e uma **foto** opcional (JPG, PNG ou WebP). A foto é **recortada no
navegador em quadrado (1:1)** pelo centro (exigência do TikTok), vira JPEG de até 640 px e nunca sai do computador sem esse recorte. O servidor
(`POST /api/tiktok/advertisers/:id/identities?name=…`, corpo = a imagem `image/jpeg` ou `image/png`, ou JSON vazio sem foto) **confere a foto pelo conteúdo**
(`src/lib/image-size.js`: tipo e tamanho lidos do cabeçalho; precisa ser quadrada, de pelo menos 100 px e de até 2 MB), envia a imagem à biblioteca da conta
(`/file/image/ad/upload/`, nome único, MD5) e cria a identidade (`/identity/create/` com `display_name` e `image_uri`). Sem foto, o TikTok usa uma imagem padrão.
Depois de criar, a lista é relida e o ID novo já entra no campo. Trocar o “Tipo de identidade” **limpa o ID** (o de um tipo não vale para outro). No máximo 20 criações a
cada 10 minutos por usuário; só quem tem as áreas “Campanhas” ou “Contas TikTok”; conta de outra pessoa é 404. Regras e limites em `shared/identity.js`.
**Pendente de conferência com o TikTok real:** a permissão do token para criar identidade e a exigência de tamanho mínimo da foto (o código usa 100 px por segurança).

## Estrutura

```
src/
  server.js            inicialização (admin, limpeza de sessões, shutdown)
  app.js               composição do Express (helmet/CSP, rotas, estáticos)
  config.js            variáveis de ambiente
  db/                  conexão (pg / PGlite), migrações PostgreSQL, importador do SQLite antigo
  lib/                 password (scrypt), validação, rate limit, cookies, erros
  middleware/          sessão, guards (auth/aprovação/admin/CSRF), erros
  modules/
    auth/              cadastro, login, logout, sessões
    users/             repositório de usuários
    admin/             aprovação de contas, acesso do admin à conta de um usuário (somente leitura) e registro de auditoria
    notifications/     o sino do topo: notificações do admin (todos ou uma pessoa), leitura por pessoa
    billing/           assinaturas em dólar: planos por pessoa, gasto guardado, fechamento mensal, pagamentos, bloqueio de BC com débito, cotações
    assistant/         dados que o assistente do Início pede ao servidor (contas que caíram, criativos enviados)
    campaigns/         CRUD de campanhas internas (escopado por usuário)
    tiktok/            Business Centers (cliente da API, conexão por link/OAuth, repositórios, serviço, rotas) e gasto por hora (coleta + leitura)
    creatives/         biblioteca de criativos (armazenamento, validação por conteúdo, rotas)
    team/              colaboradores: convites, aceite, áreas de acesso (repositório, serviço, rotas)
    automation/        Campanha one-click: configurações de campanha reutilizáveis que publicam em várias contas (repositório, serviço, rotas)
    activity/          registro de atividades da equipe (observador de rotas, regras, repositório, serviço)
    profile/           Minha conta: foto de perfil (recodificada no FFmpeg), nome e nível de gasto
    files/             arquivos anexados da conta (criptografados, só download)
    mail/              envio de e-mail pelo Resend e modelo do convite
    hooks/             Hook com IA: cliente da Kling, geração em segundo plano, FFmpeg (cortar e juntar ao vídeo), rotas
    manager/           Gerenciador de anúncios: todos os anúncios das contas, ativar/pausar, visualizações salvas (serviço, repositório, rotas)
    catalog/           Catálogo de produtos: catálogos das BCs, criar catálogo, enviar produtos, conjuntos de produtos (serviço, mapeamento oficial, rotas)
scripts/               utilitários: db (check/migrate), import-sqlite, supabase-setup.sql
shared/                regras compartilhadas (navegador + servidor): campanhas, etiquetas de conta, permissões por área, criação de contas
public/                SPA em JS puro (sem innerHTML), CSS e views
tests/                 testes de API, segurança, banco e utilitários (tests/live: opcionais, usam rede)
certs/                 CA pública do Supabase (verificação do TLS)
```

## Segurança (resumo)

- Senhas: `scrypt` (N=2^15) com salt; comparação em tempo constante; hash fictício contra enumeração por tempo.
- Sessão: token aleatório de 256 bits em cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` em produção); só o SHA-256 do token fica no banco; novo token a cada login.
- CSRF: verificação de `Origin`/`Sec-Fetch-Site` + token CSRF por sessão em toda escrita autenticada.
- Rate limit: login por IP e por conta+IP, cadastro por IP (`429` + `Retry-After`).
- Cadastro não revela se o e-mail existe; `role`/`status` nunca vêm do cliente.
- SQL 100% parametrizado ($1, $2…); validação estrita de entradas; corpo JSON limitado a 10 KB (64 KB no assistente de campanhas).
- Banco: TLS verificado, papel de menor privilégio, schema isolado, RLS sem políticas e sem privilégios às chaves públicas do Supabase.
- CSP restritiva (sem inline/eval), `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `Cache-Control: no-store` na API.
- Front-end sem `innerHTML`: dados de usuários viram texto, não HTML (anti-XSS).

## Operação segura

- Proteja o `.env` (somente o seu usuário: `chmod 600 .env`). Ele guarda a `DATABASE_URL` (com a senha do papel do banco), a senha do
  admin e a chave que criptografa os tokens do TikTok; o banco guarda os tokens já criptografados. Guarde a chave junto do backup do
  banco: **sem ela os tokens salvos não podem ser lidos** (será preciso informá-los de novo).
- Tokens de acesso pessoal e chaves `service_role`/`secret` do Supabase **não são usados pelo sistema**: não os coloque no `.env`.
  Se algum já foi compartilhado (chat, e-mail), revogue/gire no painel do Supabase.
- Nunca versione o `.env` (já está no `.gitignore`).

## Deploy no Render

O arquivo `render.yaml` descreve o serviço (Blueprint): Node 24, health check em `/api/health`, `TRUST_PROXY=1`, `HOST=0.0.0.0` e um
**disco persistente** em `/var/data` para os criativos (o disco do Render é apagado a cada deploy, a menos que seja persistente, o que
exige plano pago). O banco continua no Supabase (schema `tiktok_ads`); as migrações rodam sozinhas na inicialização.

1. Envie o código para um repositório **privado** no GitHub (o `.env` e a pasta `data/` já estão no `.gitignore`).
2. No Render: **New → Blueprint** apontando para o repositório. Preencha os segredos pedidos (`DATABASE_URL`, `ADMIN_PASSWORD`,
   `TOKEN_ENCRYPTION_KEY`, `TIKTOK_APP_ID`/`TIKTOK_APP_SECRET`/`TIKTOK_REDIRECT_URI` para a conexão por link, e
   `RESEND_API_KEY`/`APP_URL` para os convites de colaboradores).
3. `TIKTOK_REDIRECT_URI` = `https://SEU-SERVICO.onrender.com/api/tiktok/callback` (a mesma URL cadastrada como Redirect URL no app do TikTok).
4. **Guarde `TOKEN_ENCRYPTION_KEY` com o mesmo valor de antes**: trocar a chave impede ler os tokens já salvos.

## Em produção

- `NODE_ENV=production` e HTTPS (ativa cookie `Secure` e HSTS). Atrás de proxy reverso, configure `app.set('trust proxy', ...)` para o rate limit enxergar o IP real.
- O rate limit é em memória (1 instância). Com várias instâncias, use um store compartilhado (ex.: Redis).
- Backups do banco: use os backups automáticos do Supabase (e ative o PITR se precisar de restauração a um ponto no tempo).
- Mantenha o `.env` fora do versionamento (já está no `.gitignore`).
