import { cloudImageReferenceSchema, cloudImageProviderStatusSchema } from '@gitspace/protocol/cloud-image';
import { z } from 'zod';
import { ComputeProviderError, prepareComputeImage, type ComputeImageDeployment } from './compute-images.js';

interface ComputeTarget { deploymentId: string | null; script: string | null; image: string | null; instance: string | null }
interface ImageTransfer { operationId: string; target: ComputeTarget; staged: boolean }
interface ComputePlacement extends ComputeTarget { machineId: string; operationId: string | null; transfer: ImageTransfer | null }
const machineIdSchema = z.string().regex(/^sandbox-[a-z0-9-]{1,64}$/u);
const operationSchema = z.string().uuid();
const emptyTarget: ComputeTarget = { deploymentId: null, script: null, image: null, instance: null };

/** Only provider allocation/routing state lives here. Workspace checkpoints and release policy remain in account code. */
export class TenantComputeProvider {
  private control: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage, private readonly env: Env, readonly tenant: string, readonly accountId: string) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS compute_images (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS compute_machines (machine_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  private placement(machineId: string): ComputePlacement | null {
    const row = this.storage.sql.exec<{ value: string }>('SELECT value FROM compute_machines WHERE machine_id = ?', machineId).toArray()[0];
    return row ? JSON.parse(row.value) as ComputePlacement : null;
  }
  private save(placement: ComputePlacement): void {
    this.storage.sql.exec('INSERT INTO compute_machines(machine_id,value) VALUES (?,?) ON CONFLICT(machine_id) DO UPDATE SET value=excluded.value', placement.machineId, JSON.stringify(placement));
  }
  private invoke(target: ComputeTarget, path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('x-gitspace-user-id', this.accountId);
    headers.delete('x-gitspace-provider-token');
    headers.delete('x-gitspace-image-incarnation');
    if (target.instance) headers.set('x-gitspace-image-incarnation', target.instance);
    return (target.script ? this.env.DISPATCHER.get(target.script) : this.env.COMPUTE).fetch(new Request(`https://compute.internal${path}`, {
      ...init, headers, redirect: 'manual',
    }));
  }
  private async required(response: Response): Promise<Response> {
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string | { code?: string; message?: string } } | null;
      const error = typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw new ComputeProviderError(body?.error && typeof body.error === 'object' ? body.error.code ?? 'COMPUTE_OPERATION_FAILED' : 'COMPUTE_OPERATION_FAILED', error ?? `Provider operation failed (${response.status})`, response.status);
    }
    return response;
  }
  private async prepare(image: string): Promise<ComputeImageDeployment> {
    return prepareComputeImage({ env: this.env, storage: this.storage, tenant: this.tenant, accountId: this.accountId, image });
  }
  private async providerStatus(target: ComputeTarget, machineId: string) {
    const response = await this.required(await this.invoke(target, `/v1/sandboxes/${machineId}/image/status`, { method: 'POST' }));
    const body = await response.json() as { status?: string; value?: unknown };
    if (body.status !== 'ok') throw new ComputeProviderError('COMPUTE_STATUS_INVALID', 'Provider did not acknowledge image status');
    return cloudImageProviderStatusSchema.parse(body.value);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Private enrollment-transfer methods are callable only by this provider implementation, never via tenant passthrough.
    if (path.includes('/_image/') || path.startsWith('/_image/')) return this.error(new ComputeProviderError('COMPUTE_ROUTE_PRIVATE', 'Provider transfer route is private', 403));
    if (request.method !== 'POST') return this.error(new ComputeProviderError('METHOD_NOT_ALLOWED', 'Compute operations require POST', 405));
    const passive = /^\/v1\/sandboxes\/[^/]+\/(?:rpc|status|image\/status)$/u.test(path) || path === '/v1/images/default';
    const work = () => this.handle(request).catch((error: unknown) => this.error(error));
    if (passive) return work();
    // Serialize provider allocations and handoffs per tenant; RPC and passive health reads never wait on image pulls.
    const result = this.control.then(work, work);
    this.control = result.then(() => undefined, () => undefined);
    return result;
  }
  private error(error: unknown): Response {
    const typed = error instanceof ComputeProviderError;
    return Response.json({ status: 'error', error: { code: typed ? error.code : 'COMPUTE_OPERATION_FAILED', message: error instanceof Error ? error.message : 'Provider operation failed' } }, { status: typed ? error.status : 409 });
  }
  private ok(value: unknown): Response { return Response.json({ status: 'ok', value }); }

  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/v1/images/default') return this.ok({ image: cloudImageReferenceSchema.parse(this.env.COMPUTE_DEFAULT_IMAGE) });
    if (path === '/v1/images/prepare') {
      const body = z.object({ image: cloudImageReferenceSchema }).strict().parse(await request.json());
      const deployment = await this.prepare(body.image);
      return this.ok({ image: deployment.image, deploymentId: deployment.id });
    }
    if (path === '/v1/sandboxes') {
      const body = await request.json() as { machineId?: unknown; userId?: unknown; image?: unknown; environment?: unknown };
      const machineId = machineIdSchema.parse(body.machineId);
      if (body.userId !== undefined && body.userId !== this.accountId) throw new ComputeProviderError('COMPUTE_ACCOUNT_MISMATCH', 'Machine does not belong to this provider account', 403);
      const environment = z.record(z.string(), z.string()).parse(body.environment);
      const image = cloudImageReferenceSchema.parse(body.image ?? this.env.COMPUTE_DEFAULT_IMAGE);
      let placement = this.placement(machineId);
      if (placement && (placement.image !== image || placement.transfer)) throw new ComputeProviderError('COMPUTE_MACHINE_EXISTS', 'Machine already has a different image or an active handoff');
      if (!placement) {
        const count = this.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM compute_machines').one().count;
        if (count >= Number(this.env.COMPUTE_MAX_MACHINES)) throw new ComputeProviderError('COMPUTE_MACHINE_LIMIT', 'This tenant has reached its cloud machine limit');
        const deployment = await this.prepare(image);
        placement = { deploymentId: deployment.id, script: deployment.script, image: deployment.image, instance: crypto.randomUUID(), machineId, operationId: null, transfer: null };
        // Persist allocation before enrolling: a lost response must not allocate another namespace or machine identity.
        this.save(placement);
      }
      return this.invoke(placement, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: this.accountId, machineId, environment }) });
    }
    const match = /^\/v1\/sandboxes\/(sandbox-[a-z0-9-]{1,64})\/(.+)$/u.exec(path);
    if (!match) throw new ComputeProviderError('COMPUTE_ROUTE_NOT_FOUND', 'Compute route does not exist', 404);
    const machineId = match[1]!;
    const action = match[2]!;
    const placement = this.placement(machineId) ?? { ...emptyTarget, machineId, operationId: null, transfer: null };
    if (action === 'image/status') {
      const status = await this.providerStatus(placement, machineId);
      return this.ok({ ...status, image: placement.image ?? status.image, operationId: placement.operationId ?? status.operationId });
    }
    if (action === 'image') {
      const body = z.object({ image: cloudImageReferenceSchema, operationId: operationSchema }).strict().parse(await request.json());
      return this.replace(placement, body.image, body.operationId);
    }
    if (action === 'image/discard') {
      const body = z.object({ operationId: operationSchema.nullable(), recoveryOperationId: operationSchema }).strict().parse(await request.json());
      if (placement.transfer) throw new ComputeProviderError('COMPUTE_HANDOFF_PENDING', 'Reconcile the outstanding image handoff before discarding a candidate');
      if (placement.operationId !== body.operationId) throw new ComputeProviderError('COMPUTE_OPERATION_CHANGED', 'Candidate operation changed before recovery');
      const response = await this.required(await this.invoke(placement, `/v1/sandboxes/${machineId}/_image/discard`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      return response;
    }
    if (!['prepare-replacement', 'cancel-replacement', 'resume', 'status', 'sleep', 'destroy', 'rpc'].includes(action)) {
      throw new ComputeProviderError('COMPUTE_ROUTE_NOT_FOUND', 'Compute route does not exist', 404);
    }
    if (placement.transfer && !['status', 'rpc', 'prepare-replacement'].includes(action)) {
      throw new ComputeProviderError('COMPUTE_HANDOFF_PENDING', 'Complete the image handoff before changing machine lifecycle');
    }
    const response = await this.invoke(placement, path, { method: 'POST', headers: request.headers, body: request.body });
    if (action === 'destroy' && response.ok) this.storage.sql.exec('DELETE FROM compute_machines WHERE machine_id = ?', machineId);
    return response;
  }

  private async replace(placement: ComputePlacement, image: string, operationId: string): Promise<Response> {
    if (placement.operationId === operationId) {
      if (placement.image !== image) throw new ComputeProviderError('COMPUTE_OPERATION_REUSED', 'Image operation identity was reused for a different image');
      return this.ok({ image, operationId });
    }
    if (placement.transfer && (placement.transfer.operationId !== operationId || placement.transfer.target.image !== image)) {
      throw new ComputeProviderError('COMPUTE_HANDOFF_PENDING', 'A different image handoff must be reconciled first');
    }
    if (!placement.transfer) {
      const deployment = await this.prepare(image);
      // This receipt is necessary but not sufficient: the source validates actual checkpoint/discard authority again during export and retirement.
      const status = await this.providerStatus(placement, placement.machineId);
      if (!status.prepared) throw new ComputeProviderError('COMPUTE_NOT_PREPARED', 'Source machine has not prepared for image replacement');
      placement.transfer = { operationId, target: { deploymentId: deployment.id, script: deployment.script, image: deployment.image, instance: operationId }, staged: false };
      this.save(placement);
    }
    const transfer = placement.transfer;
    const transferHeaders = { 'x-gitspace-image-operation': operationId };
    if (!transfer.staged) {
      const enrollment = await this.required(await this.invoke(placement, `/v1/sandboxes/${placement.machineId}/_image/enrollment`, { method: 'GET', headers: transferHeaders }));
      // The platform streams opaque enrollment material to tenant-scoped durable storage. It never persists machine private keys in platform state.
      await this.required(await this.invoke(transfer.target, `/v1/sandboxes/${placement.machineId}/_image/enrollment`, {
        method: 'PUT', headers: { ...transferHeaders, 'content-type': 'application/json' }, body: enrollment.body,
      }));
      transfer.staged = true;
      this.save(placement);
    }
    await this.required(await this.invoke(placement, `/v1/sandboxes/${placement.machineId}/_image/retire`, { method: 'POST', headers: transferHeaders }));
    Object.assign(placement, transfer.target, { operationId, transfer: null });
    this.save(placement);
    return this.ok({ image, operationId });
  }
}
