import { validateJsonSchema, type JsonSchema } from './json-schema';

/** Host syntax repair for model output; throws when the text cannot be repaired. */
export type JsonRepair = (text: string) => unknown;

/** Canonical JSON for a worker's final answer, or undefined when it cannot be recovered. */
export function normalizeJsonOutput(text: string, repair?: JsonRepair): string | undefined {
  const candidates = [text.trim()];
  // Models often wrap the answer in a fence, sometimes after a short summary; the last fence is the answer.
  const fences = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi)];
  if (fences.length) candidates.push(fences.at(-1)![1]!.trim());
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
