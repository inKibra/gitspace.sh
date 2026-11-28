// MCP servers hosted on machines (round 8): a Plugins connection whose transport is "on <machine>". The server runs on
// a personal machine (only its owner's workspaces and agents use it) or a team machine (projects turn it on in their
// settings › Plugins; each person uses it within their role). It starts from a command or answers on a local URL; its
// environment comes from the machine's own store (values never leave the machine) or from GitSpace secrets under their
// rules. Workspaces on any machine call it through the relay. While its machine is offline the server and its tools
// stay listed, marked unavailable.
import { MACHINES } from '../settings/data.js';
import { MACHINE_LIVE } from '../live/data.js';
import { createStore } from '../store.js';

export type McpScope = { kind: 'personal'; userId: string } | { kind: 'team' };
export type McpStart = { kind: 'command'; command: string; args: readonly string[] } | { kind: 'url'; url: string };
/** One environment variable the server needs: from the machine's own store, or a GitSpace secret by name. */
export interface McpEnv { name: string; from: 'machine' | 'gitspace'; secret?: string }
export interface McpTool { name: string; description: string }
export interface McpSession { who: string; workspace: string; since: string; calls: number }
export interface MachineMcpServer {
  id: string; name: string; machineId: string; scope: McpScope; start: McpStart; env: readonly McpEnv[]; tools: readonly McpTool[];
  state: 'running' | 'stopped';
  callsLastHour: number;
  /** Workspaces calling it now. */
  sessions: readonly McpSession[];
  /** Team servers: the projects whose settings turn it on. */
  projects: readonly string[];
  added: string;
}

export const machineMcpServers = createStore<readonly MachineMcpServer[]>([
  { id: 'mcp-figma-desktop', name: 'Figma Desktop MCP', machineId: 'maya-mbp', scope: { kind: 'personal', userId: 'maya' },
    start: { kind: 'url', url: 'http://127.0.0.1:3845/mcp' }, env: [],
    tools: [{ name: 'get_code', description: 'Code for the selected frame' }, { name: 'get_variable_defs', description: 'Variables and styles used in the selection' }, { name: 'get_image', description: 'A PNG of the selection' }, { name: 'get_metadata', description: 'Layer names, sizes and positions' }],
    state: 'running', callsLastHour: 23, sessions: [{ who: 'maya', workspace: 'checkout-apple-pay', since: '09:12', calls: 23 }], projects: [], added: 'Nov 4' },
  { id: 'mcp-xcodebuild', name: 'xcodebuild MCP', machineId: 'maya-mbp', scope: { kind: 'personal', userId: 'maya' },
    start: { kind: 'command', command: 'npx', args: ['-y', 'xcodebuildmcp@latest'] }, env: [{ name: 'APPLE_TEAM_ID', from: 'machine' }],
    tools: [{ name: 'build_sim', description: 'Build a scheme for a simulator' }, { name: 'test_sim', description: 'Run a scheme’s tests on a simulator' }, { name: 'list_sims', description: 'Simulators installed on the Mac' }, { name: 'screenshot', description: 'A screenshot of the booted simulator' }],
    state: 'stopped', callsLastHour: 0, sessions: [], projects: [], added: 'Nov 18' },
  { id: 'mcp-postgres-local', name: 'postgres-local', machineId: 'rina-box', scope: { kind: 'personal', userId: 'rina' },
    start: { kind: 'command', command: 'uvx', args: ['postgres-mcp', '--access-mode=restricted'] }, env: [{ name: 'DATABASE_URI', from: 'machine' }, { name: 'AWS_SANDBOX', from: 'gitspace', secret: 'AWS_SANDBOX' }],
    tools: [{ name: 'list_schemas', description: 'Schemas in her local Postgres' }, { name: 'execute_sql', description: 'Read-only SQL' }, { name: 'explain_query', description: 'EXPLAIN ANALYZE a query' }],
    state: 'running', callsLastHour: 41, sessions: [{ who: 'rina', workspace: 'bank-feed-sync', since: '07:20', calls: 41 }], projects: [], added: 'Oct 30' },
  { id: 'mcp-kitchen-printer', name: 'kitchen-printer MCP', machineId: 'counter-mini', scope: { kind: 'team' },
    start: { kind: 'command', command: 'node', args: ['/opt/crumb/printer-mcp/index.js', '--device', '/dev/cu.usbserial-TM30'] }, env: [{ name: 'PRINTER_TOKEN', from: 'machine' }],
    tools: [{ name: 'print_receipt', description: 'Print a receipt on the TM-m30 at the counter' }, { name: 'print_test_page', description: 'A test page with the printer’s status' }, { name: 'printer_status', description: 'Paper, cover and connection' }, { name: 'open_cash_drawer', description: 'Pulse the drawer kicker' }],
    state: 'running', callsLastHour: 12, sessions: [{ who: 'theo', workspace: 'kitchen-display-queue', since: '10:05', calls: 12 }], projects: ['crumb'], added: 'Nov 10 by Theo' },
  { id: 'mcp-ledger-fixtures', name: 'ledger-fixtures MCP', machineId: 'ledger-cloud-2', scope: { kind: 'team' },
    start: { kind: 'command', command: 'bunx', args: ['@crumb/ledger-fixtures-mcp'] }, env: [{ name: 'FIXTURES_TOKEN', from: 'machine' }, { name: 'AWS_REGION', from: 'gitspace', secret: 'AWS_REGION' }],
    tools: [{ name: 'load_bank_feed', description: 'Load a sandbox bank feed fixture' }, { name: 'reset_ledger', description: 'Reset the ledger test database' }, { name: 'list_fixtures', description: 'Fixtures in sandbox-fixtures' }],
    state: 'running', callsLastHour: 0, sessions: [], projects: ['ledger'], added: 'Nov 6 by Rina' },
  { id: 'mcp-crumb-db', name: 'crumb-db-inspector', machineId: 'crumb-cloud-1', scope: { kind: 'team' },
    start: { kind: 'command', command: 'npx', args: ['-y', '@crumb/db-inspector-mcp', '--read-only'] }, env: [{ name: 'DB_READONLY_URL', from: 'machine' }],
    tools: [{ name: 'describe_table', description: 'Columns, indexes and row count' }, { name: 'sample_rows', description: 'Up to 20 rows, PII masked' }, { name: 'slow_queries', description: 'The slowest queries of the last hour' }],
    state: 'running', callsLastHour: 64,
    sessions: [{ who: 'maya', workspace: 'slot-holds', since: '09:40', calls: 38 }, { who: 'deps-bot', workspace: 'deps-week-48', since: '11:02', calls: 26 }], projects: ['crumb'], added: 'Nov 2 by Maya' },
]);

