import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist/host');
if (path.relative(root, output) !== path.join('dist', 'host')) throw new Error('Unsafe library output');
const engineRoot = path.join(root, 'packages/workflow-engine');
const engineRequire = createRequire(path.join(engineRoot, 'package.json'));
const esbuild = createRequire(engineRequire.resolve('tsup/package.json'))('esbuild');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const upstreamBaseCommit = process.argv[2] ?? '';
if (!/^[0-9a-f]{40}$/.test(upstreamBaseCommit)) throw new Error('Pass the exact upstream base commit');
const sourceCommit = git(['rev-parse', 'HEAD']);
git(['merge-base', '--is-ancestor', upstreamBaseCommit, sourceCommit]);
const sourceDirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']));
const sourceDateEpoch = Number(git(['show', '-s', '--format=%ct', sourceCommit]));
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const result = await esbuild.build({ absWorkingDir: root,
  entryPoints: { runtime: 'src/host.ts', workflows: 'packages/workflow-engine/src/index.ts' },
  outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, splitting: false, platform: 'node', format: 'esm',
  target: 'node24', sourcemap: false, metafile: true, external: ['better-sqlite3', 'quickjs-emscripten'],
  // Bundled CommonJS packages call require() for Node builtins, which an ES module has to provide.
  banner: { js: "import { createRequire as bundleRequire } from 'node:module';\nconst require = bundleRequire(import.meta.url);" },
  define: { 'process.env.LARK_BUILD_COMMIT': JSON.stringify(sourceCommit),
    'process.env.LARK_BUILD_TIME': JSON.stringify(new Date(sourceDateEpoch * 1000).toISOString()),
    'process.env.LARK_BUILD_DIRTY': JSON.stringify(String(sourceDirty)) },
});
const inputs = {};
const remember = relative => { inputs[relative] = sha(fs.readFileSync(path.join(root, relative))); };
for (const name of Object.keys(result.metafile.inputs)) remember(name.replaceAll('\\', '/'));
for (const name of ['package.json', 'packages/workflow-engine/package.json', 'pnpm-lock.yaml', 'tools/build-host.mjs']) remember(name);
const nativeSource = path.join(root, 'src/agent/dsh/native');
const nativeOutput = path.join(output, 'dsh');
fs.mkdirSync(nativeOutput);
for (const name of fs.readdirSync(nativeSource).sort()) {
  if (!/\.(?:cjs|mjs|json)$/.test(name)) throw new Error('Unexpected native source asset');
  remember(`src/agent/dsh/native/${name}`);
  fs.copyFileSync(path.join(nativeSource, name), path.join(nativeOutput, name));
}

// Only emitted runtime imports seed this dependency closure. In particular no
// Lark/Slack/Web app, optional CLI or build-tool dependency is delivered.
const packages = new Map();
function packageAt(name, owner) {
  const resolver = createRequire(path.join(owner, 'package.json'));
  // A declared npm dependency may share a builtin name (for example bl ->
  // buffer). Query a package subpath so Node returns the owner's search paths
  // instead of the builtin's null lookup paths; still verify the real package.
  for (const directory of resolver.resolve.paths(`${name}/package.json`) || []) {
    const candidate = path.join(directory, name, 'package.json');
    if (fs.existsSync(candidate)) {
      const directory = fs.realpathSync(path.dirname(candidate));
      return { directory, manifest: JSON.parse(fs.readFileSync(candidate, 'utf8')) };
    }
  }
  throw new Error(`Required runtime package missing: ${name}`);
}
function copyPackage(name, owner = engineRoot, optional = false) {
  let selected;
  try { selected = packageAt(name, owner); } catch (error) { if (optional) return; throw error; }
  const { directory, manifest } = selected;
  if (manifest.name !== name) throw new Error('Runtime package identity mismatch');
  if (packages.has(name)) {
    if (packages.get(name).version !== manifest.version) throw new Error(`Conflicting runtime versions: ${name}`);
    return;
  }
  const applies = (values, host) => !values || !values.includes(`!${host}`) && (!values.some(value => !value.startsWith('!')) || values.includes(host));
  if (!applies(manifest.os, process.platform) || !applies(manifest.cpu, process.arch)) {
    if (optional) return;
    throw new Error(`Runtime package does not support this host: ${name}`);
  }
  const target = path.join(output, 'node_modules', name);
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const input = path.join(from, entry.name), destination = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime package contains a link: ${name}/${entry.name}`);
      if (entry.isDirectory()) copy(input, destination);
      else fs.copyFileSync(input, destination);
    }
  };
  copy(directory, target);
  const licenses = fs.readdirSync(target).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  if (!manifest.license || !licenses.length) throw new Error(`Runtime license evidence missing: ${name}`);
  packages.set(name, { name, version: manifest.version, license: manifest.license, licenses });
  for (const dependency of Object.keys(manifest.dependencies || {}).sort()) copyPackage(dependency, directory, false);
  for (const dependency of Object.keys(manifest.optionalDependencies || {}).sort()) copyPackage(dependency, directory, true);
  for (const dependency of Object.keys(manifest.peerDependencies || {}).sort())
    copyPackage(dependency, directory, Boolean(manifest.peerDependenciesMeta?.[dependency]?.optional));
}
const external = new Set();
for (const value of Object.values(result.metafile.outputs)) for (const item of value.imports)
  if (item.external && !item.path.startsWith('node:') && !builtinModules.includes(item.path)) external.add(item.path);
for (const name of [...external].sort()) copyPackage(name);
const files = {};
const collect = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name), relative = path.relative(output, full).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('Build output contains a link');
    if (entry.isDirectory()) collect(full);
    else { const bytes = fs.readFileSync(full); files[relative] = { size: bytes.length, sha256: sha(bytes) }; }
  }
};
collect(output);
const sortedInputs = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)));
const manifest = { schemaVersion: 1, upstreamBaseCommit, resolvedSourceCommit: sourceCommit, sourceDirty,
  sourceFingerprint: sha(JSON.stringify(sortedInputs)), sourceDateEpoch, nodeVersion: process.versions.node,
  nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch,
  esbuildVersion: esbuild.version, inputs: sortedInputs, files, packages: [...packages.values()],
  nativeAddons: Object.keys(files).filter(name => name.endsWith('.node')), wasm: Object.keys(files).filter(name => name.endsWith('.wasm')),
  entries: ['runtime.mjs', 'workflows.mjs'], channelsBundled: false, cliBundled: false };
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ok: true, output, sourceCommit, sourceDirty, sourceFingerprint: manifest.sourceFingerprint,
  files: Object.keys(files).length, packages: packages.size, nativeAddons: manifest.nativeAddons, wasm: manifest.wasm }));
