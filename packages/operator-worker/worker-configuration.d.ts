interface Env {
  ASSETS: Fetcher;
  PLATFORM_URL: string;
  /** The install's domains (`@gitspace/protocol-environment/domains`); unset, GitSpace's own. */
  ACCOUNT_DOMAIN?: string;
  SERVICE_DOMAIN?: string;
  PLATFORM_BOOTSTRAP_TOKEN: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OPERATOR_EMAIL: string;
  INVITES: DurableObjectNamespace<import('./src/index').InviteRegistryDO>;
  ACCOUNTS: DurableObjectNamespace<import('./src/index').AccountRegistryDO>;
}