/** The names each machine's own store holds (`gitspace machine secret set NAME` on the machine). Values never leave it. */
export const MACHINE_STORE: Readonly<Record<string, readonly string[]>> = {
  'maya-mbp': ['APPLE_TEAM_ID', 'FIGMA_API_KEY'],
  'maya-vm': ['HF_TOKEN'],
  'rina-box': ['DATABASE_URI', 'PGPASSWORD'],
  'counter-mini': ['PRINTER_TOKEN', 'SQUARE_ACCESS_TOKEN'],
  'crumb-cloud-1': ['DB_READONLY_URL'],
  'ledger-cloud-2': ['FIXTURES_TOKEN'],
  'ec2-fleet': ['LOADTEST_KEY'],
};

/** Programs found on each machine's PATH; any other command isn't found when the server starts. */
export const MACHINE_PATH: readonly string[] = ['npx', 'bunx', 'uvx', 'node', 'bun', 'python3', 'docker', 'xcrun'];

export function machineLabel(machineId: string): string { return MACHINES.find((machine) => machine.id === machineId)?.label ?? machineId; }
export function machineOnline(machineId: string): boolean { return MACHINE_LIVE[machineId]?.connected ?? false; }
/** "Unavailable: ledger-cloud-2 is offline", or null while the host machine is connected. */
export function unavailable(server: MachineMcpServer): string | null {
  return machineOnline(server.machineId) ? null : `Unavailable: ${machineLabel(server.machineId)} is offline`;
}
export function startLine(start: McpStart): string { return start.kind === 'command' ? [start.command, ...start.args].join(' ') : start.url; }
export function relayNote(server: MachineMcpServer): string { return `calls go through the relay to ${machineLabel(server.machineId)}`; }

/** The team servers turned on in a project, and the personal ones of its holders (in projects that allow holders' own
 * plugins): the machine-hosted servers a workspace there can call. */
export function serversFor(project: string, holders: readonly string[], holdersAllowed: boolean, all: readonly MachineMcpServer[]): readonly MachineMcpServer[] {
  return all.filter((server) => server.scope.kind === 'team' ? server.projects.includes(project) : holdersAllowed && holders.includes(server.scope.userId));
}
