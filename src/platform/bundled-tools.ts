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
      // The shim resolves `node` through PATH. The self-contained Windows
      // install keeps node.exe in runtime/ rather than on PATH, so expose the
      // running runtime next to the shim or lark-cli cannot start there.
      const runtime = dirname(process.execPath);
      const parts = (env.PATH ?? '').split(delimiter);
      const additions = [...new Set([bin, runtime])];
      env.PATH = [...additions, ...parts.filter(p => !additions.includes(p))].join(delimiter);
      return;
    }
    folder = dirname(folder);
  }
}
