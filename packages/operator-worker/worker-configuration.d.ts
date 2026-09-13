interface Env {
  DISTRIBUTION: R2Bucket;
  ASSETS: Fetcher;
  PLATFORM_URL: string;
  PLATFORM_BOOTSTRAP_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OPERATOR_EMAIL: string;
  INVITES: DurableObjectNamespace<import('./src/index').InviteRegistryDO>;
  ACCOUNTS: DurableObjectNamespace<import('./src/index').AccountRegistryDO>;
}
