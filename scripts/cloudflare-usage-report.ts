#!/usr/bin/env bun
/**
 * Cloudflare usage of a tenant worker and its Durable Object namespaces, with spike flags vs the preceding window.
 * Same report as the platform worker's daily cron (packages/platform/src/usage-report.ts).
 *
 *   bun scripts/cloudflare-usage-report.ts [--script <name>] [--hours 24 | --date YYYY-MM-DD] [--account <id>]
 *
 * Authenticates with the local wrangler OAuth login (~/.config/cloudflare/config/default.json).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fetchUsageReport, formatUsageReport, precedingWindow, rollingWindow, usageSpikes, utcDayWindow } from '../packages/platform/src/usage-report.js';

const DEFAULT_ACCOUNT_ID = '2ed07d2f77ecb2aa43ca99a9c970597c';
const DEFAULT_SCRIPT = 'gitspace-rebuild-20260913-tenant-bradleat';
const wranglerConfigSchema = z.object({ oauth_token: z.string().min(1), expiration_time: z.string().optional() });

const { values } = parseArgs({
  options: {
    script: { type: 'string', default: DEFAULT_SCRIPT },
    hours: { type: 'string' },
    date: { type: 'string' },
    account: { type: 'string', default: DEFAULT_ACCOUNT_ID },
  },
  strict: true,
});
if (values.hours !== undefined && values.date !== undefined) throw new Error('Use either --hours or --date, not both');
const hours = Number(values.hours ?? 24);
if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31) throw new Error(`--hours must be between 0 and ${24 * 31}`);

const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'cloudflare', 'config', 'default.json');
const config = wranglerConfigSchema.parse(await Bun.file(configPath).json());
if (config.expiration_time && Date.parse(config.expiration_time) <= Date.now()) {
  throw new Error(`Wrangler OAuth token in ${configPath} expired at ${config.expiration_time}; run \`bun x wrangler whoami\` or \`bun x wrangler login\` to refresh it`);
}

const window = values.date ? utcDayWindow(values.date) : rollingWindow(new Date(), hours);
const request = { accountId: values.account, script: values.script, analyticsToken: config.oauth_token, namespaceToken: config.oauth_token };
const [current, previous] = await Promise.all([
  fetchUsageReport({ ...request, window }),
  fetchUsageReport({ ...request, window: precedingWindow(window) }),
]);
console.log(formatUsageReport(current, previous, usageSpikes(current, previous)));
