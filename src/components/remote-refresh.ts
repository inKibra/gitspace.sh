import { writeCrashLog } from '../utils/crash-log.js';
import { logger } from '../utils/logger.js';

interface ExecuteSafeRefreshOptions {
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  context?: Record<string, unknown>;
  writeLog?: typeof writeCrashLog;
  logError?: (message: string) => void;
}

function toDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeSafeRefresh(options: ExecuteSafeRefreshOptions): Promise<void> {
  try {
    await options.refresh();
  } catch (error) {
    const detail = toDetail(error);
    const logPath = (options.writeLog ?? writeCrashLog)('remote-tui-refresh', error, options.context);
    const logError = options.logError ?? ((message: string) => logger.error(message));
    if (error instanceof Error && error.stack) {
      logError(`[tui] Remote refresh failed:\n${error.stack}`);
    } else {
      logError(`[tui] Remote refresh failed: ${detail}`);
    }
    options.onError(logPath ? `${detail}\nCrash log: ${logPath}` : detail);
  }
}
