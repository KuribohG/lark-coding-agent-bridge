/** Static values embedded in a generated .cmd file, not interactive shell input. */
export function batchLiteral(value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error('unsupported character in Windows launcher value');
  return value.replace(/%/g, '%%');
}

export function batchArgument(value: string): string {
  // Escape trailing backslashes for the native program's argv parser.
  return `"${batchLiteral(value).replace(/\\+$/, '$&$&')}"`;
}

export const BATCH_PREAMBLE = [
  '@echo off',
  'setlocal EnableExtensions DisableDelayedExpansion',
  'chcp 65001 >nul',
];
