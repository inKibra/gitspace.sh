interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  GITSPACE_DEV_BOOTSTRAP_TOKEN?: string;
  /** Operator-only HMAC signing secret; children receive machine/generation-bound broker bearers. */
  GITSPACE_OMP_BROKER_TOKEN?: string;
  /** Composio API credential, configured only with `wrangler secret put COMPOSIO_API_KEY`. */
  COMPOSIO_API_KEY?: string;
  /** Cloudflare Access application identity for the operator control plane. */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OPERATOR_EMAIL: string;
  ASSETS: Fetcher;
  PLATFORM_BOOTSTRAP_TOKEN: string;
  TENANT_RELEASES: DurableObjectNamespace<import('./tenant-releases').TenantReleasesDO>;
  /** Platform authority and account-owned Worker deployment endpoint. Required for Worker launches. */
  PLATFORM_URL?: string;
}
