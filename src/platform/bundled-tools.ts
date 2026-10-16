import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** npm may nest or hoist dependency bins; pnpm creates them beside this package. */
export function useBundledLarkCli(entryUrl: string, env = process.env): void {
  let folder = dirname(fileURLToPath(entryUrl));
  while (dirname(folder) !== folder) {
    const bin = join(folder, 'node_modules', '.bin');
    const executable = join(bin, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
    if (existsSync(executable)) {
      const parts = (env.PATH ?? '').split(delimiter);
      env.PATH = [bin, ...parts.filter(p => p !== bin)].join(delimiter);
      return;
    }
    folder = dirname(folder);
  }
}
