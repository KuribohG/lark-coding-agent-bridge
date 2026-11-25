import { validateJsonSchema, type JsonSchema } from './json-schema';

/** Host syntax repair for model output; throws when the text cannot be repaired. */
export type JsonRepair = (text: string) => unknown;

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && start >= 0) {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (start < 0) start = i;
      depth++;
      continue;
    }
    if ((ch === '}' || ch === ']') && start >= 0) {
      depth--;
      if (depth === 0) {
        candidates.push(text.slice(start, i + 1).trim());
        start = -1;
      } else if (depth < 0) {
        start = -1;
        depth = 0;
      }
    }
  }
  return candidates;
}

/** Canonical JSON for a worker's final answer, or undefined when it cannot be recovered. */
export function normalizeJsonOutput(text: string, repair?: JsonRepair): string | undefined {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: string) => {
    const clean = candidate.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    candidates.push(clean);
  };

  pushCandidate(text);
  // Models often wrap the answer in a fence, sometimes with prose or code fences after it; prefer later fences first.
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) pushCandidate(fences[i]![1]!);
  // Also recover unfenced JSON objects/arrays wrapped in explanatory prose.
  const balanced = extractBalancedJsonCandidates(text);
  for (let i = balanced.length - 1; i >= 0; i--) pushCandidate(balanced[i]!);

  for (const parse of [JSON.parse, ...(repair ? [repair] : [])]) {
    for (const candidate of candidates) {
      try { return JSON.stringify(parse(candidate)); } catch { /* Try the next candidate. */ }
    }
  }
  return undefined;
}

/** The canonical answer, or why it cannot become the script value (unparsable or not matching the schema). */
export function checkJsonOutput(text: string, schema: JsonSchema | undefined, repair?: JsonRepair): { text: string } | { problem: string } {
  const normalized = normalizeJsonOutput(text, repair);
  if (normalized === undefined) return { problem: 'Agent output is not valid JSON' };
  const errors = schema ? validateJsonSchema(schema, JSON.parse(normalized)) : [];
  return errors.length ? { problem: `Agent output does not match schema: ${errors.join('; ')}` } : { text: normalized };
}
