import { createSignedControlRequest, type ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachInputSchema, RuntimeAttachResultSchema, RuntimeSnapshotInputSchema, RuntimeSnapshotSchema, RuntimeSubmitInputSchema, RuntimeActionResultSchema, RuntimeCancelInputSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';

export type CloudRuntimeClientOptions = { baseUrl: string; userId: string; machineId: string; signingPrivateKey: Uint8Array; fetcher?: typeof fetch };
const EnvelopeSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), value: z.unknown() }), z.object({ status: z.literal('error'), error: z.object({ message: z.string(), code: z.string().optional() }).passthrough() })]);
export class CloudRuntimeClient {
  constructor(private readonly options: CloudRuntimeClientOptions) {}
  async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
    const signed = createSignedControlRequest({ ...this.options, operation, payload });
    const response = await (this.options.fetcher ?? fetch)(new URL('/v1/control', this.options.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed), signal });
    const body = EnvelopeSchema.parse(await response.json());
    if (body.status === 'error') throw new Error(body.error.message);
    if (!response.ok) throw new Error(`Cloud runtime returned HTTP ${response.status}`);
    return schema.parse(body.value);
  }
  attach(input: z.input<typeof RuntimeAttachInputSchema>, signal?: AbortSignal) { return this.call('runtime.attach', RuntimeAttachInputSchema.parse(input), RuntimeAttachResultSchema, signal); }
  snapshot(input: z.input<typeof RuntimeSnapshotInputSchema>, signal?: AbortSignal) { return this.call('runtime.snapshot', RuntimeSnapshotInputSchema.parse(input), RuntimeSnapshotSchema, signal); }
  submit(input: z.input<typeof RuntimeSubmitInputSchema>, signal?: AbortSignal) { return this.call('runtime.submit', RuntimeSubmitInputSchema.parse(input), RuntimeActionResultSchema, signal); }
  cancel(input: z.input<typeof RuntimeCancelInputSchema>, signal?: AbortSignal) { return this.call('runtime.cancel', RuntimeCancelInputSchema.parse(input), RuntimeActionResultSchema, signal); }
}
