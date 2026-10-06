import { defineDoc } from '@earendil-works/pi-durable';
import type { RuntimeSubagentRecord } from '@gitspace/protocol-runtime';
export type SubagentMetadata = RuntimeSubagentRecord;
export const AgentDefinitionContextDoc = defineDoc<{ child: SubagentMetadata | null }>({ kind: 'gitspace.agent-definition', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ child: null }) });
