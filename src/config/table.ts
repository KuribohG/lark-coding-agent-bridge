/**
 * A TOML table. smol-toml >= 1.9 returns null-prototype objects for tables,
 * which are still valid records; accept both shapes here so configuration
 * validation does not depend on the parser's object identity.
 */
export function isTable(value: unknown): value is Record<string, any> {
  if (!value) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
