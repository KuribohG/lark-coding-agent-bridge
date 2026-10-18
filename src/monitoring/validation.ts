export type Check = (value: unknown, path: string) => void;
export const fail = (path: string, expected: string): never => { throw new Error(`${path}: ${expected}`); };
export const string: Check = (v, p) => { if (typeof v !== 'string') fail(p, '需要字符串'); };
export const boolean: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, '需要 true 或 false'); };
export const integer = (min: number, max: number): Check => (v, p) => {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail(p, `需要 ${min}–${max} 的整数`);
};
export const choice = (...values: string[]): Check => (v, p) => { if (!values.includes(String(v))) fail(p, `可选值：${values.join(', ')}`); };
export const array = (check: Check): Check => (v, p) => {
  if (!Array.isArray(v)) fail(p, '需要数组');
  (v as unknown[]).forEach((item, i) => check(item, `${p}[${i}]`));
};
export const table = (fields: Record<string, Check>): Check => (v, p) => {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype) fail(p, '需要配置表');
  for (const [key, value] of Object.entries(v as object)) {
    if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`, '未知配置项');
    fields[key]!(value, `${p}.${key}`);
  }
};
