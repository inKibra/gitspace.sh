import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  githubId: text("github_id").notNull().unique(),
  githubUsername: text("github_username").notNull(),
  email: text("email"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tokens = sqliteTable("tokens", {
  id: text("id").primaryKey(),
  prefix: text("prefix").notNull(),
  userId: text("user_id").notNull(),
  deviceName: text("device_name"),
  deviceFingerprint: text("device_fingerprint"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});

export const subdomains = sqliteTable("subdomains", {
  id: text("id").primaryKey(),
  subdomain: text("subdomain").notNull().unique(),
  userId: text("user_id").notNull(),
  tunnelId: text("tunnel_id").notNull(),
  serveTunnelId: text("serve_tunnel_id"),
  dnsRecordIds: text("dns_record_ids").notNull(),
  serveDnsRecordIds: text("serve_dns_record_ids"),
  customHostnameId: text("custom_hostname_id"),
  serveCustomHostnameId: text("serve_custom_hostname_id"),
  tunnelTokenEncrypted: text("tunnel_token_encrypted").notNull(),
  serveTunnelTokenEncrypted: text("serve_tunnel_token_encrypted"),
  status: text("status").notNull(),
  isPrimary: integer("is_primary").default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const reservedSubdomains = sqliteTable("reserved_subdomains", {
  subdomain: text("subdomain").primaryKey(),
  reason: text("reason").notNull(),
});

export const subdomainAccess = sqliteTable("subdomain_access", {
  id: text("id").primaryKey(),
  subdomainId: text("subdomain_id").notNull(),
  identityId: text("identity_id").notNull(),
  label: text("label"),
  permissions: text("permissions").notNull(),
  createdAt: integer("created_at").notNull(),
});
