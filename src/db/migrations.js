/**
 * Migrações do PostgreSQL (Supabase). Registradas na tabela `schema_migrations`; cada uma roda uma única vez,
 * em ordem, dentro de UMA transação com trava (várias instâncias subindo juntas não se atropelam).
 * NUNCA edite uma migração já aplicada: crie uma nova com a próxima versão.
 *
 * SEGURANÇA (Supabase): o Supabase expõe o schema `public` por uma API REST pública (chave `anon`).
 * Por isso TODA tabela nasce com RLS ligado e SEM políticas (nega tudo) e sem nenhum privilégio para
 * `anon`, `authenticated` e `service_role`. O sistema acessa o banco só pelo servidor, com a conexão Postgres.
 *
 * ISOLAMENTO: as tabelas são criadas no schema padrão da conexão (DATABASE_SCHEMA, ex.: `tiktok_ads`), que NÃO é exposto
 * pela API REST do Supabase e não mistura com outros sistemas do mesmo projeto.
 */
const APP_TABLES = ['users', 'sessions', 'campaigns', 'tiktok_business_centers', 'tiktok_advertisers'];

// Tabelas com coluna `id` de identidade (têm sequência própria). pg_get_serial_sequence falha em tabela sem `id`.
const IDENTITY_TABLES = ['users', 'campaigns', 'tiktok_business_centers'];

/**
 * SQL de proteção de tabelas do app (use em TODA migração que cria tabela):
 *  - RLS ligado e sem políticas = ninguém passa pela API REST do Supabase;
 *  - nenhum privilégio para as funções da API (anon, authenticated, service_role) nas NOSSAS tabelas e sequências
 *    (nunca em "todas as do schema": o banco pode ser compartilhado com outro sistema).
 * Se um dia a chave service_role vazar, estas tabelas continuam inacessíveis pela API REST.
 */
function protectTables({ rls, revoke, identity }) {
  return `
      ${rls.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n      ')}

      DO $$
      DECLARE
        api_role TEXT;
        tbl TEXT;
        seq TEXT;
      BEGIN
        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON TABLE ${revoke.join(', ')} FROM %I', api_role);
            FOREACH tbl IN ARRAY ARRAY[${identity.length ? identity.map((t) => `'${t}'`).join(', ') : ''}]::text[] LOOP
              seq := pg_get_serial_sequence(tbl, 'id');
              IF seq IS NOT NULL THEN
                EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', seq, api_role);
              END IF;
            END LOOP;
          END IF;
        END LOOP;
      END $$;`;
}

