/** A bounded JSON Schema subset for structured worker output; unsupported keywords are rejected rather than ignored. */
export type JsonSchema = Record<string, unknown>;

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$schema', '$comment']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'anyOf']);
const MAX_SCHEMA_TEXT = 16_000;
const MAX_ERRORS = 10;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, name: string, path: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${path}.${name} must be a non-negative integer`);
};

function checkSchema(schema: unknown, path: string, depth: number): void {
  if (depth > 16) throw new Error('JSON Schema nesting is too deep');
  if (!isObject(schema)) throw new Error(`${path} must be a schema object`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`Unsupported JSON Schema keyword ${JSON.stringify(key)} at ${path}`);
  }
  const { type, properties, required, additionalProperties, items, anyOf } = schema;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.length || types.some(item => typeof item !== 'string' || !TYPES.has(item))) throw new Error(`${path}.type is invalid`);
  }
  if (properties !== undefined) {
    if (!isObject(properties)) throw new Error(`${path}.properties must be an object`);
    for (const [name, child] of Object.entries(properties)) checkSchema(child, `${path}.properties.${name}`, depth + 1);
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some(name => typeof name !== 'string')) throw new Error(`${path}.required must list property names`);
    const missing = required.filter(name => !isObject(properties) || !Object.hasOwn(properties, name as string));
    if (missing.length) throw new Error(`${path}.required names undeclared properties: ${missing.join(', ')}`);
  }
  if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') checkSchema(additionalProperties, `${path}.additionalProperties`, depth + 1);
  if (items !== undefined) checkSchema(items, `${path}.items`, depth + 1);
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || !anyOf.length) throw new Error(`${path}.anyOf must be a nonempty array`);
    anyOf.forEach((child, index) => checkSchema(child, `${path}.anyOf.${index}`, depth + 1));
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error(`${path}.enum must be a nonempty array`);
  for (const name of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) if (schema[name] !== undefined) count(schema[name], name, path);
  for (const name of ['minimum', 'maximum'] as const) {
    if (schema[name] !== undefined && (typeof schema[name] !== 'number' || !Number.isFinite(schema[name]))) throw new Error(`${path}.${name} must be a number`);
  }
}

/** Validates a script-supplied schema; the root must describe an object, as the worker answer is one JSON value. */
export function parseJsonSchema(value: unknown): JsonSchema {
  const text = JSON.stringify(value ?? null);
  if (text.length > MAX_SCHEMA_TEXT) throw new Error(`agent schema exceeds ${MAX_SCHEMA_TEXT} characters`);
  checkSchema(value, 'schema', 0);
  const schema = JSON.parse(text) as JsonSchema;
  if (schema.type !== 'object' || !isObject(schema.properties)) throw new Error('agent schema root must be {type:"object", properties:{...}}');
  return schema;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

function collect(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  const fail = (message: string) => { if (errors.length < MAX_ERRORS) errors.push(`${path || '/'} ${message}`); };
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some(type => matchesType(value, type))) return fail(`must be ${types.join(' or ')}, got ${typeOf(value)}`);
  }
  if (schema.const !== undefined && !equal(value, schema.const)) fail(`must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(item => equal(item, value))) fail(`must be one of ${JSON.stringify(schema.enum).slice(0, 200)}`);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(child => {
    const nested: string[] = [];
    collect(child as JsonSchema, value, path, nested);
    return !nested.length;
  })) fail('does not match any anyOf alternative');
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(`must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`must have at most ${schema.maxLength} characters`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (isObject(schema.items)) value.forEach((item, index) => collect(schema.items as JsonSchema, item, `${path}/${index}`, errors));
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of (schema.required as string[] | undefined) ?? []) if (!Object.hasOwn(value, name)) fail(`is missing required property ${JSON.stringify(name)}`);
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) collect(properties[name] as JsonSchema, item, `${path}/${name}`, errors);
      else if (schema.additionalProperties === false) fail(`has unexpected property ${JSON.stringify(name)}`);
      else if (isObject(schema.additionalProperties)) collect(schema.additionalProperties, item, `${path}/${name}`, errors);
    }
  }
}

/** Bounded, path-labelled mismatches; empty when the value conforms. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  collect(schema, value, '', errors);
  return errors;
}
