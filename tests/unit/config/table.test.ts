import { describe, expect, it } from 'vitest';
import { isTable } from '../../../src/config/table';

describe('TOML table predicate', () => {
  it('accepts plain and null-prototype tables', () => {
    expect(isTable({ a: 1 })).toBe(true);
    expect(isTable(Object.create(null))).toBe(true);
    expect(isTable(Object.assign(Object.create(null), { a: 1 }))).toBe(true);
  });

  it('rejects arrays, primitives and class instances', () => {
    expect(isTable([])).toBe(false);
    expect(isTable(null)).toBe(false);
    expect(isTable(undefined)).toBe(false);
    expect(isTable('a')).toBe(false);
    expect(isTable(new Map())).toBe(false);
  });
});
