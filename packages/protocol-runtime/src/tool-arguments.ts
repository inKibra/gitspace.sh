import { z } from 'zod';
import { RuntimeContentSchema, RuntimeIdentitySchema, RuntimeJsonSchema, RuntimeMachineIdSchema } from './base.js';
import { RuntimeJobHandleSchema } from './execution-contracts.js';
import { RuntimeDispatchSelectionSchema, RuntimeMachineNeedsSchema } from './scheduling.js';
import { LifecycleRunRequestSchema, LifecycleMutationSchema, ServiceTokenRequestSchema } from '@gitspace/protocol-environment';
import { DaemonSnapshotSchema, DaemonStartSpecSchema } from '@gitspace/supervisor/protocol';

const path = z.string().min(1);
export const RuntimeReadArgumentsSchema = z.object({ path: path.describe('File to read: a working-copy path, a drive://, skill://, rule:// or result:// reference, or an absolute /tmp path on the attached machine.'), offset: z.number().int().positive().optional().describe('First line to read, one-based.'), limit: z.number().int().positive().optional().describe('Most lines to read.') });
/** One line describing the change; it becomes the message of the change's edit-history commit. */
const message = z.string().trim().min(1).max(500).optional().describe('One line saying why, recorded in the workspace edit history.');
export const RuntimeWriteArgumentsSchema = z.object({ path: path.describe('File to create or replace: a working-copy path, a drive:// URL this session may write, or an absolute /tmp path on the attached machine.'), content: z.string().describe('The file\'s whole new content.'), message });
export const RuntimeEditArgumentsSchema = z.object({ path: path.describe('File to edit: a working-copy path, a drive:// URL this session may write, or an absolute /tmp path on the attached machine.'), edits: z.array(z.object({ oldText: z.string().min(1).describe('Exact text to replace; it must occur once in the file.'), newText: z.string().describe('Text to put in its place.') })).min(1).describe('Replacements, checked against the original file; they must not overlap.'), message });
export const ApplyPatchArgumentsSchema = z.object({ patch: z.string().min(1).describe('A V4A patch: *** Begin Patch, then Add File, Delete File or Update File sections, then *** End Patch.'), message });
/** `timeoutMs` stops the command's process tree after that long and returns its output with exit code 124. */
export const RuntimeBashCommandArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ command: path.describe('The bash command to run.'), cwd: path.optional().describe('Working directory: a repository path, or an absolute path under /tmp on the machine; the repository root when omitted.'), background: z.boolean().optional().describe('Return a job handle at once instead of waiting up to 60 seconds.'), timeoutMs: z.number().int().positive().max(30 * 60_000).optional().describe('Stop the command after this many milliseconds (at most 30 minutes) and return its output with exit code 124.') }).strict();
const job = RuntimeJobHandleSchema.describe('The job handle a background command returned.');
export const RuntimeBashControlArgumentsSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list').describe('List this conversation\'s jobs.') }),
  z.strictObject({ op: z.enum(['status', 'cancel']).describe('status: the job\'s state, and its result once finished; cancel: stop it.'), job }),
  z.strictObject({ op: z.literal('wait').describe('Wait for the job to finish.'), job, timeoutMs: z.number().int().positive().max(300_000).default(30_000).describe('Longest to wait, at most 5 minutes (default 30 seconds).') }),
  z.strictObject({ op: z.literal('logs').describe('Read the job\'s output so far.'), job, lines: z.number().int().positive().max(10_000).optional().describe('How many lines to return: the last ones, or the first with head.'), head: z.boolean().optional().describe('Return the first lines instead of the last.'), cursor: z.number().int().nonnegative().optional().describe('Return only output after this cursor, from a previous logs call.') }),
]);
export const RuntimeBashArgumentsSchema = z.union([RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema]);
export const RuntimeFindArgumentsSchema = z.object({ pattern: z.string().describe('Glob of paths to match, such as **/*.test.ts.'), path: z.string().default('.').describe('Directory to search beneath; the workspace root by default.') }).strict();
/** The cloud index answers grep's pattern, path, visibility and paging contract; it never selects a machine. */
export const RuntimeCodeSearchArgumentsSchema = RuntimeFindArgumentsSchema.extend({
  pattern: z.string().describe('Rust regex to search for.'), path: z.string().default('.').describe('File or directory to search; the workspace root by default.'),
  glob: z.string().optional().describe('Search only files whose path matches this glob.'),
  hidden: z.boolean().default(false).describe('Search hidden files and directories too.'), gitignore: z.boolean().default(true).describe('Skip files .gitignore excludes (default true).'),
  multiline: z.boolean().default(false).describe('Let the pattern match across lines.'), caseSensitive: z.boolean().default(true).describe('Match letter case (default true).'),
  offset: z.number().int().nonnegative().default(0).describe('Matching lines to skip, for the next page.'), limit: z.number().int().positive().max(10000).default(1000).describe('Most matching lines to return (default 1000, at most 10000).'),
});
export const RuntimeGrepArgumentsSchema = RuntimeCodeSearchArgumentsSchema.extend(RuntimeDispatchSelectionSchema.shape);
export const RuntimeAstGrepArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ pattern: z.string().min(1).describe('ast-grep pattern: $NAME captures one node, $_ ignores one, $$$NAME any number; it must parse as one node.'), path: z.string().default('.').describe('File or directory to search; the workspace root by default.'), language: z.string().optional().describe('Language to parse as (typescript, tsx, python, rust, …); from file extensions when omitted.') });
export const RuntimeAstEditArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ ops: z.array(z.object({ pat: z.string().min(1).describe('ast-grep pattern to match.'), out: z.string().describe('Replacement; the pattern\'s metavariables are substituted.') })).min(1).describe('Rewrites, applied in order.'), paths: z.array(path).min(1).describe('Files to rewrite.'), language: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u).describe('Language of the files (typescript, tsx, python, …).') });
export const RuntimeAstResolveArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ proposalId: path.describe('The proposal ast_edit staged.'), action: z.enum(['apply', 'reject']).describe('apply writes the proposal\'s changes; reject discards them.') });
export const RuntimeCodemodeArgumentsSchema = z.object({ code: z.string().max(262144).describe('JavaScript run as the body of an async function: await tool calls, return the value to report.'), timeoutMs: z.number().int().positive().max(1_800_000).default(1_800_000).describe('Stop the script after this many milliseconds, at most 1800000 (30 minutes, the default).') }).strict();
/** Characters of a script call's arguments and error a codemode result keeps for display. */
export const CODEMODE_CALL_TEXT = 500;
/** One call a codemode script made, as its result's `details.calls` lists it for the transcript: the call ran as a nested
 * call of the codemode call, which leaves no entry of its own. `args` is compact JSON, cut to `CODEMODE_CALL_TEXT`. */
