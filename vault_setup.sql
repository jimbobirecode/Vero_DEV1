-- Run once in the Supabase SQL editor (or as a migration) before using the
-- Settings screen's Save button for real. Vault itself is enabled by default
-- on new Supabase projects; this just adds a callable wrapper around it.

create or replace function create_vault_secret(secret_value text, secret_name text)
returns uuid
language plpgsql
security definer
as $$
declare
  new_id uuid;
begin
  select id into new_id from vault.create_secret(secret_value, secret_name);
  return new_id;
end;
$$;

-- security definer lets this function write to vault.secrets even when called
-- via the service role from the Render backend. Lock down execution to the
-- service role only — nothing else should ever call this.
revoke all on function create_vault_secret(text, text) from public;
grant execute on function create_vault_secret(text, text) to service_role;
