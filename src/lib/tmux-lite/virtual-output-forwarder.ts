export interface VirtualOutputSessionState {
  pendingWrites: number;
  attaching: boolean;
  attachDirty: boolean;
}

export type XtermWrite = (data: string, callback: () => void) => void;
export type LiveOutputWriter = (data: string) => void;

/**
 * Feeds virtual terminal output into server-side xterm state while keeping live
 * client forwarding off the xterm write callback path.
 *
 * Attach still suppresses live bytes because the attaching client receives a
 * serialized xterm snapshot once pending writes settle.
 */
export function forwardVirtualTerminalOutput(
  session: VirtualOutputSessionState,
  xtermWrite: XtermWrite,
  writeLiveOutput: LiveOutputWriter,
  data: string,
): void {
  const wasAttaching = session.attaching;
  session.pendingWrites++;
  xtermWrite(data, () => {
    session.pendingWrites--;
    if (wasAttaching && session.attaching) {
      session.attachDirty = true;
    }
  });

  if (!wasAttaching) {
    writeLiveOutput(data);
  }
}