export const RuntimeCodemodeCallSchema = z.object({ tool: z.string(), args: z.string(), status: z.enum(['running', 'completed', 'failed', 'interrupted']), durationMs: z.number().int().nonnegative().optional(), error: z.string().optional() });
export type RuntimeCodemodeCall = z.infer<typeof RuntimeCodemodeCallSchema>;
export const RuntimeCodemodeDetailsSchema = z.object({ calls: z.array(RuntimeCodemodeCallSchema) });
const processName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/u).describe('The process\'s name.');
const processTimeout = z.number().int().positive().max(300_000);
const processSelection = RuntimeDispatchSelectionSchema.shape;
/** A process instance a call acts on only if it is still that one, as status reports it. */
const processInstance = { instanceId: z.string().uuid().optional().describe('Act only on this instance of the process, from status.'), restartCount: z.number().int().nonnegative().optional().describe('Act only if the process has restarted this many times, from status.') };
const readiness = DaemonStartSpecSchema.shape.ready.unwrap();
const startSpec = DaemonStartSpecSchema.omit({ visibility: true, inheritEnv: true, keepOutput: true }).extend({
  name: DaemonStartSpecSchema.shape.name.describe('Name of the process, unique in the workspace.'),
  application: DaemonStartSpecSchema.shape.application.describe('Program to run: a path or a command on PATH.'),
  cwd: path.optional().describe('Working directory, relative to the repository root; the root when omitted.'), args: z.array(z.string()).default([]).describe('Arguments to the program.'),
  env: z.record(z.string(), z.string()).default({}).describe('Environment variables to set.'), pty: z.boolean().default(true).describe('Run in a terminal (default true); send and resize need one.'),
  restart: z.enum(['no', 'on-failure', 'always']).default('no').describe('When to restart it after it exits (default no).'), persist: z.boolean().default(true).describe('Start it again after the machine restarts (default true).'),
  detached: z.boolean().default(false).describe('Let it outlive its supervisor; needs persist.'),
  ready: readiness.extend({
    log: readiness.shape.log.describe('Regex its output matches once it is ready.'), port: readiness.shape.port.describe('Port that accepts connections once it is ready; it gets a machine URL.'),
    host: readiness.shape.host.describe('Host of port; localhost when omitted.'), timeoutMs: readiness.shape.timeoutMs.describe('Longest to wait for readiness; the process stays live after it.'),
  }).optional().describe('When the process counts as ready: its output matching log, port accepting connections, or both.'),
}).strict();
export const RuntimeProcArgumentsSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('start').describe('Start a process.'), ...processSelection, spec: startSpec.describe('The process to start.') }),
  z.strictObject({ op: z.literal('list').describe('List the workspace\'s processes.'), ...processSelection }),
  z.strictObject({ op: z.literal('status').describe('A process\'s state, pid, exit code and readiness.'), name: processName, ...processInstance, ...processSelection }),
  z.strictObject({ op: z.literal('describe').describe('A process\'s whole record, its spec included.'), name: processName, ...processInstance, ...processSelection }),
  z.strictObject({ op: z.literal('stop').describe('Stop a process.'), name: processName, ...processInstance, timeoutMs: processTimeout.optional().describe('Longest to wait for it to exit before it is killed.'), ...processSelection }),
  z.strictObject({ op: z.literal('restart').describe('Restart a process.'), name: processName, timeoutMs: processTimeout.optional().describe('Longest to wait for it to exit before it is killed.'), ...processSelection }),
  z.strictObject({ op: z.literal('send').describe('Type into a process\'s terminal, press keys, send a signal or resize the terminal.'), name: processName, text: z.string().optional().describe('Text to type.'), enter: z.boolean().default(true).describe('Press Enter after text (default true).'), keys: z.array(z.enum(['ENTER', 'TAB', 'ESCAPE', 'CTRL_C', 'CTRL_D', 'UP', 'DOWN', 'LEFT', 'RIGHT'])).optional().describe('Keys to press, after text.'), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']).optional().describe('Signal to send to the process.'), cols: z.number().int().positive().optional().describe('Resize the terminal to this many columns.'), rows: z.number().int().positive().optional().describe('Resize the terminal to this many rows.'), ...processSelection }),
  z.strictObject({ op: z.literal('wait').describe('Wait until a process is ready, exits, or prints a match.'), name: processName, for: z.enum(['ready', 'exit']).optional().describe('What to wait for: ready (default) or exit.'), pattern: path.optional().describe('Wait until its output matches this regex.'), timeoutMs: processTimeout.optional().describe('Longest to wait.'), ...processSelection }),
  z.strictObject({ op: z.literal('logs').describe('Read a process\'s output.'), name: processName, lines: z.number().int().positive().max(10_000).optional().describe('How many lines to return: the last ones, or the first with head.'), head: z.boolean().optional().describe('Return the first lines instead of the last.'), grep: path.optional().describe('Return only lines matching this regex.'), follow: z.boolean().optional().describe('Wait for new output, up to timeoutMs.'), cursor: z.number().int().nonnegative().optional().describe('Return only output after this cursor, from a previous logs call.'), timeoutMs: processTimeout.optional().describe('With follow: longest to wait for new output.'), ...processSelection }),
  /** Points a workspace URL (`as`, default the name) at this machine's running service and `http` port (default its first). */
  z.strictObject({ op: z.literal('pin').describe('Point a workspace URL at a service this machine runs.'), name: processName, source: z.enum(['declared', 'process']).default('process').describe('process: the running process named name (default); declared: the service the workspace declares under that name.'), as: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u).optional().describe('Workspace URL to point; name when omitted.'), port: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u).optional().describe('The service\'s named http port; its first when omitted.'), ...processSelection }),
]);
const agentMessagingOptions = [
  z.strictObject({ op: z.literal('send').describe('Send a message to the parent or a sibling.'), to: path.describe('Address: parent, a sibling\'s name, or a conversation id.'), message: path.describe('The message.') }),
  z.strictObject({ op: z.literal('wait').describe('Wait for the next event: a reply, a finished job or an exited process; a message from the user also ends it.'), timeoutMs: z.number().int().min(1).max(300_000).default(30_000).describe('Longest to wait, at most 5 minutes (default 30 seconds).') }),
  z.strictObject({ op: z.enum(['list', 'status']).describe('list: every agent of this family; status: one.'), id: path.optional().describe('One agent to report; all when omitted.') }),
] as const;
export const RuntimeChildAgentsArgumentsSchema = z.discriminatedUnion('op', agentMessagingOptions);
export const RuntimeAgentsArgumentsSchema = z.union([
  /** `agent` names a definition (omitted: a worker); `role` overrides the definition's model roles. */
  z.strictObject({ op: z.literal('spawn').describe('Start an agent on a task.'), task: path.describe('The complete task: everything the agent needs to know.'), name: path.optional().describe('Address to message it by.'), agent: path.optional().describe('Agent definition to use; a worker when omitted.'), role: path.optional().describe('Model role by id: default, deep, fast, taste, or one the profile adds.'), background: z.boolean().default(false).describe('Let it outlive the foreground turn.') }),
  z.strictObject({ op: z.literal('stop').describe('Stop a child agent.'), id: path.describe('The child to stop.') }),
  RuntimeChildAgentsArgumentsSchema,
]);
export function runtimeOperationIsReadOnly(name: string, args: z.infer<typeof RuntimeJsonSchema>): boolean {
  if (['read', 'grep', 'code_search', 'find', 'web_search', 'web_fetch', 'history_search', 'history_read', 'ast_grep', 'mcp_discover', 'workspace_status', 'wait'].includes(name)) return true;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (['machines', 'agents', 'bash', 'proc', 'sync_machine'].includes(name)) return ['list', 'status', 'describe', 'logs', 'wait', 'diff'].includes(String(args.op));
  if (name === 'sync') return ['status', 'diff', 'backups'].includes(String(args.method));
  if (name === 'service') return args.op === 'list' || args.op === 'logs';
  if (name === 'browser') return args.action === 'chromes';
  if (name.startsWith('space_') || name === 'environment') return ['get', 'current', 'list', 'board', 'operations', 'status', 'progress', 'describe', 'read', 'readCode', 'listScopes', 'listPromotions', 'runLog', 'log'].includes(String(args.method));
  return false;
}
export const RuntimeWorkspaceStatusArgumentsSchema = z.object({}).strict();
export const RuntimeMachinesArgumentsSchema = z.union([
  z.object({ op: z.literal('list').default('list').describe('List the account\'s machines and their attachment to this workspace.') }),
  z.object({ op: z.literal('detach').describe('Detach a machine from this workspace.'), attachmentId: path.describe('The attachment to detach, from list.'), generation: z.number().int().nonnegative().describe('The attachment\'s generation, from list: a newer attachment of the machine is never detached.') }),
  /** `machine` is an id or label; omitted, the account default machine, else any online machine offering `needs`. */
  z.object({ op: z.literal('attach').describe('Attach a machine to this workspace.'), machine: z.string().min(1).optional().describe('Machine id or label; when omitted, the account default machine, else any online machine offering needs.'), needs: RuntimeMachineNeedsSchema.optional() }).strict(),
]);
/** Agent-facing sync control. `on` selects the machine; omitted, the single ready machine is used. */
export const RuntimeSyncArgumentsSchema = z.discriminatedUnion('method', [
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('status').describe('Unsent machine changes, cloud changes not yet on the machine, conflicts and the last sync.') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('now').describe('Send the machine\'s changes now.') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('diff').describe('Changed paths, or one file\'s patch.'), path: path.optional().describe('File whose patch to show.') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('discard').describe('Back up the machine\'s unsent changes, then reset it to the cloud version.'), reason: z.string().trim().min(1).max(500).optional().describe('Why, recorded with the backup.') }),
  z.object({ method: z.literal('backups').describe('List the backups of discarded and conflicted changes.') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('restore').describe('Put a backup\'s files back on the machine as unsent changes.'), ref: path.describe('The backup to restore, from backups.') }),
  z.object({ method: z.literal('resolve').describe('Settle one conflicted path.'), path: path.describe('The conflicted path.'), keep: z.enum(['cloud', 'machine']).describe('Version to keep; the other is backed up first.') }),
]);
const commitId = z.string().regex(/^[0-9a-f]{40}$/u);
/** The machine half of `sync`: what only the machine holding the checkout can do. */
export const RuntimeSyncMachineArgumentsSchema = z.discriminatedUnion('op', [
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('status') }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('capture') }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('diff'), path: path.optional() }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('discard') }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('restore'), checkpointRef: path, commit: commitId, baseRef: path, base: commitId }),
]);
export const RuntimeSyncChangeSchema = z.object({ status: z.string().min(1), path });
export const RuntimeSyncMachineStatusSchema = z.object({
  base: commitId.nullable(), pending: z.boolean(), unsent: z.array(RuntimeSyncChangeSchema), unsentTruncated: z.boolean(),
  lastSyncAt: z.iso.datetime().nullable(), problem: z.string().nullable(),
});
export const RuntimeSyncMachineDiffSchema = z.object({ base: commitId.nullable(), unsent: z.array(RuntimeSyncChangeSchema), unsentTruncated: z.boolean(), patch: z.string().nullable() });
/** A backup holds `commit`; restoring re-applies its changes since `base` onto the current files. */
export const RuntimeSyncBackupSchema = z.object({ checkpointRef: path, commit: commitId, base: commitId });
export const RuntimeSyncMachineDiscardSchema = z.object({ discarded: z.array(RuntimeSyncChangeSchema), backup: RuntimeSyncBackupSchema.nullable(), machineId: path, error: z.string().optional() });
export const RuntimeSyncMachineCaptureSchema = z.object({ version: commitId.nullable(), conflicts: z.array(path) });
export const RuntimeSyncMachineRestoreSchema = RuntimeSyncMachineCaptureSchema.extend({ restored: z.array(RuntimeSyncChangeSchema), mergeConflicts: z.array(path) });
/** What a person runs from the Environment tab's sync line, through the same `sync` operations an agent calls. */
export const RuntimeSyncRequestInputSchema = RuntimeIdentitySchema.extend({
  requestId: z.string().min(1).max(128),
  args: z.discriminatedUnion('method', [
    z.object({ method: z.literal('now'), on: RuntimeMachineIdSchema }),
    z.object({ method: z.literal('diff'), on: RuntimeMachineIdSchema }),
    z.object({ method: z.literal('resolve'), path, keep: z.enum(['cloud', 'machine']) }),
  ]),
});
export const RuntimeSyncRequestResultSchema = z.discriminatedUnion('method', [
  RuntimeSyncMachineCaptureSchema.extend({ method: z.literal('now') }),
  z.object({ method: z.literal('diff'), unsent: z.array(RuntimeSyncChangeSchema), unsentTruncated: z.boolean(), notOnMachine: z.array(RuntimeSyncChangeSchema), notOnMachineTruncated: z.boolean() }),
  z.object({ method: z.literal('resolve'), resolved: path, keep: z.enum(['cloud', 'machine']), backup: path, conflicts: z.array(path) }),
]);
export type RuntimeSyncRequestInput = z.infer<typeof RuntimeSyncRequestInputSchema>;
export type RuntimeSyncRequestResult = z.infer<typeof RuntimeSyncRequestResultSchema>;
/** `page` reads from `offset` forward, or with `fromEnd` the newest events first, before `before` (the previous page's
 * `nextBefore`). `role` keeps only messages of that role; `textOnly` keeps only their text (no thinking, tool calls or
 * tool results), so the latest reply of a workspace is `{ workspaceId, fromEnd: true, role: 'assistant', textOnly: true,
 * limit: 1 }`. `conversationId` defaults to the workspace's main conversation. */
