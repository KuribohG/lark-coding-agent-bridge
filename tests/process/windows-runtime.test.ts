import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTmpProfile } from '../helpers/tmp-profile';
import { buildLauncherCmd } from '../../src/daemon/schtasks';
import { daemonLogDir } from '../../src/daemon/paths';
import { ensureSecretsGetterWrapper } from '../../src/config/store';
import { terminateChild } from '../../src/platform/terminate';
import { paths } from '../../src/config/paths';
import { spawnWithDeadline } from '../../src/agent/deadline';

describe.skipIf(process.platform !== 'win32')('native Windows runtime', () => {
  it('round-trips Unicode and shell metacharacters through the daemon launcher', async () => {
    const tmp = await createTmpProfile('windows-launcher-');
    const previousRoot = paths.rootDir;
    paths.rootDir = tmp.root;
    try {
      const entry = join(tmp.root, 'agent.cjs');
      const record = join(tmp.root, 'record.json');
      await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),home:process.env.LARK_CHANNEL_HOME}));`);
      await mkdir(daemonLogDir('windows-test'), { recursive: true });
      const args = ['--profile', '中文&助手', '%PATH%!', 'a trailing slash\\'];
      const home = join(tmp.root, '中文 & %PATH%!');
      const cmd = join(tmp.root, 'launcher.cmd');
      await writeFile(cmd, buildLauncherCmd({ nodePath: process.execPath, bridgeEntryPath: entry,
        envPath: process.env.PATH ?? '', profile: 'windows-test', runArgs: args, channelHome: home }));
      expect(await runBatch(cmd)).toBe(0);
      expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ args, home });
    } finally { paths.rootDir = previousRoot; await tmp.cleanup(); }
  });

  it('runs the secrets getter wrapper with the correct config root', async () => {
    const tmp = await createTmpProfile('windows-secret-wrapper-');
    try {
      const entry = join(tmp.root, 'entry.cjs');
      const record = join(tmp.root, 'record.json');
      await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),home:process.env.LARK_CHANNEL_HOME}));`);
      const home = join(tmp.root, '中文 & %PATH%!');
      const cmd = await ensureSecretsGetterWrapper({ rootDir: home, secretsGetterScript: join(tmp.root, 'getter') },
        { nodePath: process.execPath, bridgeEntry: entry });
      expect(await runBatch(cmd)).toBe(0);
      expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ args: ['secrets', 'get'], home });
    } finally { await tmp.cleanup(); }
  });

  it.each(['stop', 'deadline'])('cleans up an agent and tool child on %s', async mode => {
    const tmp = await createTmpProfile('windows-tree-');
    let root: ReturnType<typeof spawn> | undefined;
    let toolPid: number | undefined;
    try {
      const entry = join(tmp.root, 'agent.cjs');
      const record = join(tmp.root, 'pid');
      await writeFile(entry, `const tool=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(record)},String(tool.pid));setInterval(()=>{},1000);`);
      const cmd = join(tmp.root, 'agent.cmd');
      await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${entry}"\r\n`);
      root = mode === 'stop'
        ? spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { stdio: 'pipe', windowsHide: true, windowsVerbatimArguments: true })
        : spawnWithDeadline(process.execPath, [entry], { stdio: 'pipe', windowsHide: true }, Date.now() + 5000) as ReturnType<typeof spawn>;
      await vi.waitFor(async () => {
        toolPid = Number(await readFile(record, 'utf8'));
        expect(toolPid).toBeGreaterThan(0);
      }, { timeout: 4000 });
      const closed = new Promise<void>(resolve => root!.once('close', () => resolve()));
      if (mode === 'stop') expect(terminateChild(root)).toBe(true);
      await closed;
      if (mode === 'deadline') expect(root.exitCode).toBe(124);
      expect(() => process.kill(toolPid!, 0)).toThrow();
    } finally {
      if (root && root.exitCode === null) terminateChild(root);
      if (toolPid) { try { process.kill(toolPid, 'SIGKILL'); } catch {} }
      await tmp.cleanup();
    }
  }, 15_000);
});

function runBatch(path: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${path}"`], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.once('error', reject);
    child.once('close', resolve);
  });
}
