import type { ReactElement } from 'react';
import { PageCanvas, PageHeader } from './GitSpaceShell.js';
import { StorageIncidents } from './StorageIncidents.js';

/** The account's Monitoring page: what the platform's watchdog and each object's storage breaker found. */
export function MonitoringPage(): ReactElement {
  return <PageCanvas>
    <PageHeader kicker="Account" title="Monitoring" description="Durable Objects the storage breaker paused or the watchdog found writing, reading or waking too much, and what has resolved since." />
    <StorageIncidents />
  </PageCanvas>;
}
