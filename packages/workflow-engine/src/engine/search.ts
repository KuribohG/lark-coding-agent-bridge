import { scriptText } from './script-contract';

const QUERY_MAX_TEXT = 200;
const QUERY_MAX_TERMS = 8;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 140;

/** How many archived entries one search reads back at most, newest first. */
export const SEARCH_ARCHIVE_ROWS = 200;

/**
 * The words of a query, lower-cased. An entry matches when every word occurs somewhere in its searched fields, as a
 * substring: words are not tokenized, so identifiers, paths and text without spaces between words all work.
 */
export function searchTerms(query: unknown): string[] {
  const terms = [...new Set(scriptText(query, 'query', QUERY_MAX_TEXT).toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length > QUERY_MAX_TERMS) throw new Error(`query has more than ${QUERY_MAX_TERMS} words`);
  return terms;
}

/** The text a field is searched as: strings as they are, other JSON values serialized. */
export function searchText(value: unknown): string {
  return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}

export interface SearchHit {
  /** How many of the words occur in a leading field; entries that match there rank first. */
  score: number;
  /** The first field that contains a word, and the text around it. */
  field: string;
  snippet: string;
}

/**
 * Matches the words against named fields. The first `leading` fields are the ones that identify the entry (its key
 * and title); a word found there counts towards the score.
 */
export function matchFields(terms: readonly string[], fields: ReadonlyArray<readonly [string, string]>, leading = 0): SearchHit | undefined {
  const lower = fields.map(([, text]) => text.toLowerCase());
  let score = 0, field = -1, at = -1;
  for (const term of terms) {
    const index = lower.findIndex(text => text.includes(term));
    if (index < 0) return undefined;
    if (index < leading) score++;
    if (field < 0 || field < leading && index >= leading) { field = index; at = lower[index]!.indexOf(term); }
  }
  // Lower-casing keeps offsets for almost all text; where it does not, the snippet is only slightly shifted.
  const text = fields[field]![1];
  const from = Math.max(0, at - SNIPPET_BEFORE), to = Math.min(text.length, at + SNIPPET_AFTER);
  const snippet = (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
  return { score, field: fields[field]![0], snippet };
}

/**
 * The words the archive can test in SQL against an entry's stored JSON, as they appear there. A word with a quote or
 * a backslash is stored escaped differently depending on nesting, and SQLite folds the case of ASCII only; such words
 * are left to matchFields, which every candidate passes through anyway.
 */
export function storedTerms(terms: readonly string[]): string[] {
  return terms.filter(term => !/["\\]/.test(term) && [...term].every(char => char.charCodeAt(0) < 128 || char.toUpperCase() === char.toLowerCase()))
    .map(term => JSON.stringify(term).slice(1, -1));
}
