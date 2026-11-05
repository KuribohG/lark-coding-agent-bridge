import { platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAppPaths } from '../../config/app-paths';
import { isAlive } from '../../runtime/registry';
import { spawnProcess } from '../../platform/spawn';
import { liveConsole } from '../../ui/sidecar';
import { findOwningServiceForPid } from './ps';

export interface RunUiOptions {
  /** Accepted for compatibility; the console is a single machine-wide process. */
  profile?: string;
  /** Print the URL instead of launching a browser. */
  print?: boolean;
}

/**
 * Open the running supervisor's management console in the browser. The console
 * is hosted by the single supervisor process (one per machine) and advertises
 * its URL + token in a host-level sidecar. If no supervisor is running, guide
 * the user to start one.
 */
export async function runUi(opts: RunUiOptions = {}): Promise<void> {
  const rootDir = process.env.LARK_CHANNEL_HOME;
  const appPaths = resolveAppPaths({ rootDir });

  const sidecar = await liveConsole(appPaths.hostUiFile);
  if (sidecar) {
    if (opts.print) {
      console.log(sidecar.url);
      return;
    }
    console.log(`打开控制台：${sidecar.url}`);
    openBrowser(sidecar.url);
    return;
  }

  console.error(
    [
      '未检测到运行中的控制面。',
      '',
      '控制台需要 supervisor 模式（--web-ui）：',
      '  lark-channel-bridge run --web-ui --detach  # 后台运行 supervisor + 控制台',
      '  lark-channel-bridge run --web-ui           # 前台运行 supervisor + 控制台',
      '  lark-channel-bridge start --web-ui         # 作为登录任务运行 supervisor + 控制台',
      '',
      '（不带 --web-ui 的 run/start 是单 profile 无界面运行，适合无浏览器环境。）',
      '',
      '启动后再次运行 `lark-channel-bridge ui` 打开控制台。',
    ].join('\n'),
  );
  process.exitCode = 1;
}

/**
 * Stop the supervisor behind the live console. The supervisor may be a
 * detached `run --web-ui` process or an OS-managed service; only the former is
 * ours to shut down here, because killing a service process just makes the
 * service manager respawn it on a new pid.
 */
export async function runUiStop(): Promise<void> {
  const appPaths = resolveAppPaths({ rootDir: process.env.LARK_CHANNEL_HOME });
  const sidecar = await liveConsole(appPaths.hostUiFile);
  if (!sidecar) {
    console.log('没有运行中的控制台。');
    return;
  }

  const owner = await findOwningServiceForPid(sidecar.pid);
  if (owner) {
    console.error(`控制台由 ${owner.platformName} 托管，不能用 ui --stop 停止。`);
    console.error(`  停止: ${owner.stopHint}`);
    console.error(`  重启: ${owner.restartHint}`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(new URL('/api/shutdown', sidecar.url), {
    method: 'POST',
    headers: { 'x-ui-token': sidecar.token },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`停止失败（HTTP ${response.status}）；请查看日志或手工结束进程 ${sidecar.pid}。`);
  }
  for (let i = 0; i < 120; i++) {
    if (!isAlive(sidecar.pid)) {
      console.log('控制台已关闭。');
      return;
    }
    await delay(250);
  }
  throw new Error(`停止请求已提交，但进程 ${sidecar.pid} 仍在运行；请查看日志。`);
}

/** Best-effort cross-platform "open this URL in the default browser". */
function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === 'darwin'
      ? ['open', [url]]
      : os === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawnProcess(cmd as string, args as string[], { stdio: 'ignore' });
    child.on('error', () => {
      console.log(`若浏览器未自动打开，请手动访问上面的地址。`);
    });
    child.unref?.();
  } catch {
    console.log('无法自动打开浏览器，请手动访问上面的地址。');
  }
}
