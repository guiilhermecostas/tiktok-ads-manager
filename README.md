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

- **Início** é um chat no estilo ChatGPT (por enquanto só o design: sugestões clicáveis, campo que cresce, "Enter envia", respostas de exemplo). A
  conversa fica só na memória do navegador (nada vai ao servidor) e é descartada se outra pessoa entrar. O texto entra sempre como texto.
- **Relatórios** (área "Relatórios" dos colaboradores) tem duas abas. **Visão geral**: 7 indicadores (gasto, impressões, cliques, CTR, CPC, conversões e
  custo por conversão) com variação contra o período anterior e mini gráfico; gráfico de linha com **curva suave** (spline cúbica monótona, SVG puro, sem
  biblioteca, com dica ao passar o mouse e navegação por setas); "O que chama atenção" (observações automáticas); ranking por conta com busca e ordenação.
  Filtros: período (7/14/30 dias), conta, moeda (valores de moedas diferentes nunca se somam) e comparar. API: `GET /api/tiktok/overview?days=&advertiserId=&compare=1`
  (série diária contínua por moeda, `previous`, `accounts`, `accountOptions`). **Por conta**: desempenho e campanhas de uma conta (o antigo "TikTok Ads"; `/tiktok` redireciona).
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
    tiktok/            Business Centers (cliente da API, conexão por link/OAuth, repositórios, serviço, rotas)
    creatives/         biblioteca de criativos (armazenamento, validação por conteúdo, rotas)
    team/              colaboradores: convites, aceite, áreas de acesso (repositório, serviço, rotas)
    profile/           Minha conta: foto de perfil (recodificada no FFmpeg) e nome
    files/             arquivos anexados da conta (criptografados, só download)
    mail/              envio de e-mail pelo Resend e modelo do convite
scripts/               utilitários: db (check/migrate), import-sqlite, supabase-setup.sql
shared/                regras compartilhadas (navegador + servidor): campanhas, etiquetas de conta, permissões por área
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
