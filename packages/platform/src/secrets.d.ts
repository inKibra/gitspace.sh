/**
 * Secrets are not in wrangler.jsonc, so `wrangler types` cannot emit them.
 * Merged into the generated base so both `Env` and `Cloudflare.Env` carry it.
 * Set with `wrangler secret put CF_API_TOKEN` (Workers Scripts Write on CF_ACCOUNT_ID).
 */
interface __BaseEnv_Env {
  CF_API_TOKEN: string;
}
