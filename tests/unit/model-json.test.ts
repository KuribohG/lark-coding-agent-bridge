import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../../src/utils/model-json';

describe('parseModelJson', () => {
  it('parses valid and syntax-repaired objects and arrays', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson("```json\n{'a': 1,}\n```")).toEqual({ a: 1 });
    expect(parseModelJson("[{'id':'P0-1', 'ok': true,}]")).toEqual([{ id: 'P0-1', ok: true }]);
    expect(parseModelJson("```json\n[1, 2, 3,]\n```")).toEqual([1, 2, 3]);
  });

  it('rejects incomplete containers, unclosed strings, trailing tokens, and undefined values', () => {
    expect(() => parseModelJson('[{"a": 1')).toThrow(/不完整/);
    expect(() => parseModelJson('{"a": "unterminated')).toThrow(/不完整/);
    expect(() => parseModelJson('{"a": undefined}')).toThrow(/不完整/);
    expect(() => parseModelJson('[1, {"a": NaN}]')).toThrow(/不完整/);
    expect(() => parseModelJson('{"a": 1} {"b": 2}')).toThrow(/不完整/);
    expect(() => parseModelJson('plain text')).toThrow(/不完整/);
  });
});
