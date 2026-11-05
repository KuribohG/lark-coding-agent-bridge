import { describe, expect, it } from 'vitest';
import { checkJsonOutput } from '../src/engine/json-output';
import { parseJsonSchema, validateJsonSchema } from '../src/engine/json-schema';

const findings = parseJsonSchema({
  type: 'object', title: 'Findings',
  properties: {
    findings: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['file', 'line', 'severity'],
      properties: { file: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 1 }, severity: { enum: ['high', 'low'] } } } },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['findings'],
});

describe('structured output schema', () => {
  it('accepts conforming values and reports path-labelled mismatches', () => {
    expect(validateJsonSchema(findings, { findings: [{ file: 'a.ts', line: 3, severity: 'high' }], note: null })).toEqual([]);
    expect(validateJsonSchema(findings, { findings: [{ file: '', line: 1.5, severity: 'mid', extra: true }], note: 1 })).toEqual([
      '/findings/0/file must have at least 1 characters',
      '/findings/0/line must be integer, got number',
      '/findings/0/severity must be one of ["high","low"]',
      '/findings/0 has unexpected property "extra"',
      '/note does not match any anyOf alternative',
    ]);
    expect(validateJsonSchema(findings, { findings: [] })).toEqual(['/findings must have at least 1 items']);
    expect(validateJsonSchema(findings, [])).toEqual(['/ must be object, got array']);
  });

  it('rejects schemas it cannot enforce instead of silently ignoring keywords', () => {
    expect(() => parseJsonSchema({ type: 'object', properties: { a: { type: 'string', pattern: '^a' } } })).toThrow('Unsupported JSON Schema keyword "pattern"');
    expect(() => parseJsonSchema({ type: 'object', properties: {}, required: ['missing'] })).toThrow('undeclared properties: missing');
    expect(() => parseJsonSchema({ type: 'array', items: { type: 'string' } })).toThrow('root must be');
    expect(() => parseJsonSchema({ type: 'object', properties: { a: { type: 'date' } } })).toThrow('type is invalid');
    expect(() => parseJsonSchema({ type: 'object', properties: { a: { description: 'x'.repeat(17_000) } } })).toThrow('exceeds');
  });

  it('checks fenced worker answers against the schema', () => {
    expect(checkJsonOutput('Done.\n```json\n{"findings":[{"file":"a","line":1,"severity":"low"}]}\n```', findings))
      .toEqual({ text: '{"findings":[{"file":"a","line":1,"severity":"low"}]}' });
    expect(checkJsonOutput('{"findings":"none"}', findings)).toEqual({ problem: 'Agent output does not match schema: /findings must be array, got string' });
    expect(checkJsonOutput('no json', findings)).toEqual({ problem: 'Agent output is not valid JSON' });
  });
});
