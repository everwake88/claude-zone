-- LOCAL TESTS ONLY. A stand-in for Supabase Vault with the same functions
-- and view, so the migrations and tests run on plain Postgres. It does NOT
-- encrypt — real Supabase projects have the real Vault, and this file is
-- never run there (it does nothing where a vault schema already exists).
do $$
begin
  if to_regnamespace('vault') is null then
    create schema vault;
    create table vault.secrets (
      id uuid primary key default gen_random_uuid(), name text unique, description text not null default '',
      secret text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create view vault.decrypted_secrets as
      select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
    create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
    returns uuid language sql as 'insert into vault.secrets (secret, name, description) values (new_secret, new_name, coalesce(new_description, '''')) returning id';
    create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
                                        new_description text default null, new_key_id uuid default null)
    returns void language sql as 'update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name), updated_at = now() where id = secret_id';
  end if;
end $$;
