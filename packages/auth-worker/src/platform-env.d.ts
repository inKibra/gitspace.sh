interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  GITSPACE_DEV_BOOTSTRAP_TOKEN?: string;
  GITSPACE_OMP_BROKER_TOKEN?: string;
  TENANT_RELEASES: DurableObjectNamespace<import('./tenant-releases').TenantReleasesDO>;
  /** Platform deploy endpoint; unset means worker launches are recorded as `skipped`. */
  PLATFORM_URL?: string;
  PLATFORM_TENANT?: string;
  PLATFORM_TENANT_TOKEN?: string;
}
