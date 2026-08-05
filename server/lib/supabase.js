// Shared Supabase client. On Render, this talks to Supabase over the network
// like any other client — Supabase doesn't need to host the backend for its
// Postgres (or Vault, which is just a Postgres extension) to work.
const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

// Service-role key — this backend runs entirely server-side on Render, never
// in a browser, so it's safe to hold a key that bypasses Row Level Security.
// Never send this key to the dashboard or embed it in any client-side code.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = { supabase };
