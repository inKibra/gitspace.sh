import type { DeviceCapability } from '@gitspace/protocol/device-grant';

/** Lifetimes an API client or MCP grant can be given. */
export const API_CLIENT_TTLS: ReadonlyArray<{ value: string; label: string; ms: number | null }> = [
  { value: 'never', label: 'Until revoked', ms: null },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { value: '90d', label: '90 days', ms: 90 * 86_400_000 },
];

/** Every capability a client can be granted, as Settings and the OAuth consent page name it. */
export const API_CLIENT_CAPABILITIES: ReadonlyArray<{ id: DeviceCapability; label: string; description: string }> = [
  { id: 'rpc.read', label: 'Read', description: 'Queries and event streams' },
  { id: 'rpc.write', label: 'Write', description: 'Create and change workspaces, settings, automations' },
  { id: 'session.prompt', label: 'Talk to agents', description: 'Prompt and steer (answering their questions needs Decide as you)' },
  { id: 'fleet.control', label: 'Fleet', description: 'Create, stop, start, destroy machines' },
  { id: 'deployment.control', label: 'Deployment', description: 'Select cloud images and control GitSpace runtime releases (account scope required)' },
  { id: 'devices.manage', label: 'Device management', description: 'Revoke enrolled browsers and API clients (whole account required)' },
  { id: 'account.admin', label: 'Account administration', description: 'Manage provider keys, inference, session approval policy and review decisions (whole account and Write required)' },
  { id: 'lifecycle.control', label: 'Lifecycle control', description: 'Approve execution content and browser origins through API/MCP, cancel and recover runs, retire resources (whole account and Write required)' },
  { id: 'operator.decide', label: 'Decide as you', description: 'Answer agents\' questions and approvals, accept requirements, act on your Chrome and its share links, comment as you, file and share QA reports, decide which GitHub accounts the App serves, pause and resume storage. Off unless you need a client to stand in for you' },
];
