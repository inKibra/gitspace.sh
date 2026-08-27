import { describe, expect, it } from 'bun:test';
import {
  hashRelayBundle,
  renderStandaloneWrangler,
  renderWfpUploadMetadata,
  validateRelayDeployment,
  type RelayDeploymentManifest,
} from '../src/index.js';

const manifest: RelayDeploymentManifest = {
  version: 1,
  workerName: 'gitspace-relay-test',
  mainModule: 'dist/worker.js',
  bundleHash: `sha256:${'a'.repeat(64)}`,
  compatibilityDate: '2026-08-27',
  compatibilityFlags: ['nodejs_compat'],
  relayBinding: 'RELAY',
  relayClass: 'UserRelayDO',
  relayName: 'default',
  blobBinding: 'BLOBS',
  authPublicKey: 'public-key',
  authMaxSkewMs: 60_000,
  tunnelHeaderTimeoutMs: 10_000,
  tunnelIdleTimeoutMs: 30_000,
  cpuMs: 50,
  subRequests: 20,
  migrations: [
    { tag: 'v1', newSqliteClasses: ['RelayDO'], deletedClasses: [], renamedClasses: [] },
    {
      tag: 'v2',
      newSqliteClasses: [],
      deletedClasses: [],
      renamedClasses: [{ from: 'RelayDO', to: 'UserRelayDO' }],
    },
  ],
};

describe('relay deployment manifest', () => {
  it('renders one binding and migration contract to standalone and WfP targets', () => {
    const allocation = { bucketName: 'tenant-artifacts' };
    const standalone = renderStandaloneWrangler(manifest, allocation);
    const wfp = renderWfpUploadMetadata(manifest, allocation);
    expect(wfp.status).toBe('ok');
    if (wfp.status === 'error') throw wfp.error;

    expect(standalone.durable_objects.bindings).toEqual([{ name: 'RELAY', class_name: 'UserRelayDO' }]);
    expect(standalone.r2_buckets).toEqual([{ binding: 'BLOBS', bucket_name: 'tenant-artifacts' }]);
    expect(standalone.migrations).toEqual([
      { tag: 'v1', new_sqlite_classes: ['RelayDO'] },
      { tag: 'v2', renamed_classes: [{ from: 'RelayDO', to: 'UserRelayDO' }] },
    ]);
    expect(wfp.value.bindings[0]).toEqual({ name: 'RELAY', type: 'durable_object_namespace', class_name: 'UserRelayDO' });
    expect(wfp.value.bindings[1]).toEqual({ name: 'BLOBS', type: 'r2_bucket', bucket_name: 'tenant-artifacts' });
    expect(wfp.value.migrations).toMatchObject({
      new_tag: 'v2',
      steps: [
        { new_sqlite_classes: ['RelayDO'] },
        { renamed_classes: [{ from: 'RelayDO', to: 'UserRelayDO' }] },
      ],
    });
    expect(wfp.value.limits).toEqual({ cpu_ms: 50, subrequests: 20 });
  });

  it('rejects unknown previous migration tags', () => {
    expect(renderWfpUploadMetadata(manifest, { bucketName: 'tenant-artifacts' }, 'missing').status).toBe('error');
  });

  it('omits migration metadata when the deployed tag is current', () => {
    const rendered = renderWfpUploadMetadata(manifest, { bucketName: 'tenant-artifacts' }, 'v2');
    expect(rendered.status).toBe('ok');
    if (rendered.status === 'error') throw rendered.error;
    expect(rendered.value.migrations).toBeUndefined();
  });

  it('validates manifests and hashes the exact built bytes', async () => {
    expect(validateRelayDeployment(manifest).status).toBe('ok');
    expect(validateRelayDeployment({ ...manifest, bundleHash: 'not-a-hash' }).status).toBe('error');
    expect(await hashRelayBundle(new TextEncoder().encode('relay bundle'))).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