const otherWorkspace = path.optional().describe('Another workspace of this project; this one when omitted.');
const conversation = path.optional().describe('Conversation to read; the workspace\'s main conversation when omitted.');
export const RuntimeHistoryReadArgumentsSchema = z.union([
  z.object({
    mode: z.literal('page').default('page').describe('Read a page of events (the default).'), workspaceId: otherWorkspace, conversationId: conversation,
    offset: z.number().int().nonnegative().default(0).describe('Ordinal to read forward from (entryId*1024+n), not a count.'), fromEnd: z.boolean().default(false).describe('Read newest first.'), before: z.number().int().positive().optional().describe('With fromEnd: read events before this ordinal, the previous page\'s nextBefore.'),
    role: z.enum(['user', 'assistant', 'toolResult', 'custom']).optional().describe('Keep only messages of this role.'), textOnly: z.boolean().default(false).describe('Keep only message text: no thinking, tool calls or tool results.'),
    limit: z.number().int().min(1).max(200).default(50).describe('Most events, 1 to 200 (default 50).'),
  }),
  z.object({ mode: z.literal('content').describe('Read one event\'s whole content.'), workspaceId: otherWorkspace, conversationId: conversation, ordinal: z.number().int().nonnegative().describe('The event to read, a result\'s content.ordinal.'), contentOffset: z.number().int().nonnegative().default(0).describe('Characters to skip.'), contentLimit: z.number().int().min(1).max(65_536).default(16_384).describe('Most characters to return, at most 65536 (default 16384).') }),
]);
export type RuntimeHistoryReadArguments = z.infer<typeof RuntimeHistoryReadArgumentsSchema>;
/** `query`: words, all of which rank a match higher, and "quoted phrases", each of which a match must contain exactly.
 * `workspaceId` searches that one workspace of the project; `scope: 'project'` every workspace. */
