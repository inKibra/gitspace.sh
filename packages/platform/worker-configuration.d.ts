interface Env {
  RELEASES: R2Bucket;
  DISPATCHER: DispatchNamespace;
  COMPUTE: Fetcher;
  CREDITS: DurableObjectNamespace<import('./src/index').CreditLedgerDO>;
  DEPLOYMENTS: DurableObjectNamespace<import('./src/index').TenantDeploymentsDO>;
  TENANT_CONTROL: DurableObjectNamespace<import('./src/index').TenantControlDO>;
  TENANT_HOST_SUFFIX: string;
  PLATFORM_URL: string;
  PUBLIC_ASSETS_SERVICE: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  PLATFORM_BOOTSTRAP_TOKEN: string;
  ADMIN_PUBLIC_KEY: string;
  DISPATCH_NAMESPACE: string;
  DEFAULT_CPU_MS: string | number;
  DEFAULT_SUBREQUESTS: string | number;
  ADMIN_AUTH_MAX_SKEW_MS: string | number;
  DISPATCH_SETTLEMENT_MICROS: string | number;
  DEPLOY_SETTLEMENT_MICROS: string | number;
  DEPLOY_PROBE_DELAY_MS: string | number;
}
