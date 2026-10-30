import { createRequire } from 'node:module';
import { access, mkdir, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await access(join(project, 'dist/cli.js'));
const argv = process.argv.slice(2);
const output = argv[argv.indexOf('--output') + 1];
if (!argv.includes('--output') || !output || !isAbsolute(output)) throw new Error('Use --output with an absolute directory outside the repository. This opt-in test calls real model services.');
const checkOutside = path => {
  const rel = relative(project, path);
  if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
    throw new Error('Native acceptance artifacts must be outside the repository');
  }
};
checkOutside(resolve(output));
await mkdir(output, { recursive: true, mode: 0o700 });
checkOutside(await realpath(output));
for (const name of ['node_modules', 'bin']) {
  const source = await realpath(join(project, name));
  try { await symlink(source, join(output, name), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST' || await realpath(join(output, name)) !== source) throw error; }
}
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup/package.json'))('esbuild');
const bundle = join(output, 'dist', 'workflow-native.mjs');
await build({ entryPoints: [join(project, 'tests/acceptance/workflow-native.ts')], bundle: true,
  packages: 'external', platform: 'node', format: 'esm', outfile: bundle });
const child = spawn(process.execPath, [bundle, '--project', project, ...argv], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
