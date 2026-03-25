/**
 * Remote session module - client-machine workspace/session communication
 */

export * from "./protocol";
export * from "./workspace-scanner";
export { RemoteSessionHandler, type RemoteClientSession, type ClientState } from "./session-handler";
