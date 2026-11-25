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

1. Qualquer pessoa cria conta em `/register` → status **pendente**.
2. Pendente/rejeitada/bloqueada vê apenas uma tela de status; **toda** a API (exceto login/cadastro/`me`/logout) responde `403`.
3. O admin (`ADMIN_EMAIL`) acessa **Administração**, e aprova, rejeita, bloqueia ou reativa. A mudança vale na próxima requisição; rejeitar/bloquear derruba as sessões na hora.

## Administrador

- E-mail: `ADMIN_EMAIL` (padrão `contato.guilhermecostas@gmail.com`). A conta é criada na inicialização com a senha de `ADMIN_PASSWORD`.
- Esse e-mail **não pode ser usado no cadastro público**, e ninguém consegue "tomar" a conta de admin registrando-o antes.
- Sem `ADMIN_PASSWORD`, uma senha aleatória é gerada e exibida uma vez no console.
- Para trocar a senha: altere `ADMIN_PASSWORD` e reinicie (sessões antigas do admin são encerradas).

## Integração TikTok (Business Centers)

1. Qualquer usuário aprovado abre **Contas TikTok → Conectar Business Center**. Há dois caminhos:
   - **Por link (recomendado):** informa só um nome, o sistema gera um **link de autorização** (vale 15 min, uso único). O usuário
     copia o link, abre no navegador/perfil em que está logado na Business Center do TikTok, escolhe as contas de anúncio e confirma.
     A janela do sistema acompanha sozinha e conclui a conexão. Não é preciso copiar tokens nem IDs. Requer o app do TikTok
     configurado no servidor (abaixo).
   - **Por token (avançado):** informa o **ID da BC** e um **token de acesso** da Marketing API. O servidor valida o token no TikTok
     antes de gravar e sincroniza as contas de anúncio. Fica disponível em “Prefiro colar um token” e é o caminho usado quando o app
     do TikTok não está configurado.
