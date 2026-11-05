import { describe, expect, it } from 'vitest';
import { normalizeJsonOutput } from '../src/engine/json-output';

describe('worker JSON output recovery', () => {
  it('accepts strict JSON and the last fenced block after a summary', () => {
    expect(normalizeJsonOutput(' {"a": 1} ')).toBe('{"a":1}');
    expect(normalizeJsonOutput('检查完成。\n\n```json\n{"id":"B6"}\n```')).toBe('{"id":"B6"}');
    expect(normalizeJsonOutput('```\n{"draft":1}\n```\nfinal:\n```json\n[1, 2]\n```')).toBe('[1,2]');
  });

  it('falls back to host repair and rejects unrecoverable output', () => {
    const repair = (text: string) => { if (text !== "{'a': 1,}") throw new SyntaxError('bad'); return { a: 1 }; };
    expect(normalizeJsonOutput("```json\n{'a': 1,}\n```", repair)).toBe('{"a":1}');
    expect(normalizeJsonOutput("{'a': 1,}")).toBeUndefined();
    expect(normalizeJsonOutput('serena-prepare-project --project /repo</parameter>', repair)).toBeUndefined();
  });
});
