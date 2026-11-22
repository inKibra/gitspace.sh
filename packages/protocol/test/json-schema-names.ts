/** Prints procedure JSON schemas built in one order from fresh module state: `bun json-schema-names.ts forward|reversed|pair`. */
import { gitspaceContract } from '../src/rpc-contract.js';
import { procedureJsonRepresentation } from '../src/json-representation.js';

const all = [...gitspaceContract.procedures.keys()];
const orders: Record<string, readonly string[]> = { forward: all, reversed: [...all].reverse(), pair: ['inspector.view', 'space.view'] };
const paths = orders[process.argv[2] ?? ''];
if (!paths) throw new Error('Name an order: forward, reversed, or pair');
const schemas: Record<string, string> = {};
for (const path of paths) {
  const { inputSchema, outputSchema, errorsSchema } = procedureJsonRepresentation(path);
  schemas[path] = JSON.stringify({ inputSchema, outputSchema, errorsSchema });
}
process.stdout.write(JSON.stringify(schemas));
