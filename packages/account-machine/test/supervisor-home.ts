import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Brokers the tests start (and the runtime directories they write) stay out of the user's ~/.gitspace/supervisor:
// thousands of test brokers once ran there for days.
process.env.GITSPACE_SUPERVISOR_HOME ??= mkdtempSync(join(tmpdir(), 'gitspace-test-supervisor-'));
