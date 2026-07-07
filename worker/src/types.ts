/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  // D1 Database
  DB: D1Database;

  // R2 bucket for managed artifacts blobs (LFS-style split)
  ARTIFACT_BLOBS: R2Bucket;

  // Environment variables
  PORTAL_URL: string;
  MAX_ACCOUNTS: string; // Global account limit (beta period)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  SERVE_DOMAIN?: string;
  ENCRYPTION_KEY: string;
  GITHUB_OAUTH_BASE?: string;
  GITHUB_API_BASE?: string;
  CF_API_BASE?: string;

  // Managed artifacts tier (CF Artifacts git hosting upstream)
  CF_ARTIFACTS_API_URL?: string;
  CF_ARTIFACTS_API_TOKEN?: string;
  ARTIFACTS_GIT_BASE?: string;
}

/**
 * User record from D1
 */
export interface User {
  id: string;
  github_id: string;
  github_username: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Token record from D1
 */
export interface Token {
  id: string;
  prefix: string;
  user_id: string;
  device_name: string | null;
  device_fingerprint: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * Subdomain record from D1
 */
export interface Subdomain {
  id: string;
  subdomain: string;
  user_id: string;
  tunnel_id: string;
  dns_record_ids: string;
  tunnel_token_encrypted: string;
  tunnel_config_source: 'cloudflare' | 'local';
  tunnel_name: string | null;
  tunnel_secret_encrypted: string | null;
  status: 'active' | 'suspended' | 'deleted';
  is_primary: number;
  created_at: number;
  updated_at: number;
}

/**
 * Session record from D1
 */
export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  ip_address: string | null;
  user_agent: string | null;
}

export interface IdentityBackupRecord {
  user_id: string;
  version: number;
  kind: string;
  owner_user_root_id: string;
  envelope_json: string;
  created_at: number;
  updated_at: number;
}

/**
 * GitHub user info from API
 */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

/**
 * GitHub Device Flow response
 */
export interface GitHubDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}
