import { jsonrepair } from 'jsonrepair';

export type Obj = Record<string, unknown>;
export const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};

export class InboxToolArgumentsError extends Error {}

/** Repair model syntax only; callers still validate every field before use. */
export function parseModelJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* Fall back only for malformed JSON. */ }
  try { return JSON.parse(jsonrepair(text)); }
  catch { throw new SyntaxError('模型 JSON 格式无效'); }
}
