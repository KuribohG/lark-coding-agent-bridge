import { describe, expect, it } from 'vitest';
import { matchFields, searchTerms, storedTerms } from '../src/engine/search';

describe('searching workflow records', () => {
  it('splits a query into distinct lower-case words', () => {
    expect(searchTerms('  Liveness   对称性 liveness ')).toEqual(['liveness', '对称性']);
    expect(() => searchTerms('   ')).toThrow('nonempty text');
    expect(() => searchTerms('a b c d e f g h i')).toThrow('more than 8 words');
    expect(() => searchTerms(7)).toThrow();
  });

  it('requires every word and ranks by the words found in the leading fields', () => {
    const fields = [['key', 'bug-liveness-symmetry'], ['title', '对称性与活性同时开启时漏报'], ['input', 'Repro: run MCSym.tla with SYMMETRY Perms; TLC reports no violation']] as const;
    expect(matchFields(['liveness', '活性'], fields, 2)).toMatchObject({ score: 2, field: 'key' });
    expect(matchFields(['symmetry', 'mcsym.tla'], fields, 2)).toMatchObject({ score: 1, field: 'input', snippet: fields[2][1] });
    expect(matchFields(['liveness', 'deadlock'], fields, 2)).toBeUndefined();
  });

  it('cuts the snippet around the match', () => {
    const text = 'a'.repeat(300) + ' needle ' + 'b'.repeat(300);
    const hit = matchFields(['needle'], [['text', text]])!;
    expect(hit.snippet).toMatch(/^…a{59} needle b+…$/);
    expect(hit.snippet.length).toBeLessThan(210);
  });

  it('leaves to the matcher the words whose stored form or case folding SQL cannot reproduce', () => {
    expect(storedTerms(['liveness', '活性', 'a"b', 'c\\d', 'émile', 'line\tbreak'])).toEqual(['liveness', '活性', 'line\\tbreak']);
  });
});