export const RuntimeHistorySearchArgumentsSchema = z.object({ query: path.describe('Words, each ranking a match higher, and "quoted phrases", each of which a match must contain exactly.'), scope: z.enum(['workspace', 'project']).default('workspace').describe('workspace (the default) or project: every workspace of the project.'), workspaceId: path.optional().describe('One other workspace of this project to search.'), cursor: z.string().max(512).optional().describe('The previous call\'s cursor, to search older history.') });
export const RuntimeWebSearchArgumentsSchema = z.object({ query: z.string().min(1).max(1024).describe('What to search for.'), limit: z.number().int().min(1).max(10).optional().describe('How many results, 1 to 10 (default 5).') });
export const RuntimeWebFetchArgumentsSchema = z.object({
  url: z.string().min(1).max(2000).describe('The http(s) URL to read.'),
  offset: z.number().int().nonnegative().optional().describe('Character offset to continue a long page from, as the previous result\'s header gives it.'),
  format: z.enum(['auto', 'raw']).optional().describe('auto (default) converts HTML, PDF and Office documents to Markdown and pretty-prints JSON; raw returns a text body as served.'),
});
export const RuntimeReportIssueArgumentsSchema = z.object({ message: z.string().min(1).max(16384).describe('What failed: the call, what happened and what was expected.'), tool: z.string().max(160).optional().describe('The tool that failed.'), model: z.string().max(256).optional().describe('The model in use when it failed.'), reference: z.string().max(2048).optional().describe('Where to look: a result:// reference, URL or file path.') });
export const RuntimeCheckpointArgumentsSchema = z.object({ goal: z.string().describe('What the exploration is for.') });
export const RuntimeRewindArgumentsSchema = z.object({ checkpoint: z.string().describe('The checkpoint id checkpoint returned.'), report: z.string().describe('What the exploration found; it replaces the exploration in context.') });
/** The longest a `wait` call holds the conversation. */
export const WAIT_MAX_MS = 30 * 60_000;
export const RuntimeWaitArgumentsSchema = z.object({ timeoutMs: z.number().int().min(1_000).max(WAIT_MAX_MS).optional().describe('Longest to wait, from 1 second to 30 minutes (the default).') }).strict();
export const RuntimeMcpInvokeArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ connectionId: path.describe('The connection, from mcp_discover.'), name: path.describe('The tool\'s name on that connection.'), arguments: z.record(z.string(), RuntimeJsonSchema).optional().describe('The tool\'s arguments, as its input schema says.') }).strict();
export const RuntimeMcpDiscoverArgumentsSchema = z.union([z.object({}).strict(), RuntimeDispatchSelectionSchema.extend({ connectionId: path.describe('Connection whose tools to list.'), name: path.optional().describe('One tool to describe in full, its input schema included.') }).strict()]);
const MCP_LISTED_DESCRIPTION_CHARACTERS = 300;
/** What `mcp_discover` returns for one connection: its tools by name and short description, or, asked for one tool by
 * name, that tool's full descriptor (input schema included). Toolkits such as Composio's Notion run far past the 50 KB
 * tool result limit when every input schema is inlined, which cut the listing short and broke codemode's JSON. */
