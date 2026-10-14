export type RpcResult = { status: 'ok'; value: unknown } | { status: 'error'; error: unknown };
export class OperationFailure extends Error {
  constructor(readonly detail: unknown) { super('GitSpace operation failed'); }
}
