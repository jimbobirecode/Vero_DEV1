// Supabase Vault helpers. Vault is a Postgres extension enabled on the
// Supabase project itself — it works exactly the same whether the calling
// backend runs on Supabase Edge Functions or, as here, a Node app on Render.
// The one-time SQL to create the `create_vault_secret` helper function lives
// in save_integrations.js below.
const { supabase } = require("./supabase");

async function createSecret(value, name) {
  const { data, error } = await supabase.rpc("create_vault_secret", {
    secret_value: value,
    secret_name: name,
  });
  if (error) throw error;
  return data; // uuid
}

async function readSecret(secretId) {
  if (!secretId) return null;
  const { data, error } = await supabase
    .from("vault.decrypted_secrets")
    .select("decrypted_secret")
    .eq("id", secretId)
    .maybeSingle();
  if (error) throw error;
  return data?.decrypted_secret ?? null;
}

module.exports = { createSecret, readSecret };