export function discoveredMcpTools(tools: ReadonlyArray<{ name: string; description?: unknown }>, name: string | undefined): unknown {
  if (name !== undefined) {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`MCP tool ${name} is not exposed by this connection`);
    return tool;
  }
  return tools.map(tool => ({ name: tool.name, description: typeof tool.description === 'string' ? tool.description.slice(0, MCP_LISTED_DESCRIPTION_CHARACTERS) : null }));
}
const imageInput = RuntimeContentSchema.options[1];
export const RuntimeGenerateImageArgumentsSchema = z.object({ prompt: path.describe('What to draw, in detail; say what each input image is for.'), model: path.optional().describe('An image model: cloudflare/<model> on Workers AI or an admitted provider/model; the profile\'s Images service when omitted.'), images: z.array(imageInput.extend({ type: imageInput.shape.type.describe('Always image.'), data: imageInput.shape.data.describe('Base64 bytes, or a stored image\'s reference from a tool result.'), mimeType: imageInput.shape.mimeType.describe('The image\'s type, such as image/png.') })).optional().describe('Images to edit or draw from.') }).strict();
export const RuntimeSpacePhaseArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ phase: z.enum(['plan', 'code', 'review', 'ship']).describe('The workspace\'s new phase.') });
const machinePath = path.describe('Path on the machine: relative to the checkout, or absolute under /tmp.');
export const RuntimeSpaceArtifactsArgumentsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.enum(['list', 'listScopes', 'listPromotions']).describe('List the workspace\'s artifacts, drive scopes or promotions.') }),
  z.object({ method: z.literal('read').describe('Read an artifact.'), url: path.describe('The artifact\'s drive:// URL.') }),
  z.object({ method: z.literal('readCode').describe('Read a repository file at a commit.'), path: path.describe('Repository path.'), commit: z.string().regex(/^[a-f0-9]{40,64}$/u).describe('Commit to read it at.') }),
  RuntimeDispatchSelectionSchema.extend({ method: z.literal('toMachine').describe('Copy a drive file to the machine.'), url: path.describe('The drive:// file to copy.'), path: machinePath }),
  RuntimeDispatchSelectionSchema.extend({ method: z.literal('fromMachine').describe('Publish a machine file to the drive.'), path: machinePath, url: path.describe('drive:// URL to write; this session must be allowed to write it.') }),
]);
const sha256Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
/** `drive_transfer` moves one drive file between the account's storage and the attached machine through the account's
 * data endpoint, which keeps every key: the machine fetches or stores the plain bytes itself, so no file bytes pass
 * through the workspace object or the model. `blobHash` is the reference the drive manifest records. Paths follow the
 * file tools: relative to the checkout, or absolute inside /tmp. */
