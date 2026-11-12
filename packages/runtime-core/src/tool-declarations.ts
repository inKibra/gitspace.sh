import { z } from 'zod';
import { schemaToType } from '@earendil-works/pi-codemode/declarations';

/** A tool as a script sees it: what it does, its arguments, and hand-written usage and examples (scripts that call it).
 * `text`: it always answers with one text item (JSON, for most), so a script reads `(await tools.x(args))[0].text`. */
export type ToolDeclarationSource = { name: string; description: string; schema: z.ZodType; usage?: string; examples?: readonly string[]; text?: true };
type JsonSchema = z.core.JSONSchema.BaseSchema;

/** What a tool call in a script resolves to: the call's content, as a tool result holds it. */
const TOOL_CONTENT = 'type TextContent = { type: "text"; text: string };\ntype ImageContent = { type: "image"; mimeType: string; data: string };\ntype ToolContent = TextContent | ImageContent;';
/** The script call that lists tools and declares one: always present, whatever the tools. */
const DESCRIBE_MEMBER = '  /** With no name, every tool a script can call; with a name, its declaration and usage; with an operation too, that operation\'s. */\n  describe(name?: string, op?: string): Promise<string>;';
/** Largest argument type rendered before it becomes `unknown`, in characters. */
const TYPE_MAX_CHARS = 24_000;

/** A schema's input JSON Schema, every union written as `anyOf`: zod writes `oneOf` for a discriminated union, which some
 * providers reject and the declarations would render the same. */
export function inputJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { io: 'input', override: ({ jsonSchema }) => { if (jsonSchema.oneOf) { jsonSchema.anyOf = jsonSchema.oneOf; delete jsonSchema.oneOf; } } });
}

/** A tool's operations: its union's object variants, each named by the values of its `method` or `op` (none for a
 * variant without either, such as a bash command). */
function operations(schema: JsonSchema): { names: string[]; schema: JsonSchema }[] {
  if (schema.anyOf) return schema.anyOf.flatMap(variant => typeof variant === 'boolean' ? [] : operations(variant));
  const selector = schema.properties?.method ?? schema.properties?.op;
  const values = typeof selector === 'object' ? selector.const !== undefined ? [selector.const] : selector.enum ?? [] : [];
  return [{ names: values.map(String), schema }];
}

/** `space_journal` → `SpaceJournalArgs`. */
function argsType(name: string): string {
  return `${name.split(/[^A-Za-z0-9]/u).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')}Args`;
}

/** A doc comment of `lines`, safe to close. */
function docComment(lines: readonly string[]): string {
  return ['/**', ...lines.flatMap(line => line.split('\n')).map(line => ` *${line ? ` ${line.replaceAll('*/', '*\\/')}` : ''}`), ' */'].join('\n');
}

/** A tool's documentation and argument type, of all its operations or only of `op`. Throws for an operation it lacks. */
function declaration(source: ToolDeclarationSource, op?: string): string {
  const all = operations(inputJsonSchema(source.schema));
  const chosen = op === undefined ? all : all.filter(variant => variant.names.includes(op));
  if (chosen.length === 0) throw new Error(`${source.name} has no operation ${op}; its operations are ${[...new Set(all.flatMap(variant => variant.names))].join(', ')}`);
  const type = chosen.map(variant => schemaToType(variant.schema, { maxChars: TYPE_MAX_CHARS })).join(' | ');
  const docs = [source.description, ...source.usage ? ['', source.usage] : [], ...(source.examples ?? []).flatMap(example => ['', '@example', example])];
  return `${docComment(docs)}\ntype ${argsType(source.name)} = ${type};`;
}

/** The `tools` object's member for a tool, as scripts call it. */
function member(source: ToolDeclarationSource): string {
  return `  ${source.name}(args: ${argsType(source.name)}): Promise<${source.text ? '[TextContent]' : 'ToolContent[]'}>;`;
}

/** What `tools.describe(name, op)` returns: the tool's declaration (of `op` alone when given) as TypeScript a script
 * calls it by. */
export function declareTool(source: ToolDeclarationSource, op?: string): string {
  return [TOOL_CONTENT, declaration(source, op), `declare const tools: {\n${member(source)}\n};`].join('\n\n');
}

/** Every tool's declaration in one file, as scripts call them: the examples test typechecks against it. */
export function declareTools(sources: readonly ToolDeclarationSource[]): string {
  return [TOOL_CONTENT, ...sources.map(source => declaration(source)), `declare const tools: {\n${[...sources.map(member), DESCRIBE_MEMBER].join('\n')}\n};`].join('\n\n');
}

/** What `tools.describe()` returns: one line per tool, its first sentence and its operations. */
export function toolCatalog(sources: readonly ToolDeclarationSource[]): string {
  return sources.map(source => {
    const sentence = /^.*?[.!?](?=\s|$)/su.exec(source.description)?.[0] ?? source.description;
    const names = [...new Set(operations(inputJsonSchema(source.schema)).flatMap(variant => variant.names))];
    return `- ${source.name}: ${sentence}${names.length > 0 ? ` Operations: ${names.join(', ')}.` : ''}`;
  }).join('\n');
}