export const MIGRATIONS = [
  {
    version: 1,
    description: 'Esquema inicial (usuários, sessões, campanhas, Business Centers do TikTok) + RLS',
    sql: `
      CREATE TABLE users (
        id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email         TEXT        NOT NULL,
        name          TEXT        NOT NULL,
        company       TEXT,
        password_hash TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'user'    CHECK (role IN ('user','admin')),
        status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','blocked')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at   TIMESTAMPTZ,
        reviewed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
      CREATE INDEX idx_users_status ON users (status);

      CREATE TABLE sessions (
        token_hash TEXT        PRIMARY KEY,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT        NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_sessions_user ON sessions (user_id);
      CREATE INDEX idx_sessions_expires ON sessions (expires_at);

      CREATE TABLE campaigns (
        id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id            INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name               TEXT        NOT NULL,
        objective          TEXT        NOT NULL,
        daily_budget       INTEGER     NOT NULL CHECK (daily_budget >= 0),
        status             TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
        config             JSONB,
        advertiser_id      TEXT,
        tiktok_campaign_id TEXT,
        tiktok_adgroup_id  TEXT,
        tiktok_ad_id       TEXT,
        publish_error      TEXT,
        published_at       TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_campaigns_user ON campaigns (user_id);

      -- Business Centers pertencem a um usuário; "shared" libera a leitura para toda a equipe (só admin define).
      -- O token fica CRIPTOGRAFADO pela aplicação (AES-256-GCM) antes de chegar aqui.
      CREATE TABLE tiktok_business_centers (
        id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bc_id          TEXT        NOT NULL,
        name           TEXT        NOT NULL,
        access_token   TEXT        NOT NULL,
        shared         BOOLEAN     NOT NULL DEFAULT false,
        status         TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','error')),
        last_error     TEXT,
        last_synced_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, bc_id)
      );
      CREATE INDEX idx_tiktok_bc_owner ON tiktok_business_centers (owner_id);

      CREATE TABLE tiktok_advertisers (
        business_center_id INTEGER NOT NULL REFERENCES tiktok_business_centers(id) ON DELETE CASCADE,
        advertiser_id      TEXT    NOT NULL,
        name               TEXT    NOT NULL,
        currency           TEXT,
        timezone           TEXT,
        PRIMARY KEY (business_center_id, advertiser_id)
      );
      CREATE INDEX idx_tiktok_adv_id ON tiktok_advertisers (advertiser_id);

      ${protectTables({ rls: APP_TABLES, revoke: [...APP_TABLES, 'schema_migrations'], identity: IDENTITY_TABLES })}
    `,
  },
  {
    version: 2,
    description: 'Biblioteca de criativos por usuário (imagens e vídeos) e envios ao TikTok por conta de anúncio',
    sql: `
      -- Arquivo guardado pelo sistema (source = 'upload') OU referência a um criativo que já existe na conta do TikTok (source = 'tiktok').
      -- Só o servidor lê/grava; o arquivo em si fica no armazenamento (storage_key), nunca no banco.
      CREATE TABLE creatives (
        id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name              TEXT        NOT NULL,
        kind              TEXT        NOT NULL CHECK (kind IN ('image', 'video')),
        source            TEXT        NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'tiktok')),
        original_filename TEXT,
        mime_type         TEXT,
        size_bytes        BIGINT      CHECK (size_bytes >= 0),
        sha256            TEXT,
        md5               TEXT,
        storage_key       TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (
          (source = 'upload' AND storage_key IS NOT NULL AND sha256 IS NOT NULL AND md5 IS NOT NULL AND mime_type IS NOT NULL AND size_bytes IS NOT NULL)
          OR (source = 'tiktok' AND storage_key IS NULL)
        )
      );
      CREATE INDEX idx_creatives_user ON creatives (user_id, created_at DESC, id DESC);
      -- O mesmo arquivo não entra duas vezes na biblioteca do mesmo usuário.
      CREATE UNIQUE INDEX creatives_user_sha256_key ON creatives (user_id, sha256) WHERE sha256 IS NOT NULL;

      -- ID que o TikTok deu ao criativo em cada conta de anúncio (evita reenviar o mesmo arquivo).
      CREATE TABLE creative_tiktok_assets (
        creative_id   INTEGER     NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
        advertiser_id TEXT        NOT NULL,
        tiktok_id     TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (creative_id, advertiser_id)
      );

      ${protectTables({ rls: ['creatives', 'creative_tiktok_assets'], revoke: ['creatives', 'creative_tiktok_assets'], identity: ['creatives'] })}
    `,
  },
  {
    version: 3,
    description: 'Conexão com o TikTok por link de autorização (OAuth): tipo da conexão e tentativas de autorização',
    sql: `
      -- Conexão por link: o token vem da autorização do TikTok e as contas de anúncio autorizadas definem o acesso.
      -- Nesse caso NÃO existe ID de Business Center informado pelo usuário (bc_id fica vazio).
      ALTER TABLE tiktok_business_centers ALTER COLUMN bc_id DROP NOT NULL;
      ALTER TABLE tiktok_business_centers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'token' CHECK (auth_type IN ('token', 'oauth'));
      ALTER TABLE tiktok_business_centers ADD CONSTRAINT tiktok_bc_auth_coherence CHECK (auth_type = 'oauth' OR bc_id IS NOT NULL);

      -- Cada link gerado é uma "tentativa": o state (aleatório, uso único, 15 min) é guardado só como hash; o attempt_id
      -- (público para o dono) serve para a tela acompanhar o resultado sem conhecer o state.
      CREATE TABLE tiktok_oauth_attempts (
        attempt_id    TEXT        PRIMARY KEY,
        state_hash    TEXT        NOT NULL UNIQUE,
        user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT        NOT NULL,
        status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'connected', 'denied', 'error')),
        connection_id INTEGER     REFERENCES tiktok_business_centers(id) ON DELETE SET NULL,
        message       TEXT,
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_tiktok_oauth_user ON tiktok_oauth_attempts (user_id, created_at DESC);

      ${protectTables({ rls: ['tiktok_oauth_attempts'], revoke: ['tiktok_oauth_attempts'], identity: [] })}
    `,
  },
  {
    version: 4,
    description: 'Publicar a mesma campanha em várias contas de anúncio: uma publicação por (campanha, conta)',
    sql: `
      -- Uma campanha (configuração) pode ter várias publicações, uma por conta de anúncio. Cada publicação guarda os IDs
      -- criados no TikTok, o último erro e os ajustes de IDs próprios daquela conta (pixel, identidade etc.).
      CREATE TABLE campaign_publications (
        id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        campaign_id        INTEGER     NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        advertiser_id      TEXT        NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        overrides          JSONB,
        tiktok_campaign_id TEXT,
        tiktok_adgroup_id  TEXT,
        tiktok_ad_id       TEXT,
        error              TEXT,
        published_at       TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (campaign_id, advertiser_id)
      );

      -- Preserva o que já existia: a publicação única de cada campanha vira uma linha desta tabela.
      INSERT INTO campaign_publications (campaign_id, advertiser_id, tiktok_campaign_id, tiktok_adgroup_id, tiktok_ad_id, error, published_at, created_at, updated_at)
      SELECT id, advertiser_id, tiktok_campaign_id, tiktok_adgroup_id, tiktok_ad_id, publish_error, published_at, created_at, updated_at
        FROM campaigns
       WHERE advertiser_id ~ '^[0-9]{1,24}$'
         AND (tiktok_campaign_id IS NOT NULL OR tiktok_adgroup_id IS NOT NULL OR tiktok_ad_id IS NOT NULL OR publish_error IS NOT NULL);

      -- Estas colunas deixam de ser usadas (a fonte é campaign_publications). Ficam por ora para não perder dados e permitir
      -- reverter o deploy; uma migração futura pode removê-las.
      COMMENT ON COLUMN campaigns.advertiser_id      IS 'OBSOLETA: use campaign_publications';
      COMMENT ON COLUMN campaigns.tiktok_campaign_id IS 'OBSOLETA: use campaign_publications';
      COMMENT ON COLUMN campaigns.tiktok_adgroup_id  IS 'OBSOLETA: use campaign_publications';
      COMMENT ON COLUMN campaigns.tiktok_ad_id       IS 'OBSOLETA: use campaign_publications';
      COMMENT ON COLUMN campaigns.publish_error      IS 'OBSOLETA: use campaign_publications';
      COMMENT ON COLUMN campaigns.published_at       IS 'OBSOLETA: use campaign_publications';

      ${protectTables({ rls: ['campaign_publications'], revoke: ['campaign_publications'], identity: ['campaign_publications'] })}
    `,
  },
  {
    version: 5,
    description: 'Criativos limpos e únicos por campanha e conta de anúncio',
    sql: `
      -- A cada publicação, cada criativo (vídeo ou imagem) é refeito sem metadados e com os cantos levemente alterados, e essa
      -- versão ÚNICA é enviada ao TikTok. Aqui fica o ID que o TikTok deu a ela, por (campanha, criativo, conta): uma nova
      -- tentativa da MESMA campanha na MESMA conta reaproveita o envio; outra campanha ou outra conta gera outra versão.
      -- variant_sha256 é o hash do arquivo realmente enviado (auditoria: nunca coincide com o original nem com outra versão).
      CREATE TABLE campaign_creative_assets (
        campaign_id    INTEGER     NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        creative_id    INTEGER     NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
        advertiser_id  TEXT        NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        tiktok_id      TEXT        NOT NULL,
        variant_sha256 TEXT        NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (campaign_id, creative_id, advertiser_id)
      );

      COMMENT ON TABLE creative_tiktok_assets IS 'Só criativos que JÁ existiam no TikTok (referência por ID). Arquivos da biblioteca ficam em campaign_creative_assets.';

      ${protectTables({ rls: ['campaign_creative_assets'], revoke: ['campaign_creative_assets'], identity: [] })}
    `,
  },
  {
    version: 6,
    description: 'Proxies por usuário para as chamadas à API do TikTok',
    sql: `
      -- Cada usuário pode cadastrar várias proxies (HTTP, HTTPS, SOCKS4, SOCKS5) e deixar UMA ativa. Com uma proxy ativa, todas as
      -- chamadas à API do TikTok feitas com as Business Centers dele saem por ela (nunca pelo IP do servidor).
      -- Usuário e senha da proxy ficam CRIPTOGRAFADOS pela aplicação (AES-256-GCM) em auth_enc; nunca voltam ao navegador.
      CREATE TABLE proxies (
        id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name              TEXT        NOT NULL,
        kind              TEXT        NOT NULL CHECK (kind IN ('http', 'https', 'socks4', 'socks5')),
        host              TEXT        NOT NULL,
        port              INTEGER     NOT NULL CHECK (port BETWEEN 1 AND 65535),
        auth_enc          TEXT,
        active            BOOLEAN     NOT NULL DEFAULT false,
        last_test_at      TIMESTAMPTZ,
        last_test_ok      BOOLEAN,
        last_test_ip      TEXT,
        last_test_country TEXT,
        last_test_error   TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- No máximo UMA proxy ativa por usuário (o banco garante, mesmo com requisições simultâneas).
      CREATE UNIQUE INDEX proxies_one_active_per_user ON proxies (user_id) WHERE active;
      CREATE UNIQUE INDEX proxies_user_name_key ON proxies (user_id, lower(name));

      ${protectTables({ rls: ['proxies'], revoke: ['proxies'], identity: ['proxies'] })}
    `,
  },
  {
    version: 7,
    description: 'ID da Business Center dona de cada conta de anúncio (conexões por link não informam o ID da BC)',
    sql: `
      -- O TikTok devolve na conta de anúncio a Business Center dona dela (owner_bc_id). Guardamos por conta: uma autorização por
      -- link pode trazer contas de BCs diferentes, e é daí que a tela mostra o ID da BC de uma conexão por link.
      ALTER TABLE tiktok_advertisers ADD COLUMN owner_bc_id TEXT CHECK (owner_bc_id IS NULL OR owner_bc_id ~ '^[0-9]{1,24}$');
    `,
  },
  {
    version: 8,
    description: 'Etiqueta nas contas de anúncio (ex.: conta de agência)',
    sql: `
      -- NULL = conta comum. A etiqueta é do usuário (não vem do TikTok) e sobrevive às sincronizações.
      -- Novas etiquetas entram aqui com uma migração que troca a restrição.
      ALTER TABLE tiktok_advertisers ADD COLUMN label TEXT CHECK (label IS NULL OR label IN ('agency'));
    `,
  },
  {
    version: 9,
    description: 'Colaboradores: acesso ao espaço de outra conta por área, e convites por e-mail',
    sql: `
      -- Um colaborador tem a PRÓPRIA conta (e-mail e senha) e trabalha dentro do espaço (dados) do dono, só nas áreas liberadas.
      -- Uma pessoa é colaboradora de UM dono (UNIQUE em user_id). Remover o colaborador apaga a conta dele (cascata) e as sessões.
      -- Novas áreas entram aqui com uma migração que troca a restrição (a lista também existe em shared/permissions.js).
      CREATE TABLE workspace_members (
        id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id    INTEGER     NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        areas      TEXT[]      NOT NULL CHECK (cardinality(areas) BETWEEN 1 AND 4 AND areas <@ ARRAY['creatives', 'campaigns', 'reports', 'accounts']::text[]),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (owner_id <> user_id)
      );
      CREATE INDEX idx_workspace_members_owner ON workspace_members (owner_id);

      -- Convites pendentes. O token só existe no e-mail; aqui fica o hash SHA-256. Uso único (a linha é apagada ao aceitar).
      CREATE TABLE workspace_invites (
        id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email      TEXT        NOT NULL,
        name       TEXT        NOT NULL,
        areas      TEXT[]      NOT NULL CHECK (cardinality(areas) BETWEEN 1 AND 4 AND areas <@ ARRAY['creatives', 'campaigns', 'reports', 'accounts']::text[]),
        token_hash TEXT        NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX workspace_invites_owner_email_key ON workspace_invites (owner_id, lower(email));

      ${protectTables({ rls: ['workspace_members', 'workspace_invites'], revoke: ['workspace_members', 'workspace_invites'], identity: ['workspace_members', 'workspace_invites'] })}
    `,
  },
  {
    version: 10,
    description: 'Foto de perfil dos usuários',
    sql: `
      -- Uma foto por usuário, em tabela própria (a linha de users continua leve e a foto nunca vai junto em consultas de sessão).
      -- O servidor sempre grava JPEG 256x256 recodificado (sem metadados); o banco ainda limita o tipo e o tamanho (200 KB).
      CREATE TABLE user_avatars (
        user_id    INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        mime       TEXT        NOT NULL DEFAULT 'image/jpeg' CHECK (mime = 'image/jpeg'),
        data       BYTEA       NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 204800),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ${protectTables({ rls: ['user_avatars'], revoke: ['user_avatars'], identity: [] })}
    `,
  },
  {
    version: 11,
    description: 'Arquivos anexados da conta (ex.: logins), criptografados',
    sql: `
      -- Arquivos que o dono da conta e seus colaboradores (com acesso a Contas TikTok) compartilham. O conteúdo é GRAVADO
      -- CRIPTOGRAFADO pela aplicação (AES-256-GCM, chave TOKEN_ENCRYPTION_KEY): nem o banco nem um backup mostram o arquivo.
      -- Apagar o dono apaga os arquivos (cascata); apagar quem enviou só limpa o "enviado por".
      CREATE TABLE workspace_files (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploaded_by INTEGER              REFERENCES users(id) ON DELETE SET NULL,
        name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
        ext         TEXT        NOT NULL CHECK (ext IN ('txt', 'csv', 'log', 'md', 'pdf', 'png', 'jpg', 'docx', 'xlsx')),
        size        INTEGER     NOT NULL CHECK (size BETWEEN 1 AND 5242880),
        data        BYTEA       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_workspace_files_owner ON workspace_files (owner_id, created_at DESC);

      ${protectTables({ rls: ['workspace_files'], revoke: ['workspace_files'], identity: ['workspace_files'] })}
    `,
  },
  {
    version: 12,
    description: 'Gasto por hora das contas de anúncio (coletado do TikTok a cada 30 minutos)',
    sql: `
      -- Uma linha por conta de anúncio e por HORA (em UTC; o TikTok informa a hora no fuso da conta e o servidor converte).
      -- A coleta repete a hora atual a cada 30 minutos (upsert), então a linha sempre guarda o último valor conhecido.
      -- Apagar a conexão (Business Center) apaga o histórico dela (cascata). A moeda é a da conta na hora da coleta.
      CREATE TABLE tiktok_hourly_spend (
        business_center_id INTEGER       NOT NULL REFERENCES tiktok_business_centers(id) ON DELETE CASCADE,
        advertiser_id      TEXT          NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        hour_start         TIMESTAMPTZ   NOT NULL,
        currency           TEXT          CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
        spend              NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (spend >= 0),
        impressions        BIGINT        NOT NULL DEFAULT 0 CHECK (impressions >= 0),
        clicks             BIGINT        NOT NULL DEFAULT 0 CHECK (clicks >= 0),
        conversions        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (conversions >= 0),
        fetched_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
        PRIMARY KEY (business_center_id, advertiser_id, hour_start)
      );
      CREATE INDEX idx_tiktok_hourly_spend_hour ON tiktok_hourly_spend (hour_start);

      ${protectTables({ rls: ['tiktok_hourly_spend'], revoke: ['tiktok_hourly_spend'], identity: [] })}
    `,
  },
  {
    version: 13,
    description: 'Hook com IA (Kling): pedidos de hook de 2 a 3 segundos e marca "gerado por IA" nos criativos',
    sql: `
      -- Criativos que contêm trecho gerado por IA ficam marcados (a tela mostra "IA" e lembra de usar a divulgação do TikTok).
      ALTER TABLE creatives ADD COLUMN ai_generated BOOLEAN NOT NULL DEFAULT false;

      -- Um pedido = um hook (uma tarefa na Kling). O arquivo gerado fica na pasta privada de criativos (storage_key) até a pessoa
      -- aplicá-lo a um vídeo ou descartá-lo. Apagar o usuário apaga os pedidos; apagar o criativo resultante só limpa o vínculo.
      CREATE TABLE creative_hooks (
        id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        style         TEXT        NOT NULL CHECK (char_length(style) BETWEEN 1 AND 40),
        idea          TEXT        CHECK (idea IS NULL OR char_length(idea) <= 300),
        duration_ms   INTEGER     NOT NULL CHECK (duration_ms IN (2000, 2500, 3000)),
        status        TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'generating', 'processing', 'ready', 'failed')),
        attempts      INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        kling_task_id TEXT        CHECK (kling_task_id IS NULL OR kling_task_id ~ '^[A-Za-z0-9_-]{1,100}$'),
        error_code    TEXT        CHECK (error_code IS NULL OR char_length(error_code) <= 40),
        error_message TEXT        CHECK (error_message IS NULL OR char_length(error_message) <= 300),
        storage_key   TEXT,
        size_bytes    BIGINT      CHECK (size_bytes IS NULL OR size_bytes >= 0),
        apply_status  TEXT        CHECK (apply_status IS NULL OR apply_status IN ('running', 'failed')),
        apply_error   TEXT        CHECK (apply_error IS NULL OR char_length(apply_error) <= 300),
        creative_id   INTEGER     REFERENCES creatives(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        submitted_at  TIMESTAMPTZ,
        ready_at      TIMESTAMPTZ,
        CHECK (status <> 'ready' OR storage_key IS NOT NULL)
      );
      CREATE INDEX idx_creative_hooks_user ON creative_hooks (user_id, created_at DESC, id DESC);
      CREATE INDEX idx_creative_hooks_active ON creative_hooks (status) WHERE status IN ('queued', 'generating', 'processing');

      ${protectTables({ rls: ['creative_hooks'], revoke: ['creative_hooks'], identity: ['creative_hooks'] })}
    `,
  },
  {
    version: 14,
    description: 'Pastas da biblioteca de criativos (organizar por oferta)',
    sql: `
      -- Uma pasta por oferta (um nível só). O nome é único por usuário, sem diferenciar maiúsculas de minúsculas.
      -- Apagar a pasta NÃO apaga criativos: eles voltam para "sem pasta" (ON DELETE SET NULL). Apagar o usuário apaga as pastas dele.
      CREATE TABLE creative_folders (
        id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX creative_folders_user_name_key ON creative_folders (user_id, lower(name));

      ALTER TABLE creatives ADD COLUMN folder_id INTEGER REFERENCES creative_folders(id) ON DELETE SET NULL;
      CREATE INDEX idx_creatives_folder ON creatives (user_id, folder_id, created_at DESC, id DESC);

      ${protectTables({ rls: ['creative_folders'], revoke: ['creative_folders'], identity: ['creative_folders'] })}
    `,
  },
  {
    version: 15,
    description: 'Gerenciador de anúncios: visualizações salvas (colunas, ordem, filtros) de cada pessoa',
    sql: `
      -- Cada PESSOA guarda as próprias visualizações (colunas na ordem escolhida, ordenação, filtros e período). A configuração é validada
      -- pela aplicação (só campos conhecidos) e limitada em tamanho; uma visualização por pessoa pode ser a padrão.
      CREATE TABLE manager_views (
        id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
        config     JSONB       NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 4000),
        is_default BOOLEAN     NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX manager_views_user_name_key ON manager_views (user_id, lower(name));
      CREATE UNIQUE INDEX manager_views_one_default ON manager_views (user_id) WHERE is_default;

      ${protectTables({ rls: ['manager_views'], revoke: ['manager_views'], identity: ['manager_views'] })}
    `,
  },
  {
    version: 16,
    description: 'Hook com IA: a junção ao vídeo sobrevive a reinício do servidor (guarda o vídeo escolhido e o nome do resultado)',
    sql: `
      -- Ao pedir a junção, o servidor guarda qual vídeo e qual nome; se reiniciar no meio (ex.: atualização), retoma de onde parou em vez de
      -- falhar. As tentativas de retomada são contadas para um problema que derruba o servidor não ficar se repetindo para sempre.
      ALTER TABLE creative_hooks
        ADD COLUMN apply_creative_id INTEGER REFERENCES creatives(id) ON DELETE SET NULL,
        ADD COLUMN apply_name        TEXT    CHECK (apply_name IS NULL OR char_length(apply_name) BETWEEN 1 AND 100),
        ADD COLUMN apply_with_video  BOOLEAN NOT NULL DEFAULT false,  -- a junção era com um vídeo (se ele for apagado, apply_creative_id vira NULL e a retomada avisa em vez de só guardar o hook)
        ADD COLUMN apply_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (apply_attempts >= 0);
    `,
  },
  {
    version: 17,
    description: 'Catálogo: anúncio padrão por catálogo (criativos da biblioteca, produtos, texto, botão, URL…) que a campanha já puxa pronto',
    sql: `
      -- Um "anúncio padrão" por pessoa e catálogo. A configuração (campos permitidos da campanha de catálogo, validados pela aplicação com as mesmas
      -- regras do assistente) fica em JSONB; os dois criativos da biblioteca ficam em colunas com chave estrangeira: apagar o criativo só limpa o vínculo.
      CREATE TABLE catalog_defaults (
        id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bc_id             TEXT        NOT NULL CHECK (bc_id ~ '^[0-9]{1,24}$'),
        catalog_id        TEXT        NOT NULL CHECK (catalog_id ~ '^[0-9]{1,24}$'),
        config            JSONB       NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 8000),
        video_creative_id INTEGER     REFERENCES creatives(id) ON DELETE SET NULL,
        cover_creative_id INTEGER     REFERENCES creatives(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, bc_id, catalog_id)
      );

      ${protectTables({ rls: ['catalog_defaults'], revoke: ['catalog_defaults'], identity: ['catalog_defaults'] })}
    `,
  },
  {
    version: 18,
    description: 'Saldo: registro de cada transferência de dinheiro entre a Business Center e a conta de anúncio (auditoria + proteção contra repetição)',
    sql: `
      -- Cada pedido de transferência vira UMA linha ANTES de falar com o TikTok ("pending") e é fechada com o resultado. A chave única
      -- (pessoa, operação) impede que um clique repetido, um reenvio ou uma nova tentativa mova o dinheiro duas vezes. "unknown" = o TikTok
      -- não respondeu (rede/tempo esgotado): o dinheiro PODE ter se movido, e a tela manda conferir o saldo. A linha nunca é apagada
      -- junto com a conexão (connection_id vira NULL): é o histórico financeiro.
      CREATE TABLE balance_transfers (
        id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id         INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id   INTEGER       REFERENCES tiktok_business_centers(id) ON DELETE SET NULL,
        bc_id           TEXT          NOT NULL CHECK (bc_id ~ '^[0-9]{1,24}$'),
        advertiser_id   TEXT          NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        advertiser_name TEXT          CHECK (advertiser_name IS NULL OR char_length(advertiser_name) <= 120),
        direction       TEXT          NOT NULL CHECK (direction IN ('RECHARGE', 'REFUND')),
        amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000),
        currency        TEXT          CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
        operation_id    TEXT          NOT NULL CHECK (operation_id ~ '^[0-9a-f]{32}$'),
        status          TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'unknown')),
        transaction_ids TEXT          CHECK (transaction_ids IS NULL OR char_length(transaction_ids) <= 300),
        error_message   TEXT          CHECK (error_message IS NULL OR char_length(error_message) <= 300),
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
        finished_at     TIMESTAMPTZ,
        UNIQUE (user_id, operation_id)
      );
      CREATE INDEX idx_balance_transfers_user ON balance_transfers (user_id, created_at DESC);

      ${protectTables({ rls: ['balance_transfers'], revoke: ['balance_transfers'], identity: ['balance_transfers'] })}
    `,
  },
  {
    version: 19,
    description: 'Administração: acesso do admin à conta de um usuário (sessão marcada, somente leitura) e registro de auditoria das ações do admin',
    sql: `
      -- Sessão aberta pelo admin "como" outra pessoa: guarda QUEM é o admin. A sessão nasce e morre junto com o admin (se ele deixar de ser
      -- admin aprovado a sessão deixa de valer) e sempre tem prazo curto; a aplicação a trata como somente leitura.
      ALTER TABLE sessions ADD COLUMN impersonator_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      CREATE INDEX idx_sessions_impersonator ON sessions (impersonator_id) WHERE impersonator_id IS NOT NULL;

      -- Registro do que o admin fez (entrar na conta de alguém, aprovar, rejeitar, bloquear, reativar). Só acrescenta linhas: a aplicação nunca
      -- altera nem apaga. Se uma conta for excluída, a linha continua (a referência vira nula) e o nome fica no texto do detalhe.
      CREATE TABLE admin_audit_log (
        id         INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        admin_id   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        target_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        action     TEXT        NOT NULL CHECK (action IN ('impersonation_start', 'impersonation_end', 'status_change')),
        detail     TEXT        CHECK (detail IS NULL OR char_length(detail) <= 200),
        ip         TEXT        CHECK (ip IS NULL OR char_length(ip) <= 64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_admin_audit_created ON admin_audit_log (created_at DESC, id DESC);

      ${protectTables({ rls: ['admin_audit_log'], revoke: ['admin_audit_log'], identity: ['admin_audit_log'] })}
    `,
  },
  {
    version: 20,
    description: 'Notificações: o sino do topo (avisos enviados pelo admin para todos ou para uma pessoa) e quem já leu cada uma',
    sql: `
      -- Uma notificação é do admin para TODOS ('all') ou para UMA pessoa ('user', com target_user_id). Vale enquanto estiver ativa e dentro da validade.
      -- O link só pode ser um caminho interno do sistema (nada de sites externos). Apagar a pessoa apaga as notificações dela e as leituras.
      CREATE TABLE notifications (
        id             INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        title          TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
        body           TEXT        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 600),
        level          TEXT        NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warning', 'danger')),
        link           TEXT        CHECK (link IS NULL OR (char_length(link) <= 100 AND link ~ '^/[a-z0-9_/-]*$' AND link !~ '^//')),
        audience       TEXT        NOT NULL CHECK (audience IN ('all', 'user')),
        target_user_id INTEGER     REFERENCES users(id) ON DELETE CASCADE,
        active         BOOLEAN     NOT NULL DEFAULT true,
        expires_at     TIMESTAMPTZ,
        created_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK ((audience = 'all' AND target_user_id IS NULL) OR (audience = 'user' AND target_user_id IS NOT NULL))
      );
      CREATE INDEX idx_notifications_created ON notifications (created_at DESC, id DESC);
      CREATE INDEX idx_notifications_target ON notifications (target_user_id) WHERE target_user_id IS NOT NULL;

      -- Cada pessoa guarda a própria leitura (a de uma não muda a da outra).
      CREATE TABLE notification_reads (
        notification_id INTEGER     NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (notification_id, user_id)
      );
      CREATE INDEX idx_notification_reads_user ON notification_reads (user_id);

      -- O registro de auditoria do admin passa a aceitar também o envio e a alteração de notificações.
      ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_action_check;
      ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
        CHECK (action IN ('impersonation_start', 'impersonation_end', 'status_change', 'notification_send', 'notification_change'));

      ${protectTables({ rls: ['notifications', 'notification_reads'], revoke: ['notifications', 'notification_reads'], identity: ['notifications'] })}
    `,
  },
  {
    version: 21,
    description: 'Assinaturas (tudo em dólar): plano de cada pessoa, gasto guardado para sempre, fechamentos mensais, pagamentos e bloqueio de BC com débito',
    sql: `
      -- Plano de cada pessoa (negociável): mensalidade em CENTAVOS de dólar + percentual do gasto em pontos-base (1 = 0,01%). Cada linha vale a partir de
      -- um mês (sempre dia 1); o plano de um mês é a linha mais recente com início até aquele mês. Mudar o plano de um mês já existente substitui a linha.
      CREATE TABLE billing_plans (
        id                INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        monthly_fee_cents INTEGER     NOT NULL CHECK (monthly_fee_cents BETWEEN 0 AND 1000000),
        percent_bp        INTEGER     NOT NULL CHECK (percent_bp BETWEEN 0 AND 10000),
        effective_month   DATE        NOT NULL CHECK (EXTRACT(DAY FROM effective_month) = 1),
        note              TEXT        CHECK (note IS NULL OR char_length(note) <= 200),
        created_by        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, effective_month)
      );

      -- Gasto por hora de cada conta de anúncio, POR DONO. NÃO tem ligação com a conexão da Business Center: remover a BC não apaga nada daqui, e a
      -- pessoa não consegue "zerar" o que gastou. O valor de uma hora só sobe (o TikTok ajusta, mas apagar anúncios não pode diminuir a cobrança).
      -- A pessoa dona não pode ser excluída enquanto houver histórico (RESTRICT).
      CREATE TABLE spend_ledger (
        owner_id      INTEGER       NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        advertiser_id TEXT          NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        hour_start    TIMESTAMPTZ   NOT NULL,
        currency      TEXT          NOT NULL DEFAULT 'UNKNOWN' CHECK (currency ~ '^[A-Z]{3}$' OR currency = 'UNKNOWN'),
        spend         NUMERIC(16,4) NOT NULL CHECK (spend >= 0),
        updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, advertiser_id, hour_start)
      );
      CREATE INDEX idx_spend_ledger_owner_hour ON spend_ledger (owner_id, hour_start);

      -- Fechamento de cada mês (uma vez só): guarda o plano e as cotações daquele momento, para mudanças futuras não alterarem o passado.
      CREATE TABLE billing_statements (
        id                INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period            DATE        NOT NULL CHECK (EXTRACT(DAY FROM period) = 1),
        monthly_fee_cents INTEGER     NOT NULL CHECK (monthly_fee_cents >= 0),
        percent_bp        INTEGER     NOT NULL CHECK (percent_bp BETWEEN 0 AND 10000),
        spend_cents       BIGINT      NOT NULL CHECK (spend_cents >= 0),
        percent_fee_cents BIGINT      NOT NULL CHECK (percent_fee_cents >= 0),
        total_cents       BIGINT      NOT NULL CHECK (total_cents >= 0),
        unconverted       JSONB       NOT NULL DEFAULT '[]'::jsonb,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, period)
      );

      -- Pagamentos recebidos (registrados pelo admin). Só acrescenta; o saldo devedor = tudo que foi cobrado menos tudo que foi pago.
      CREATE TABLE billing_payments (
        id            INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_cents  BIGINT      NOT NULL CHECK (amount_cents > 0),
        paid_at       DATE        NOT NULL DEFAULT CURRENT_DATE,
        note          TEXT        CHECK (note IS NULL OR char_length(note) <= 200),
        registered_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_billing_payments_user ON billing_payments (user_id, paid_at DESC, id DESC);

      -- Bloqueio de Business Center / conta de anúncio: criado quando a pessoa REMOVE a BC com débito. Enquanto a dona devedora tiver débito, ninguém
      -- mais (só ela mesma) consegue conectar a mesma BC ou as mesmas contas. Cai sozinho quando a dívida zera, quando a dona reconecta ou por liberação do admin.
      CREATE TABLE billing_locks (
        id             INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind           TEXT        NOT NULL CHECK (kind IN ('bc', 'advertiser')),
        value          TEXT        NOT NULL CHECK (value ~ '^[0-9]{1,24}$'),
        debt_cents     BIGINT      NOT NULL CHECK (debt_cents >= 0),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        released_at    TIMESTAMPTZ,
        released_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        release_reason TEXT        CHECK (release_reason IS NULL OR release_reason IN ('paid', 'owner_reconnected', 'admin')),
        CHECK ((released_at IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND release_reason IS NOT NULL))
      );
      CREATE UNIQUE INDEX billing_locks_active_key ON billing_locks (owner_id, kind, value) WHERE released_at IS NULL;
      CREATE INDEX idx_billing_locks_value ON billing_locks (kind, value) WHERE released_at IS NULL;

      -- Cotação para converter gasto de contas em outra moeda para dólar (só moeda estrangeira; o dólar vale 1).
      CREATE TABLE billing_rates (
        currency     TEXT          PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'USD'),
        usd_per_unit NUMERIC(14,6) NOT NULL CHECK (usd_per_unit > 0),
        updated_by   INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
      );

      ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_action_check;
      ALTER TABLE admin_audit_log ADD CONSTRAINT admin_audit_log_action_check
        CHECK (action IN ('impersonation_start', 'impersonation_end', 'status_change', 'notification_send', 'notification_change',
                          'billing_plan', 'billing_payment', 'billing_lock_release', 'billing_rate'));

      ${protectTables({
        rls: ['billing_plans', 'spend_ledger', 'billing_statements', 'billing_payments', 'billing_locks', 'billing_rates'],
        revoke: ['billing_plans', 'spend_ledger', 'billing_statements', 'billing_payments', 'billing_locks', 'billing_rates'],
        identity: ['billing_plans', 'billing_statements', 'billing_payments', 'billing_locks'],
      })}
    `,
  },
  {
    version: 22,
    description: 'Assistente: histórico da situação das contas de anúncio (conta caiu, foi punida, encerrada) observado a cada coleta',
    sql: `
      -- Situação mais recente de cada conta de anúncio (por dono) e, a cada MUDANÇA observada, uma linha de evento. A coleta roda a cada 30 min, então
      -- "caiu hoje" é o que foi visto mudar desde que o monitoramento começou. O status é o do TikTok (STATUS_ENABLE, STATUS_LIMIT…).
      CREATE TABLE advertiser_status (
        owner_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        advertiser_id TEXT        NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        name          TEXT        NOT NULL CHECK (char_length(name) <= 120),
        status        TEXT        NOT NULL CHECK (status ~ '^STATUS_[A-Z_]{2,60}$'),
        since         TIMESTAMPTZ NOT NULL DEFAULT now(),
        checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, advertiser_id)
      );
      CREATE TABLE advertiser_status_events (
        id              INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        advertiser_id   TEXT        NOT NULL CHECK (advertiser_id ~ '^[0-9]{1,24}$'),
        name            TEXT        NOT NULL CHECK (char_length(name) <= 120),
        previous_status TEXT        CHECK (previous_status IS NULL OR previous_status ~ '^STATUS_[A-Z_]{2,60}$'),
        status          TEXT        NOT NULL CHECK (status ~ '^STATUS_[A-Z_]{2,60}$'),
        observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_advertiser_status_events_owner ON advertiser_status_events (owner_id, observed_at DESC);

      ${protectTables({ rls: ['advertiser_status', 'advertiser_status_events'], revoke: ['advertiser_status', 'advertiser_status_events'], identity: ['advertiser_status_events'] })}
    `,
  },
  {
    version: 23,
    description: 'Cadastro: verificação do e-mail por código de 6 dígitos antes de criar a conta',
    sql: `
      -- Cadastro em andamento: guarda o que a pessoa preencheu (a senha já em hash) e o HASH do código enviado por e-mail. A conta só é criada quando o código
      -- confere. O "ticket" (segredo que fica só no navegador de quem se cadastrou) liga o código ao cadastro certo: ninguém consegue trocar os dados do cadastro
      -- de outra pessoa. O código vale 10 minutos e erra no máximo 5 vezes; linhas vencidas são apagadas.
      CREATE TABLE registration_codes (
        ticket_hash   TEXT        PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
        email         TEXT        NOT NULL CHECK (char_length(email) <= 254),
        name          TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
        company       TEXT        CHECK (company IS NULL OR char_length(company) <= 200),
        password_hash TEXT        NOT NULL,
        code_hash     TEXT        NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
        attempts      INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        sends         INTEGER     NOT NULL DEFAULT 1 CHECK (sends >= 1),
        last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_registration_codes_email ON registration_codes (lower(email));
      CREATE INDEX idx_registration_codes_expires ON registration_codes (expires_at);

      ${protectTables({ rls: ['registration_codes'], revoke: ['registration_codes'], identity: [] })}
    `,
  },
  {
    version: 24,
    description: 'Catálogo: catálogos que a pessoa ocultou da própria lista (só visual, por pessoa)',
    sql: `
      -- "Apagar" um catálogo da lista é só VISUAL: o catálogo continua no TikTok e para as outras pessoas. Cada linha é um catálogo oculto por uma pessoa;
      -- apagar a pessoa apaga as linhas dela. O ID do catálogo é único no TikTok, por isso (pessoa, catálogo) basta como chave.
      CREATE TABLE catalog_hidden (
        user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        catalog_id TEXT        NOT NULL CHECK (catalog_id ~ '^[0-9]{1,24}$'),
        bc_id      TEXT        NOT NULL CHECK (bc_id ~ '^[0-9]{1,24}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, catalog_id)
      );

      ${protectTables({ rls: ['catalog_hidden'], revoke: ['catalog_hidden'], identity: [] })}
    `,
  },
  {
    version: 25,
    description: 'Registro de atividades da equipe (quem fez o quê e quando); só se acrescenta, nunca se altera',
    sql: `
      -- Cada linha é uma ação feita dentro do espaço de trabalho de um dono (workspace_id). O nome de quem fez fica COPIADO na linha: se o colaborador for
      -- removido (a conta dele é apagada), o registro continua mostrando quem foi (actor_id vira nulo). Os detalhes são só os campos permitidos pela aplicação
      -- (nunca token, senha nem textos longos). O código só INSERE e LÊ: não há rota para alterar uma linha (apenas a limpeza dos registros com mais de um ano).
      CREATE TABLE workspace_activity (
        id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        workspace_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_id       INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        actor_name     TEXT        NOT NULL CHECK (char_length(actor_name) BETWEEN 1 AND 200),
        actor_is_owner BOOLEAN     NOT NULL,
        action         TEXT        NOT NULL CHECK (action ~ '^[a-z_]+[.][a-z_]+$' AND char_length(action) <= 40),
        target_name    TEXT        CHECK (target_name IS NULL OR char_length(target_name) <= 200),
        details        JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 4000),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_workspace_activity_feed ON workspace_activity (workspace_id, created_at DESC, id DESC);
      CREATE INDEX idx_workspace_activity_actor ON workspace_activity (workspace_id, actor_id, created_at DESC);

      ${protectTables({ rls: ['workspace_activity'], revoke: ['workspace_activity'], identity: ['workspace_activity'] })}
    `,
  },
  {
    version: 26,
    description: 'Automação: configurações de campanha "one-click" (modelos reutilizáveis que publicam em várias contas)',
    sql: `
      -- Um modelo é uma configuração COMPLETA de campanha (campanha, grupo e anúncio) com um nome dado pela pessoa ("Campanha para o Brasil"). Publicar um modelo cria uma
      -- campanha nova (uma cópia) e a publica nas contas escolhidas; o modelo em si nunca é gasto, então serve para quantas publicações a pessoa quiser.
      -- Pertence ao dono do espaço de trabalho; apagar o dono apaga os modelos. O nome é único por dono, sem diferenciar maiúsculas.
      CREATE TABLE campaign_templates (
        id         INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        owner_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
        objective  TEXT        NOT NULL CHECK (char_length(objective) BETWEEN 1 AND 40),
        config     JSONB       NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 100000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_campaign_templates_owner_name ON campaign_templates (owner_id, lower(name));

      ${protectTables({ rls: ['campaign_templates'], revoke: ['campaign_templates'], identity: ['campaign_templates'] })}
    `,
  },
];

