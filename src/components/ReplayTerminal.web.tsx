/** @jsxImportSource react */
import { useCallback, useEffect, useState } from 'react';
import { SessionTerminal } from './SessionTerminal.web';

interface ReplayTerminalProps {
  ansi: Uint8Array | null;
}

export function ReplayTerminalWeb({ ansi }: ReplayTerminalProps) {
  const [writer, setWriter] = useState<((data: Uint8Array) => void) | null>(null);

  const setWriteCallback = useCallback((fn: ((data: Uint8Array) => void) | null) => {
    setWriter(() => fn);
  }, []);

  useEffect(() => {
    if (!writer || !ansi) {
      return;
    }
    writer(ansi);
  }, [writer, ansi]);

  return (
    <SessionTerminal
      onData={() => {}}
      setWriteCallback={setWriteCallback}
      readOnly={true}
      allowTapFocus={false}
      allowTouchScroll={true}
    />
  );
}
