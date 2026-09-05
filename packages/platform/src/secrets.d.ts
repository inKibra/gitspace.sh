/**
 * Secrets are not in wrangler.jsonc, so `wrangler types` cannot emit them.
 * Merged into the generated base so both `Env` and `Cloudflare.Env` carry it.
 * Set with `wrangler secret put CF_API_TOKEN` and
 * `wrangler secret put PLATFORM_BOOTSTRAP_TOKEN`.
 */
interface __BaseEnv_Env {
  CF_API_TOKEN: string;
  PLATFORM_BOOTSTRAP_TOKEN: string;
}
