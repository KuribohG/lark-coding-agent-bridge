import { normalizeRootConfig } from '../../src/config/profile-store';
import { documentToRoot, formatDocument, parseDocument, rootToDocument } from '../../src/config/document';

/** Existing runtime-object fixtures are serialized through the public TOML format. */
export function encodeFixture(value: any, replacer?: any, space?: string | number): string {
  if (value?.schemaVersion === 2 && value.profiles) return formatDocument(rootToDocument(normalizeRootConfig(value)));
  return JSON.stringify(value, replacer, space);
}
export function decodeFixture(text: string): any {
  return /^\s*[\[{]/.test(text) ? JSON.parse(text) : documentToRoot(parseDocument(text));
}
