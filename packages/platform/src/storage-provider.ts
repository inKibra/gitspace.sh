export interface R2TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: string;
}

export class CloudflareR2PlatformClient {
  constructor(private readonly options: {
    accountId: string;
    apiToken: string;
    parentAccessKeyId: string;
    fetcher?: typeof fetch;
    now?: () => number;
  }) {}

  async createBucket(input: { bucketName: string; jurisdiction?: 'default' | 'eu' | 'us' | 'fedramp' }): Promise<void> {
    validateBucketName(input.bucketName);
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/r2/buckets`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          'content-type': 'application/json',
          ...(input.jurisdiction && input.jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': input.jurisdiction } : {}),
        },
        body: JSON.stringify({ name: input.bucketName, storageClass: 'Standard' }),
      },
    );
    const body = await boundedJson(response);
    if (!response.ok || !isCloudflareSuccess(body)) throw new Error(`R2 bucket provisioning failed with ${response.status}`);
  }

  async ensureBucket(input: { bucketName: string; jurisdiction?: 'default' | 'eu' | 'us' | 'fedramp' }): Promise<void> {
    validateBucketName(input.bucketName);
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/r2/buckets/${encodeURIComponent(input.bucketName)}`,
      {
        headers: {
          authorization: `Bearer ${this.options.apiToken}`,
          ...(input.jurisdiction && input.jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': input.jurisdiction } : {}),
        },
      },
    );
    if (response.ok) return;
    if (response.status !== 404) throw new Error(`R2 bucket lookup failed with ${response.status}`);
    await this.createBucket(input);
  }

  async mintTemporaryCredentials(input: {
    bucketName: string;
    prefixes: string[];
    ttlSeconds: number;
    permission?: 'object-read-write' | 'object-read-only';
  }): Promise<R2TemporaryCredentials> {
    validateBucketName(input.bucketName);
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 604_800) throw new RangeError('Temporary credential TTL is invalid');
    const prefixes = [...new Set(input.prefixes.map(validatePrefix))].sort();
    if (prefixes.length === 0) throw new Error('Temporary credentials require at least one prefix');
    const response = await (this.options.fetcher ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/r2/temp-access-credentials`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          bucket: input.bucketName,
          parentAccessKeyId: this.options.parentAccessKeyId,
          permission: input.permission ?? 'object-read-write',
          ttlSeconds: input.ttlSeconds,
          prefixes,
        }),
      },
    );
    const body = await boundedJson(response);
    if (!response.ok || !isCredentialResponse(body)) throw new Error(`R2 temporary credential issuance failed with ${response.status}`);
    return {
      accessKeyId: body.result.accessKeyId,
      secretAccessKey: body.result.secretAccessKey,
      sessionToken: body.result.sessionToken,
      expiresAt: new Date((this.options.now ?? Date.now)() + input.ttlSeconds * 1_000).toISOString(),
    };
  }
}

function validateBucketName(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(value)) throw new Error('R2 bucket name is invalid');
}

function validatePrefix(value: string): string {
  if (value.includes('\0') || new TextEncoder().encode(value).byteLength > 1024) throw new Error('R2 prefix exceeds provider key limits');
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 64 * 1024) throw new Error('Cloudflare API response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) throw new Error('Cloudflare API response is too large');
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isCloudflareSuccess(value: unknown): value is { success: true } {
  return !!value && typeof value === 'object' && (value as { success?: unknown }).success === true;
}

function isCredentialResponse(value: unknown): value is {
  success: true;
  result: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
} {
  if (!isCloudflareSuccess(value) || !('result' in value) || !value.result || typeof value.result !== 'object') return false;
  const result = value.result as Record<string, unknown>;
  return typeof result.accessKeyId === 'string' && typeof result.secretAccessKey === 'string' && typeof result.sessionToken === 'string';
}
