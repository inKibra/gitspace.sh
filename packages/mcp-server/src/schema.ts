type JsonSchema = Record<string, unknown>;

/** Local references stay relative to their original schema when nested in an MCP envelope. */
export function embedJsonSchema(schema: JsonSchema, pointer: string): JsonSchema {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'boolean') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid embedded JSON schema');
    const result = { ...value } as JsonSchema;
    if (typeof result.$ref === 'string') {
      if (result.$ref === '#') result.$ref = pointer;
      else if (result.$ref.startsWith('#/')) result.$ref = `${pointer}${result.$ref.slice(1)}`;
    }
    for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
      const children = result[key];
      if (children && typeof children === 'object' && !Array.isArray(children)) result[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, visit(child)]));
    }
    for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) {
      if (Array.isArray(result[key])) result[key] = result[key].map(visit);
    }
    for (const key of ['additionalProperties', 'unevaluatedProperties', 'items', 'additionalItems', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else']) {
      if (result[key] !== undefined) result[key] = Array.isArray(result[key]) ? result[key].map(visit) : visit(result[key]);
    }
    return result;
  };
  return visit(schema) as JsonSchema;
}
