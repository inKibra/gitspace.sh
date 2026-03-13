import { readRelayConfig } from './identity.js';
import { readHostConfig, resolveRelaySubdomains, type HostConfig } from '../commands/host.js';

const LOCAL_RELAY_PORT = 4480;

export interface RelayCandidate {
	url: string;
	label: string;
	source: 'local' | 'account' | 'cached';
	description?: string;
}

export interface DiscoverRelayCandidatesOptions {
	hostConfig?: HostConfig | null;
	includeLocalRelay?: boolean;
	includeCachedRelay?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLocalRelayUrl(relayUrl: string): boolean {
	try {
		const parsed = new URL(relayUrl);
		return isLoopbackHostname(parsed.hostname) || parsed.hostname === '0.0.0.0' || parsed.hostname === '::';
	} catch {
		return false;
	}
}

export async function isRelayHealthy(relayUrl: string, timeoutMs: number = 1200): Promise<boolean> {
	try {
		const relay = new URL(relayUrl);
		const protocol = relay.protocol === 'wss:' ? 'https:' : 'http:';
		const healthUrl = `${protocol}//${relay.host}/health`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(healthUrl, { signal: controller.signal });
			return response.ok;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		return false;
	}
}

export async function discoverRelayCandidates(
	options: DiscoverRelayCandidatesOptions = {},
): Promise<RelayCandidate[]> {
	const {
		hostConfig = readHostConfig(),
		includeLocalRelay = true,
		includeCachedRelay = true,
	} = options;

	const candidates: RelayCandidate[] = [];
	const seen = new Set<string>();
	const addCandidate = (candidate: RelayCandidate) => {
		if (seen.has(candidate.url)) {
			return;
		}
		seen.add(candidate.url);
		candidates.push(candidate);
	};

	if (includeLocalRelay) {
		addCandidate({
			url: `ws://127.0.0.1:${LOCAL_RELAY_PORT}/ws`,
			label: 'Local relay',
			source: 'local',
			description: 'Detected on this machine',
		});
	}

	const accountSubdomains = await resolveRelaySubdomains(hostConfig);
	for (const subdomain of accountSubdomains) {
		addCandidate({
			url: `wss://${subdomain}.gitspace.sh/ws`,
			label: `${subdomain}.gitspace.sh`,
			source: 'account',
			description: hostConfig?.subdomain === subdomain ? 'Primary account relay' : 'Account relay',
		});
	}

	if (includeCachedRelay) {
		const cachedRelay = readRelayConfig();
		const cachedUrl = cachedRelay?.cloudRelayUrl ?? cachedRelay?.relayUrl;
		if (cachedUrl && !isLocalRelayUrl(cachedUrl)) {
			addCandidate({
				url: cachedUrl,
				label: 'Recent relay',
				source: 'cached',
				description: 'Last relay used on this machine',
			});
		}
	}

	return candidates;
}

export async function findReachableRelayCandidate(
	options: DiscoverRelayCandidatesOptions = {},
): Promise<RelayCandidate | null> {
	const candidates = await discoverRelayCandidates(options);
	if (candidates.length === 0) {
		return null;
	}

	const healthChecks = await Promise.all(candidates.map((candidate) => isRelayHealthy(candidate.url)));
	const reachableIndex = healthChecks.findIndex(Boolean);
	return reachableIndex >= 0 ? candidates[reachableIndex] ?? null : null;
}
