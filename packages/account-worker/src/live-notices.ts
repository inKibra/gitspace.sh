import type { LiveNotice } from '@gitspace/protocol/live-notice';

/** Tells the account's open tabs what changed; each refetches the state with a normal query. Returns, per notice, how many
 * sockets watched it. A notice that fails to send is only logged: a tab refetches every key whenever its socket opens. */
export async function notifyBrowsers(env: Env, notices: readonly LiveNotice[]): Promise<number[]> {
  if (notices.length === 0) return [];
  try {
    return await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).liveNotices(notices);
  } catch (error) {
    console.error(JSON.stringify({ event: 'live_notice_failed', resources: notices.map(notice => notice.resource), message: error instanceof Error ? error.message : String(error) }));
    return notices.map(() => 0);
  }
}
