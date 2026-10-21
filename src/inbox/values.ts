export type Obj = Record<string, unknown>;
export const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export class InboxToolArgumentsError extends Error {}
export { parseModelJson } from '../utils/model-json';