2. **Contas TikTok** tem três sub-abas, no mesmo layout centralizado (cabeçalho, abas segmentadas e cartões de largura igual; no celular as
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
- **Configuração do e-mail** (segredos do servidor, nunca no navegador nem no repositório): `RESEND_API_KEY` (a chave pode ser só de
  envio), `EMAIL_FROM` (padrão `TikTok Ads Manager <convites@payfac.dev>`, o domínio precisa estar verificado no Resend) e `APP_URL`
  (endereço público, usado nos links; **nunca** deduzido do cabeçalho Host). Sem elas o convite fica indisponível e a tela avisa.
- **Para criar uma área nova:** acrescente-a em `shared/permissions.js`, proteja as rotas com `requireArea` e crie uma migração que
  amplie o CHECK das colunas `areas`. Regras em `shared/permissions.js`; espaço de trabalho em `src/middleware/workspace.js`.

## Foto de perfil (Minha conta)

Clicar na conta, no canto do menu, abre **Minha conta**: a pessoa escolhe uma foto, ajusta o recorte (arrastar, zoom, girar, teclado) e salva;
também troca o nome e remove a foto. A foto aparece no menu e para a equipe (na tela **Colaboradores** o dono vê a foto de cada um).
Colaboradores configuram a própria foto sem precisar de nenhuma área.

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
- **Menu lateral por grupos:** **Início** (sem título, é a porta de entrada) → **Ads** (Gerenciador, Criativos, Catálogo) → **BC e CA** (Contas TikTok, Saldo) → **Gestão** (Colaboradores, Administração) → **KPI** (Relatórios). O título de um grupo só aparece se a pessoa vê algum item dele; a busca do menu esconde os títulos.
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
- **Pastas de criativos** (biblioteca de Criativos): uma pasta por oferta (um nível), com contagem, "Sem pasta" e "Todos". Criar, renomear (nome único por usuário, sem
  diferenciar maiúsculas; até 100 pastas) e apagar (**apagar a pasta não apaga criativos**: voltam para "Sem pasta"). Enviar com uma pasta aberta já coloca o arquivo nela;
  mover um criativo (ícone da pasta no cartão), vários de uma vez (caixas de seleção → "Mover para pasta…", com opção de criar a pasta na hora) ou **arrastando** o cartão
  até o nome da pasta. O seletor de criativos da campanha tem filtro por pasta, e o vídeo "hook + vídeo" fica na mesma pasta do original. API: `GET/POST /api/creatives/folders`,
  `PATCH/DELETE /api/creatives/folders/:id`, `POST /api/creatives/move` (`{ ids, folderId|null }`, tudo ou nada), `PATCH /api/creatives/:id` (`{ name?, folderId? }`),
  `GET /api/creatives?folderId=ID|none` e `POST /api/creatives?folderId=ID`. Tabela `creative_folders` + `creatives.folder_id` (migração v14). Nomes entram sempre como texto.
- **Conferência com a documentação oficial:** o portal de documentação do TikTok publica o conteúdo em `GET https://business-api.tiktok.com/gateway/api/doc/client/node/get/v2/?doc_id=ID`
  (ou `content_slug=...&version=1.3`). Conferidos: `/bc/advertiser/create/`, `/bc/get/`, `/bc/balance/get/`, `/advertiser/balance/get/`, `/report/integrated/get/` (hora: 1 dia por consulta; dia: até 30),
  `/pixel/list/` (**page_size 1 a 20**), `/bc/asset/get/` (1 a 50), `/campaign/get/` (até 1000), `/advertiser/info/` (campo de e-mail é `email`) e os apêndices de fuso, país e ramo.
- **Saldo** (menu "Saldo", área "Contas TikTok"): duas subabas SEPARADAS, **Business Centers** (`/balance`) e **Contas de anúncio** (`/balance/accounts`). Cada linha mostra o saldo
  disponível, a situação (**com saldo**, **sem saldo** ou **sem informação**, com o motivo ao passar o mouse) e, em "Detalhes", **todos** os valores que o TikTok devolveu (saldo total,
  dinheiro, bônus, bloqueado, impostos, orçamento…). Uma BC sem saldo com contas com saldo (e o contrário) aparecem normalmente, e cada conta diz se a BC dela tem saldo. Filtros: busca,
  situação, moeda e conexão; resumo por moeda (moedas diferentes nunca se somam). Dados da API real: `GET /bc/balance/get/` e `GET /advertiser/balance/get/` (confirmados com token falso;
  o TikTok **não documenta o formato da resposta**, então o sistema lê todos os campos numéricos de forma tolerante e usa nomes em português só para os conhecidos). Só as conexões do
  PRÓPRIO usuário (nada compartilhado), cache de 60 s que muda sozinho ao conectar/remover/sincronizar, "Atualizar agora" com limite (6 por 5 minutos) e consulta de poucas BCs ao
  mesmo tempo; falha em uma BC (ex.: sem permissão financeira) aparece naquela BC e não derruba as outras. API: `GET /api/tiktok/balance[?refresh=1]`. **Pendente de conferência com um
  token real:** o formato exato da resposta e se o token da conexão tem permissão financeira na BC.
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

**Gerenciador** (menu lateral; exige a área “Campanhas” ou “Relatórios”) mostra, em uma única tabela, **os anúncios de todas as contas** das Business Centers ativas
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

- **Listar** (`GET /catalog/get/`, paginado): nome, ID, BC, país/moeda e se o catálogo já serve para anúncios (`ad_creation_eligible`). Falha em uma BC (ex.: o acesso não inclui “Catálogo”) aparece
  naquela BC e as outras seguem. O cache de 60 s inclui as conexões, então conectar uma BC mostra os catálogos na hora.
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

## Campanhas (assistente passo a passo)

- O botão flutuante **Publicar campanha** (canto inferior direito, em todas as telas) abre o assistente em um **pop-up**, já no passo
  Objetivo, com 5 etapas: **Objetivo → Campanha → Grupo de anúncios → Anúncio → Revisão e publicação**, espelhando a hierarquia do TikTok
  (campanha, grupo de anúncios, anúncio). Fechar com alterações não salvas pede confirmação; clicar fora não fecha. A lista de rascunhos e
  campanhas publicadas fica em **Início → Gerenciar campanhas** (endereço `/campaigns`; fora da barra lateral).
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
- **Publicar no TikTok:** cria campanha, grupo e anúncio **sempre pausados** (nada gasta até ativar no TikTok), exige confirmação,
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
    admin/             aprovação de contas
    campaigns/         CRUD de campanhas internas (escopado por usuário)
    tiktok/            Business Centers (cliente da API, conexão por link/OAuth, repositórios, serviço, rotas) e gasto por hora (coleta + leitura)
    creatives/         biblioteca de criativos (armazenamento, validação por conteúdo, rotas)
    team/              colaboradores: convites, aceite, áreas de acesso (repositório, serviço, rotas)
    profile/           Minha conta: foto de perfil (recodificada no FFmpeg) e nome
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
