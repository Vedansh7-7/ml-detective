// Public backend settings. The publishable key is meant to ship in the
// browser: row-level security and the `game` function decide what it can do.
export const SUPABASE_URL = "https://rgajverfecjsmjaqjgvf.supabase.co";
export const SUPABASE_KEY = "sb_publishable_RKZoZaXV-uEZ3SNAvcAnSA_CiIR3YnM";

// Cloudflare Turnstile (bot check before any sign-in). The site key is public;
// its secret lives only in Supabase Auth settings. Empty string = off.
export const TURNSTILE_SITE_KEY = "0x4AAAAAAFGnswSNkS46cEOH";
