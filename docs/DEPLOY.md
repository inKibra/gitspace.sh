# GitSpace Deploy & Gitflow Guide

## Overview
This document defines the deployment flow for gitspace.sh, including staging (gssh.dev),
production (gitspace.sh), and the Gitflow + changeset process for releases.

## Environments

### Production (gitspace.sh)
- API: api.gitspace.sh
- Relay hosts: <user>.gitspace.sh
- Process hosts: <user>.serve.gitspace.sh

### Staging (gssh.dev)
- API: api.gssh.dev
- Relay hosts: <user>.gssh.dev
- Process hosts: <user>.serve.gssh.dev

## Gitflow

### Branches
- main: production
- develop: staging
- feature/*: work branches -> PR to develop
- release/* (optional): used by changesets for prod gating

### Release policy
- develop auto-deploys to staging on every push.
- main deploys to production only via changeset release.

## GitHub OAuth
Staging and prod use separate OAuth apps.

### Staging OAuth
- App: GitSpace (Staging)
- Callback: https://api.gssh.dev/auth/github/callback
- Secrets stored in staging worker env.

### Production OAuth
- Existing prod app + credentials.

## Cloudflare / DNS
Each environment has its own zone.

### Production zone
- gitspace.sh

### Staging zone
- gssh.dev

Each zone uses:
- Custom hostnames (wildcard SSL)
- Separate CF_ZONE_ID, CF_API_TOKEN, CF_ACCOUNT_ID

## D1 / Database policy

### Staging reset policy
On every staging deploy:
- Reset staging DB from production
- Run drizzle push

### Production
- Apply schema via drizzle push during release.

## Worker Deployment

### Staging (develop)
Triggered on every push to develop.

Steps:
1) Reset staging DB from prod snapshot
2) bun install (worker)
3) bun run typecheck
4) bunx drizzle-kit push
5) wrangler deploy --env staging

### Production (main)
Triggered by changeset release.

Steps:
1) bun install (worker)
2) bun run typecheck
3) bunx drizzle-kit push
4) wrangler deploy --env production
5) Tag release + publish CLI

## CLI Release

### Staging
CLI can point to staging via:
GITSPACE_API_URL=https://api.gssh.dev

### Production
Release to users only after worker deploy succeeds on main.

## Tunnel Tokens

### Required tokens
- Relay tunnel:
  TUNNEL_TOKEN_<user>
- Serve tunnel:
  TUNNEL_TOKEN_<user>_serve

Tokens are minted automatically when reserving a subdomain.

### Reserve
gssh host reserve <user>

This creates:
- <user>.gitspace.sh
- <user>.serve.gitspace.sh

## Process Hosting URLs

Hostname format:
<portName|port>.<process>-<instance>.<workspace>.<user>.serve.<zone>

Examples:
web.api-1.foo.brad.serve.gssh.dev
5173.api-1.foo.brad.serve.gssh.dev

## Changeset Release Flow (prod)
1) Open PR with changeset
2) Merge to main after approval
3) CI runs production deploy + CLI publish

## Checklist

### Staging deploy
- Reset staging DB from prod
- drizzle push
- worker deploy
- smoke test: gssh host reserve, gssh host status

### Production deploy
- drizzle push
- worker deploy
- CLI publish
- smoke test: gssh host reserve