export const RuntimeDriveTransferArgumentsSchema = z.discriminatedUnion('direction', [
  /** `object`: the manifest entry's object id when the file was streamed before its digest was known. */
  RuntimeDispatchSelectionSchema.extend({ direction: z.literal('toMachine'), path, scopeId: path, blobHash: sha256Hash, size: z.number().int().nonnegative(), object: z.string().uuid().optional() }),
  RuntimeDispatchSelectionSchema.extend({ direction: z.literal('fromMachine'), path, scopeId: path }),
]);
/** What `fromMachine` stored in the scope: the plaintext digest naming the object, for the cloud to check and name in the
 * scope's manifest. */
export const RuntimeDriveTransferStoredSchema = z.object({ blobHash: sha256Hash, size: z.number().int().nonnegative() }).strict();
/** An agent's lifecycle run never runs interactively. Its cloud/destroy deletes only the resources its own workspace
 * recorded; the account refuses it on the project's base workspace. */
export const RuntimeAgentLifecycleRunArgumentsSchema = LifecycleRunRequestSchema.omit({ interactive: true }).extend(RuntimeDispatchSelectionSchema.shape);
/** A lifecycle run as its cache machine receives it. Agents enter through the narrower schema above; a human run,
 * authorized by the account before dispatch, may also run interactively. */
