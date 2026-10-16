import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAppPaths } from '../config/app-paths';
import { readUiSidecar, type UiSidecar } from '../ui/sidecar';
import { runUi } from './commands/ui';

const actions = ['start', 'fg', 'status', 'stop', 'log', 'ui'] as const;
type Action = typeof actions[number];
export function parseLauncherArgs(args: string[]) {
  let action: Action = 'start', profile: string | undefined, selected = false, help = false, print = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--print') { print = true; continue; }
    if (arg === '--profile') {
      if (profile || !args[i + 1] || args[i + 1]!.startsWith('-')) throw new Error('--profile 需要一个名称');
      profile = args[++i]; continue;
    }
    if (arg === 'claude' || arg === 'codex') {
      if (profile) throw new Error('只能选择一个 profile');
      profile = arg; continue;
    }
    if (actions.includes(arg as Action) && !selected) { action = arg as Action; selected = true; continue; }
    throw new Error(`不支持的参数：${arg}；使用 run-lark-cc --help 查看用法`);
  }
  if (profile) resolveAppPaths({ profile });
  return { action, profile, help, print };
}

/** Authenticate the actual local listener, never trust a stale PID or send tokens to a saved remote URL. */
export async function liveConsole(path: string): Promise<UiSidecar | undefined> {
  const record = await readUiSidecar(path);
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) return;
  try {
    const url = new URL(record.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || Number(url.port) !== record.port) return;
    const response = await fetch(new URL('/api/status', url), {
      headers: { 'x-ui-token': record.token }, redirect: 'error', signal: AbortSignal.timeout(1500),
    });
    const status = await response.json() as { pid?: number; hosted?: boolean };
    if (response.ok && status.hosted && status.pid === record.pid) return record;
  } catch { /* stale or not yet listening */ }
}

export async function runLauncher(args: string[]): Promise<void> {
  const opts = parseLauncherArgs(args);
  if (opts.help) {
    console.log(`run-lark-cc [start|fg|status|stop|log|ui] [claude|codex] [--profile NAME] [--print]

start（默认）  后台启动 Bridge 和本地 GUI，无需 systemd
fg            前台运行（容器可用；Ctrl-C 停止）
ui            打开本地 GUI；--print 仅显示地址
status        查看 GUI 和各 profile 的状态
stop          关闭此配置目录下的整个 GUI supervisor
log           输出启动日志的末尾部分

首次启动在网页中扫码配置；未指定 profile 时沿用当前选择。
claude/codex 只选择启动的 profile；一个 GUI 管理多个 profile。
LARK_CHANNEL_HOME 可指定独立配置目录。后台进程不会跨机器重启自动恢复；
需要开机自启可使用 lark-channel-bridge start --web-ui。
`);
    return;
  }
  const paths = resolveAppPaths();
  const logPath = join(paths.hostLogsDir, 'launcher.log');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const runArgs = [cli, 'run', '--web-ui', ...(opts.profile ? ['--profile', opts.profile] : [])];
  if (opts.action === 'log') {
    const size = (await stat(logPath)).size;
    for await (const chunk of createReadStream(logPath, { start: Math.max(0, size - 64000) })) process.stdout.write(chunk);
    return;
  }
  if (opts.action === 'fg') {
    const child = spawn(process.execPath, runArgs, { stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    return;
  }
  let consoleInfo = await liveConsole(paths.hostUiFile);
  if (opts.action === 'start' && !consoleInfo) {
    await mkdir(paths.hostLogsDir, { recursive: true, mode: 0o700 });
    const log = await open(logPath, 'a', 0o600);
    let exited = false;
    try {
      const child = spawn(process.execPath, runArgs, { detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.once('exit', () => { exited = true; }); child.unref();
    } finally { await log.close(); }
    for (let attempt = 0; attempt < 60; attempt++) {
      consoleInfo = await liveConsole(paths.hostUiFile);
      if (consoleInfo || exited) break;
      await delay(500);
    }
    if (!consoleInfo) throw new Error(`尚未检测到控制台，查看 ${logPath} 或运行 run-lark-cc fg 排查。`);
  }
  if (!consoleInfo) {
    console.log('此配置目录下没有可连接的 GUI supervisor。使用 run-lark-cc 启动；旧的无界面进程可用 lark-channel-bridge ps 查看。');
    if (opts.action !== 'stop') process.exitCode = 1;
    return;
  }
  if (opts.action === 'stop') {
    const response = await fetch(new URL('/api/shutdown', consoleInfo.url), {
      method: 'POST', headers: { 'x-ui-token': consoleInfo.token }, redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`停止失败（HTTP ${response.status}）；检查是否由旧版或系统服务启动。`);
    for (let i = 0; i < 60; i++) {
      if (!await liveConsole(paths.hostUiFile)) { console.log('控制台已关闭。'); return; }
      await delay(500);
    }
    throw new Error('关闭请求已提交，但控制台仍可连接；请查看日志或系统服务状态。');
  }
  if (opts.action === 'status') {
    const response = await fetch(new URL('/api/bots', consoleInfo.url), {
      headers: { 'x-ui-token': consoleInfo.token }, redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`读取状态失败（HTTP ${response.status}）`);
    const body = await response.json() as { bots: { profileName: string; agentKind: string }[] };
    console.log(`GUI 运行中（PID ${consoleInfo.pid}）；在线 profile：${body.bots.map(b => `${b.profileName} (${b.agentKind})`).join(', ') || '无，请在网页完成配置或检查连接'}\n${consoleInfo.url}`);
    return;
  }
  console.log('本地控制台已就绪，机器人连接状态请在页面查看。');
  await runUi({ print: opts.print });
}
