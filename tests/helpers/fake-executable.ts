import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeVersionExecutable(
  root: string,
  name: string,
  version: string,
  marker = '',
): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = join(root, process.platform === 'win32' && !isCmd(name) ? `${name}.CMD` : name);
  await writeVersionExecutableFile(file, version, marker);
  return file;
}

async function writeVersionExecutableFile(
  file: string,
  version: string,
  marker = '',
): Promise<void> {
  if (isCmd(file)) {
    const remark = marker ? `rem ${marker}\r\n` : '';
    await writeFile(file, `@echo off\r\necho ${version}\r\n${remark}`, { mode: 0o755 });
    return;
  }

  const comment = marker ? `// ${marker}\n` : '';
  await writeFile(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n${comment}`, {
    mode: 0o755,
  });
  await chmod(file, 0o755);
}

export async function writeNodeFixtureLauncher(root: string, name: string, script: string): Promise<string> {
  const windows = process.platform === 'win32';
  const file = join(root, name + (windows ? '.cmd' : ''));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = windows
    ? '@echo off\r\n"' + process.execPath.replaceAll('%', '%%') + '" "' + script.replaceAll('%', '%%') + '" %*\r\n'
    : '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n';
  await writeFile(file, command, { mode: 0o700 });
  return file;
}

function isCmd(path: string): boolean {
  return path.toLowerCase().endsWith('.cmd');
}