export const RuntimeLifecycleDispatchArgumentsSchema = LifecycleRunRequestSchema.extend(RuntimeDispatchSelectionSchema.shape);
const run = RuntimeAgentLifecycleRunArgumentsSchema.shape;
const lifecycleRun = RuntimeAgentLifecycleRunArgumentsSchema.extend({
  runId: run.runId.describe('Your id for the run; reuse it to find a run whose answer was lost.'), phase: run.phase.describe('The lifecycle phase to run.'),
  rerun: run.rerun.describe('Run again although this run id already ran.'), deadlineAt: run.deadlineAt.describe('Stop the run at this time (ISO 8601).'),
});
const [, setProfile, putValue] = LifecycleMutationSchema.options;
const valueName = putValue.shape.name.describe('The value\'s name, in UPPER_SNAKE_CASE.');
const valueScope = z.enum(['project', 'workspace']).describe('project: every workspace of the project; workspace: this one.');
export const RuntimeEnvironmentArgumentsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('get').describe('The lifecycle configuration, profile, values, runs and browser site approvals.') }),
  z.object({ method: z.enum(['runLog', 'log']).describe('Read a run\'s log.'), runId: path.describe('The run.'), offset: z.number().int().nonnegative().optional().describe('Where to read from: the previous read\'s next offset.') }),
  lifecycleRun.omit({ phase: true }).extend({ method: z.literal('runChecks').describe('Run the environment checks.') }),
  lifecycleRun.extend({ method: z.literal('runPhase').describe('Run a lifecycle phase.') }),
  setProfile.omit({ op: true }).extend({ method: z.literal('setProfile').describe('Switch the workspace to another environment profile.'), profile: setProfile.shape.profile.describe('The profile, from get.') }),
  putValue.omit({ op: true }).extend({ method: z.literal('putValue').describe('Set a value the lifecycle scripts read.'), name: valueName, scope: valueScope, value: z.string().max(16_384).describe('The value.') }),
  putValue.omit({ op: true, value: true }).extend({ method: z.literal('deleteValue').describe('Remove a value.'), name: valueName, scope: valueScope }),
  z.object({ method: z.literal('cancelRun').describe('Cancel a run.'), runId: path.describe('The run to cancel.') }),
  ServiceTokenRequestSchema.extend({
    method: z.literal('token').describe('Sign an app token for a service whose routes set tokens: true.'),
    service: ServiceTokenRequestSchema.shape.service.describe('The service, as .gitspace/services.json names it.'),
    port: ServiceTokenRequestSchema.shape.port.describe('Its http port whose workspace URL the token is for; the first with token routes by default.'),
    subject: ServiceTokenRequestSchema.shape.subject.describe('Who the token is for (its sub), like ios-dev/brad.'),
    ttlSeconds: ServiceTokenRequestSchema.shape.ttlSeconds.describe('Lifetime in seconds, 60 to 28800 (8 hours, the default).'),
    refresh: ServiceTokenRequestSchema.shape.refresh.describe('Also return a refresh token (7 days, replaced on every use).'),
  }),
]);
/** `import_ref` runs on a machine holding the project's base checkout: it fetches one origin ref with the machine's own git
 * credentials and publishes it to the project's cloud repository, for origins the cloud cannot read. */
export const RuntimeImportRefArgumentsSchema = z.object({
  ref: z.string().max(512).regex(/^refs\/(?:(?:heads|tags)\/[^\0\s]+|pull\/[1-9][0-9]*\/head)$/u),
}).strict();
/** A machine's report that a workspace process it supervises exited, sent when its supervisor sees the exit. */
export const RuntimeProcessExitedInputSchema = RuntimeIdentitySchema.extend({ daemon: DaemonSnapshotSchema.extend({ state: z.enum(['exited', 'failed']) }) }).strict();
export type RuntimeProcessExitedInput = z.infer<typeof RuntimeProcessExitedInputSchema>;
export const RuntimeImportRefResultSchema = z.object({ ref: z.string(), commit: z.string().regex(/^[0-9a-f]{40}$/u) }).strict();
