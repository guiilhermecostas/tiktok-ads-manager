-- Preparação do banco no Supabase (executar UMA vez, como administrador, no SQL Editor do painel).
-- Cria um papel dedicado e um schema próprio para o sistema. As tabelas são criadas depois pelo próprio sistema
-- (npm run db:migrate), já com RLS ligado e sem nenhum privilégio para anon / authenticated / service_role.
--
-- Por que um papel e um schema próprios (e não o `postgres` / `public`):
--   * menor privilégio: o sistema não é superusuário nem alcança tabelas de outros sistemas do mesmo projeto;
--   * o schema `tiktok_ads` NÃO é exposto pela API REST do Supabase (só `public` e `graphql_public` são);
--   * nada do que já existe no schema `public` é tocado.
--
-- 1) Troque SENHA_FORTE_AQUI por uma senha longa e aleatória (ex.: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))").
-- 2) Rode este arquivo.
-- 3) No .env: DATABASE_URL=postgresql://tiktok_ads_app.<REF_DO_PROJETO>:<SENHA>@<host-do-pooler>:5432/postgres
--             DATABASE_SCHEMA=tiktok_ads
--             DATABASE_SSL_CA_PATH=certs/supabase-ca.crt
--    (host do pooler: Project Settings -> Database -> Connection string -> "Session pooler")

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiktok_ads_app') THEN
    CREATE ROLE tiktok_ads_app LOGIN PASSWORD 'SENHA_FORTE_AQUI'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20;
  ELSE
    ALTER ROLE tiktok_ads_app WITH LOGIN PASSWORD 'SENHA_FORTE_AQUI'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS tiktok_ads;
GRANT USAGE, CREATE ON SCHEMA tiktok_ads TO tiktok_ads_app;

-- Fixa o schema no nível do papel: vale em qualquer pooler (sessão ou transação).
ALTER ROLE tiktok_ads_app SET search_path = tiktok_ads;