const MIGRATION_LOCK_KEY = 727_001; // chave da trava de migração (advisory lock)

/** Aplica as migrações pendentes. Segura para várias instâncias subindo ao mesmo tempo. */
export async function runMigrations(db, migrations = MIGRATIONS) {
  try {
    await db.transaction(async (tx) => {
      // Trava de escopo da transação: funciona também atrás do pooler em modo "transaction".
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER     PRIMARY KEY,
        description TEXT        NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await tx.exec('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
      const { rows } = await tx.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));
      for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
        if (applied.has(migration.version)) continue;
        await tx.exec(migration.sql);
        await tx.query('INSERT INTO schema_migrations (version, description) VALUES ($1, $2)', [migration.version, migration.description]);
      }
    });
  } catch (err) {
    throw new Error(`Falha ao aplicar as migrações do banco: ${err.message}`, { cause: err });
  }
}

/**
 * Lista as tabelas do app SEM RLS: as do schema atual cujo dono é o usuário da conexão (ou seja, criadas por este sistema).
 * Toda tabela nova precisa ligar a RLS (veja o aviso acima); esta checagem impede que um esquecimento exponha dados
 * pela API REST do Supabase. Tabelas de outros donos/schemas (outro sistema no mesmo banco) não são da conta deste app.
 */
export async function findTablesWithoutRls(db) {
  const { rows } = await db.query(
    `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind IN ('r', 'p')
        AND NOT c.relrowsecurity
        AND pg_get_userbyid(c.relowner) = current_user
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.table_name);
}
