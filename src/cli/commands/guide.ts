import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as p from '@clack/prompts';
import { AGENT_KINDS, agentBackendSpec, type AgentKind } from '../../agent/backend-spec';
import { resolveExecutablePath } from '../../agent/detection';
import { locateBinaries, type LocateOptions } from '../../agent/locate';
import { checkAgentVersion } from '../../agent/preflight';
import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { validateLarkNetwork, type LarkNetworkConfig } from '../../config/lark-network';
import type { AccessMode } from '../../config/permissions';
import { loadRootConfig } from '../../config/profile-store';
import type { RootConfig } from '../../config/profile-schema';
import { patchConfig } from '../../config/service';
import { bypassMatcher } from '../../lark-auth/network';
import { modelServiceName, normalizeModelService } from '../../model-service/config';
import { configureModelService } from '../../model-service/registry';
import { writeFileAtomic } from '../../platform/atomic-write';
import { runProfileCreate } from './profile';

interface GuideOptions {
  rootDir?: string;
  /** Print the checklist instead of asking questions. */
  print?: boolean;
}

interface AgentCandidate {
  path: string;
  onPath: boolean;
  /** First line of `--version`, when the executable answered. */
  version?: string;
  error?: string;
}

interface AgentInspection {
  kind: AgentKind;
  displayName: string;
  command: string;
  candidates: AgentCandidate[];
}

const ACCESS_LABELS: Record<AccessMode, { label: string; hint: string }> = {
  full: { label: 'full（完整本机权限）', hint: 'Agent 可读写本账号能访问的任何文件并执行任意命令；个人自用、需要装依赖或跨目录操作时选它' },
  workspace: { label: 'workspace（限工作目录）', hint: '只在项目目录内写文件；让同事或群使用时更稳妥，部分跨目录、联网或安装操作会被拒绝' },
  'read-only': { label: 'read-only（只读）', hint: '只读代码和回答问题，不改文件' },
};

const INSTALL_HINTS: Partial<Record<AgentKind, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};

interface LarkScope { scope: string; purpose: string; optional?: boolean }

/**
 * App-identity scopes a chat bot needs. A QR-created app gets its scopes from the registration
 * template; this list is for checking an app that was created by hand.
 */
const LARK_BOT_SCOPES: readonly LarkScope[] = [
  { scope: 'im:message.p2p_msg:readonly', purpose: '接收用户私聊机器人的消息' },
  { scope: 'im:message.group_at_msg:readonly', purpose: '接收群里 @机器人 的消息' },
  { scope: 'im:message:send_as_bot', purpose: '以机器人身份回复消息和卡片' },
  { scope: 'im:resource', purpose: '读取消息里的图片和文件、上传回复附件' },
  { scope: 'im:chat:readonly', purpose: '读取群名称等群信息' },
  { scope: 'im:message.group_msg', purpose: '接收群里未 @机器人 的消息；只有要"群里免 @"时才需要', optional: true },
];

/** User-identity scopes, only for the inbox assistant reading the user's own messages. */
const LARK_ASSISTANT_USER_SCOPES: readonly string[] = [
  'search:message', 'im:chat:read', 'im:message.p2p_msg:get_as_user', 'im:message.group_msg:get_as_user',
];

/** Developer-console page that applies for the given scopes in one go. */
export function scopeApplyUrl(appId: string, tenant: string | undefined, scopes: readonly string[]): string {
  const host = tenant === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  return `https://${host}/page/scope-apply?clientID=${encodeURIComponent(appId)}&scopes=${encodeURIComponent(scopes.join(','))}`;
}

/** The permission checklist for an app, with a link when the app id is known. */
export function larkPermissionGuide(appId?: string, tenant?: string): string {
  const required = LARK_BOT_SCOPES.filter(item => !item.optional);
  return [
    '权限管理 → 开通以下"应用身份"权限：',
    ...LARK_BOT_SCOPES.map(item => `  ${item.optional ? '○' : '●'} ${item.scope}  ${item.purpose}`),
    ...(appId ? [`一次申请必需项：${scopeApplyUrl(appId, tenant, required.map(item => item.scope))}`] : []),
    '添加应用能力 → 机器人。',
    '事件与回调 → 订阅方式选"长连接"；事件订阅"接收消息 im.message.receive_v1"，回调订阅"卡片回传交互 card.action.trigger"（按钮、表单要用）。',
    '版本管理与发布 → 创建版本并发布；改过权限或事件后都要重新发布，租户要求审批时等审批通过。',
    `会话助理读取你本人的消息时另需用户身份权限：${LARK_ASSISTANT_USER_SCOPES.join('、')}。`,
    '这是基础清单；运行中若日志出现 99991672，报错里带有缺少的权限名和申请链接，照它补开即可。',
  ].join('\n');
}

/** Who may talk to the bot: the app owner alone, people and chats the owner invites, or anyone. */
export type Audience = 'owner' | 'invited' | 'team';

const AUDIENCE_LABELS: Record<Audience, string> = {
  owner: '只有我自己',
  invited: '我和我指定的同事、群',
  team: '团队里任何人',
};

/**
 * How dangerous an audience is with full machine access: `confirm` when anyone in the tenant
 * could run commands as this account, `warn` when invited people could.
 */
export function audienceRisk(audience: Audience, access: AccessMode): 'confirm' | 'warn' | undefined {
  if (access !== 'full' || audience === 'owner') return undefined;
  return audience === 'team' ? 'confirm' : 'warn';
}

type ModelCredentialMode = 'env' | 'service' | 'none';

/** How a third-party API endpoint and token reach this agent. */
export function modelCredentialMode(kind: AgentKind): ModelCredentialMode {
  if (kind === 'claude') return 'env';
  return agentBackendSpec(kind).providerBindings.responses ? 'service' : 'none';
}

/**
 * Launch environment that points Claude Code at an Anthropic-compatible gateway.
 * Without a token the value refers to the Bridge's own ANTHROPIC_AUTH_TOKEN.
 */
export function claudeGatewayEnv(input: { baseUrl: string; token?: string; model?: string }): Record<string, string> {
  // Launch env values expand $NAME references, so a literal `$` has to be doubled.
  const literal = (value: string) => value.replaceAll('$', '$$$$');
  return {
    ANTHROPIC_BASE_URL: literal(input.baseUrl),
    ANTHROPIC_AUTH_TOKEN: input.token ? literal(input.token) : '${ANTHROPIC_AUTH_TOKEN}',
    ...(input.model ? { ANTHROPIC_MODEL: literal(input.model) } : {}),
  };
}

interface ModelServicePlan { name: string; baseUrl: string; model: string; token: string }

interface ProxyVariable { name: string; value: string }
interface ProxyEnvironment { http?: ProxyVariable; https?: ProxyVariable; all?: ProxyVariable; noProxy?: ProxyVariable }

/** Proxy variables of an environment; a nonempty lowercase name wins, as it does for the Lark transport. */
export function detectProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnvironment {
  const pick = (lower: string): ProxyVariable | undefined => {
    for (const name of [lower, lower.toUpperCase()]) {
      const value = env[name];
      if (value) return { name, value };
    }
    return undefined;
  };
  return { http: pick('http_proxy'), https: pick('https_proxy'), all: pick('all_proxy'), noProxy: pick('no_proxy') };
}

export type ProxyChoice =
  | { mode: 'inherit'; detected: ProxyEnvironment; /** Replaces the detected NO_PROXY. */ noProxy?: string }
  | { mode: 'manual'; proxy: string; noProxy: string }
  | { mode: 'direct'; detected: ProxyEnvironment };

interface ProxyPlan {
  /** Proxy variables for the agent process and its tool subprocesses. */
  launchEnv: Record<string, string>;
  /** The profile's Feishu/Lark network table, when it has to differ from the default. */
  network?: LarkNetworkConfig;
  /** Variables the Bridge must be started with, because the proxy URL carries credentials and is not stored. */
  envReferences: string[];
  warnings: string[];
}

/**
 * What a proxy choice writes. A service manager starts the Bridge without the shell's proxy
 * variables, so values are stored rather than referenced, except URLs that carry credentials.
 */
export function proxyPlan(choice: ProxyChoice): ProxyPlan {
  const literal = (value: string) => value.replaceAll('$', '$$$$');
  const plan: ProxyPlan = { launchEnv: {}, envReferences: [], warnings: [] };
  if (choice.mode === 'manual') {
    // The agent environment is merged case-insensitively, so each variable can be set under one
    // name only; lowercase is the one curl and wget also read.
    plan.launchEnv = {
      http_proxy: literal(choice.proxy),
      https_proxy: literal(choice.proxy),
      ...(choice.noProxy ? { no_proxy: literal(choice.noProxy) } : {}),
    };
    plan.network = { proxy: choice.proxy, ...(choice.noProxy ? { no_proxy: choice.noProxy } : {}) };
    return plan;
  }
  const { detected } = choice;
  const proxies = [detected.http, detected.https, detected.all].filter((item): item is ProxyVariable => Boolean(item));
  if (!proxies.length) return plan;
  if (choice.mode === 'direct') {
    for (const variable of proxies) plan.launchEnv[variable.name] = '';
    plan.network = { proxy: 'direct' };
    return plan;
  }
  for (const variable of proxies) {
    const stored = !hasCredentials(variable.value);
    plan.launchEnv[variable.name] = stored ? literal(variable.value) : `\${${variable.name}}`;
    if (!stored) plan.envReferences.push(variable.name);
  }
  const noProxy = choice.noProxy ?? detected.noProxy?.value;
  if (noProxy !== undefined) plan.launchEnv[detected.noProxy?.name ?? 'no_proxy'] = literal(noProxy);
  const bypass = noProxy !== undefined ? { no_proxy: noProxy } : {};
  // The Lark transport is HTTPS and WebSocket only; it falls back the same way.
  const lark = (detected.https ?? detected.http ?? detected.all)!;
  if (hasCredentials(lark.value)) {
    // The config refuses proxy credentials; the default `proxy = "env"` keeps reading the variable.
    plan.network = noProxy !== undefined ? bypass : undefined;
    plan.warnings.push(`代理地址带账号密码，不写入配置：飞书连接和 Agent 都改为读取环境变量 ${plan.envReferences.join('、')}。`);
    return plan;
  }
  try {
    validateLarkNetwork({ proxy: lark.value });
    plan.network = { proxy: lark.value, ...bypass };
  } catch {
    plan.network = noProxy !== undefined ? bypass : undefined;
    plan.warnings.push(`飞书连接只支持 http(s):// 代理，不支持 SOCKS 或 PAC，${lark.name}=${lark.value} 用不了；` +
      '创建 profile 后请为飞书单独指定代理或直连，否则 Bridge 启动会报错。');
  }
  return plan;
}

/** Whether a request to `url` is proxied under the given NO_PROXY rules. */
export function goesThroughProxy(url: string, noProxy: string | undefined): boolean {
  try { return !bypassMatcher(noProxy ?? '')(new URL(url)); } catch { return false; }
}

function hasCredentials(proxy: string): boolean {
  try {
    const url = new URL(proxy);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function shorten(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A proxy URL for display, without its password. */
function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (!url.password) return proxy;
    url.password = '***';
    return url.toString().replace(/\/$/, '');
  } catch {
    return proxy;
  }
}

const ALL_ACCESS: readonly AccessMode[] = ['full', 'workspace', 'read-only'];

/** Access levels a profile of this agent can be created with, widest first. */
export function accessChoices(kind: AgentKind): AccessMode[] {
  const supported = agentBackendSpec(kind).supportedAccess;
  return ALL_ACCESS.filter(access => !supported || supported.includes(access));
}

/** How the user invoked this CLI, so printed follow-up commands can be pasted back as is. */
export function cliCommand(argv: readonly string[] = process.argv): string {
  const script = argv[1] ?? '';
  return /\.(?:mjs|cjs|js)$/.test(script) ? `node ${script}` : 'lark-channel-bridge';
}

/** Find every install of every supported agent and ask each one for its version. */
export async function inspectAgents(opts: LocateOptions = {}): Promise<AgentInspection[]> {
  const env = opts.env ?? process.env;
  return Promise.all(AGENT_KINDS.map(async (kind) => {
    const spec = agentBackendSpec(kind);
    const command = env[spec.commandEnv] ?? spec.defaultCommand;
    const located = isAbsolute(command)
      ? [{ path: command, onPath: false }]
      : await locateBinaries(command, opts);
    const candidates = await Promise.all(located.map(async (binary): Promise<AgentCandidate> => {
      try {
        const version = await checkAgentVersion({
          agentId: kind,
          agentName: spec.displayName,
          command,
          binaryPath: binary.path,
          timeoutMs: 10_000,
        });
        return { path: binary.path, onPath: binary.onPath, version };
      } catch (err) {
        return { path: binary.path, onPath: binary.onPath, error: err instanceof Error ? err.message : String(err) };
      }
    }));
    return { kind, displayName: spec.displayName, command, candidates };
  }));
}

/** The same walkthrough as a static checklist, for non-interactive shells and docs. */
export function guideText(cli = cliCommand()): string {
  return [
    'Bridge 配置指引（非交互版；在终端里直接运行 guide 可逐步引导并自动写入配置）',
    '',
    '1. 找到 Agent 的可执行文件',
    '   which claude codex            # 都没有输出时，再看 ~/.local/bin、~/.npm-global/bin、~/.nvm/versions/node/*/bin',
    '   <路径> --version              # 能输出版本才算可执行',
    '   用运行 Bridge 的同一账号直接启动一次 Agent，完成登录并对话一次；版本检查不能证明模型可用。',
    '',
    '2. 选择权限（Agent 能对本机做什么）',
    '   full       完整本机权限，个人自用的默认值',
    '   workspace  只在工作目录内写文件，适合开放给同事或群',
    '   read-only  只读',
    '',
    '3. 谁能用机器人',
    '   默认只有应用 owner（创建应用的人）；机器人启动后在飞书里发 /invite user @同事 或 /invite group 逐个开放。',
    `   团队里任何人 @ 即可用：${cli} config set profiles.<名称>.mode team   # 不设白名单，机器人只用应用身份访问飞书`,
    '   对所有人开放时权限建议用 workspace：full 意味着任何能找到机器人的人都能在本机以你的账号执行任意命令。',
    '',
    '4. 模型凭据（用官方登录可跳过）',
    '   Claude Code 接第三方网关：给 profile 的 launch.env 设 ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN；',
    '   值写 "${ANTHROPIC_AUTH_TOKEN}" 表示引用启动 Bridge 时的环境变量，token 不进配置文件。',
    '   Codex / Pi 接第三方 Responses 网关：把 token 存成只有自己可读的文件，再登记为模型服务：',
    `   ${cli} model-service configure <服务名> service.json   # {"protocol":"responses","baseUrl":"https://…/v1","model":"…","apiKey":{"source":"file","id":"/绝对路径"}}`,
    '',
    '5. 网络代理（机器访问飞书或模型要走代理时；创建 profile 后执行）',
    '   前台运行时飞书连接读取 shell 里的 HTTPS_PROXY / HTTP_PROXY / NO_PROXY；注册为系统服务后进程不带这些变量，要写进配置：',
    `   ${cli} config set channels.lark.profiles.<名称>.network.proxy http://proxy:3128    # 只支持 HTTP(S) 代理，地址里不带账号密码`,
    `   ${cli} config set channels.lark.profiles.<名称>.network.no_proxy localhost,127.0.0.1,.internal`,
    '   Agent 进程访问模型、安装依赖用的代理写在 profile 的 launch.env（https_proxy、http_proxy、no_proxy）；内网模型网关的主机要放进 no_proxy。',
    '',
    '6. 配置飞书并创建 profile',
    `   ${cli} profile create <名称> --agent <claude|codex> --workspace <项目目录>`,
    '   不带 --app-id 时在终端显示二维码，用飞书扫码创建应用；已有应用则加 --app-id cli_xxx（Secret 按提示输入）。',
    '   已有应用在飞书开放平台（open.feishu.cn/app，国际版 open.larksuite.com/app）逐项确认：',
    ...larkPermissionGuide().split('\n').map(line => `   ${line}`),
    `   之后调整：${cli} config set profiles.<名称>.permissions.maxAccess workspace`,
    '',
    '7. 启动与验收',
    `   ${cli} run --profile <名称>      # 前台运行，Ctrl+C 停止`,
    `   ${cli} start --profile <名称>    # 注册为系统服务常驻`,
    '   私聊机器人发送 /status，再发一个简单任务；群里需先拉机器人入群并用 @选择器真正提及它。',
  ].join('\n');
}

export async function runGuide(opts: GuideOptions = {}): Promise<void> {
  if (opts.print || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(guideText());
    return;
  }
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const cli = cliCommand();

  p.intro('Bridge 配置向导：Agent 位置 → 权限 → 使用范围 → 模型凭据 → 网络代理 → 飞书应用与权限');
  const root = await loadRootConfig(configFile);
  p.log.info(`Node ${process.version}，配置文件 ${configFile}${root ? '' : '（尚不存在，完成向导后创建）'}`);

  const spinner = p.spinner();
  spinner.start('查找本机的 Agent');
  const inspections = await inspectAgents();
  spinner.stop('Agent 查找完成');
  p.note(formatInspections(inspections), '找到的 Agent');

  if (root && Object.keys(root.profiles).length > 0) {
    p.note(formatProfiles(root), '已有 profile');
    const more = ask(await p.confirm({ message: '要再新建一个 profile 吗？', initialValue: false }));
    if (!more) {
      p.outro(`未做修改。调整现有 profile 用 ${cli} config set，查看用 ${cli} config show --profile <名称>。`);
      return;
    }
  }

  // Step 1: which agent, and which executable.
  const kind = ask(await p.select<AgentKind>({
    message: '第 1 步：用哪个 Agent？',
    options: inspections.map(item => ({
      value: item.kind,
      label: item.displayName,
      hint: usable(item).length ? usable(item)[0]!.path : '未找到，可手动填路径',
    })),
    initialValue: inspections.find(item => usable(item).length)?.kind ?? inspections[0]!.kind,
  }));
  const inspection = inspections.find(item => item.kind === kind)!;
  const binaryPath = await chooseBinary(inspection);
  p.log.warn(`请确认已用当前账号（${process.env.USER ?? 'this user'}）直接运行过 ${binaryPath} 并完成登录；版本检查不能证明模型可用。`);

  // Step 2: what the agent may do on this machine.
  const choices = accessChoices(kind);
  let access = choices.length === 1 ? choices[0]! : ask(await p.select<AccessMode>({
    message: '第 2 步：Agent 能对本机做什么？',
    options: choices.map(value => ({ value, ...ACCESS_LABELS[value] })),
    initialValue: choices[0]!,
  }));
  if (choices.length === 1) p.log.info(`${inspection.displayName} 只支持 ${access} 权限。`);

  // Step 3: who may talk to the bot.
  let audience = ask(await p.select<Audience>({
    message: '第 3 步：谁能用这个机器人？',
    options: [
      { value: 'owner', label: AUDIENCE_LABELS.owner, hint: '默认；之后可在飞书里发 /invite 逐个开放' },
      { value: 'invited', label: AUDIENCE_LABELS.invited, hint: '机器人启动后在飞书里发 /invite user @同事 或 /invite group' },
      { value: 'team', label: `${AUDIENCE_LABELS.team} @ 它都能用`, hint: '不设白名单；机器人只用应用身份访问飞书，不带你的个人授权' },
    ],
  }));
  const risk = audienceRisk(audience, access);
  if (risk === 'warn') {
    p.log.warn('你邀请的同事和群也能让 Agent 以完整本机权限执行命令；只需要改项目内文件时，结束后把权限改成 workspace 更稳妥。');
  } else if (risk === 'confirm' && choices.includes('workspace')) {
    access = ask(await p.select<AccessMode>({
      message: '任何能找到机器人的人都能让 Agent 在这台机器上以你的账号执行任意命令。本机权限怎么定？',
      options: [
        { value: 'workspace', label: '降为 workspace（推荐）', hint: '只在项目目录内写文件' },
        { value: 'full', label: '保留 full', hint: '我清楚风险' },
      ],
    }));
  } else if (risk === 'confirm') {
    const proceed = ask(await p.confirm({
      message: `${inspection.displayName} 只支持 full 权限：任何能找到机器人的人都能在这台机器上以你的账号执行任意命令。仍然对所有人开放？`,
      initialValue: false,
    }));
    if (!proceed) {
      audience = 'owner';
      p.log.info('改为只有你自己能用；之后可在飞书里发 /invite 逐个开放。');
    }
  }

  // Step 4: where it works, and what the profile is called.
  const workspaceInput = ask(await p.text({
    message: '第 4 步：项目目录（留空则使用 Bridge 自动创建的默认目录）',
    placeholder: resolve(homedir(), 'code/my-project'),
    defaultValue: '',
  }));
  const workspace = workspaceInput.trim() ? expandHome(workspaceInput.trim()) : undefined;
  const name = ask(await p.text({
    message: 'profile 名称（一个机器人对应一个 profile）',
    initialValue: root?.profiles[kind] ? '' : kind,
    validate: (value) => {
      const trimmed = (value ?? '').trim();
      if (!trimmed) return '名称不能为空';
      if (/[\u0000-\u001f\s/\\:*?"<>|]/.test(trimmed) || trimmed === '.' || trimmed === '..') return '名称不能含空白、路径分隔符或 : * ? " < > |';
      if (root?.profiles[trimmed]) return `profile ${trimmed} 已存在`;
      return undefined;
    },
  })).trim();

  // Step 5: how the agent reaches its model.
  const credentials = await chooseModelCredentials(inspection, root);

  // Step 6: how this machine reaches Feishu and the model.
  const proxy = await chooseProxy(credentials.gatewayUrl);

  // Step 7: the Lark/Feishu app.
  const appMode = ask(await p.select<'qr' | 'existing'>({
    message: '第 7 步：飞书应用',
    options: [
      { value: 'qr', label: '扫码创建新应用（推荐）', hint: '终端显示二维码，用飞书 App 扫码创建应用' },
      { value: 'existing', label: '使用已有应用', hint: '需要 App ID 和 App Secret' },
    ],
  }));
  let appId: string | undefined;
  let tenant: string | undefined;
  if (appMode === 'existing') {
    appId = ask(await p.text({
      message: 'App ID',
      placeholder: 'cli_xxxxxxxxxxxxxxxx',
      validate: value => ((value ?? '').trim() ? undefined : 'App ID 不能为空'),
    })).trim();
    tenant = ask(await p.select<string>({
      message: '租户类型',
      options: [{ value: 'feishu', label: '飞书（feishu.cn）' }, { value: 'lark', label: 'Lark 国际版（larksuite.com）' }],
    }));
    p.note(larkPermissionGuide(), `在开放平台确认应用 ${appId}（App Secret 在"凭证与基础信息"页）`);
    // Printed bare: a link wrapped inside the note box cannot be copied in one piece.
    console.log(`一次申请必需权限：\n${scopeApplyUrl(appId, tenant, LARK_BOT_SCOPES.filter(item => !item.optional).map(item => item.scope))}\n`);
    if (audience !== 'team') {
      p.log.warn('聊天默认只对应用的 owner（创建者）开放。应用不是你创建的话，你自己也用不了：让创建者在飞书里发 /invite user @你，或改用扫码新建。');
    }
    ask(await p.confirm({ message: '以上已配置并发布？（没配完也可以继续，之后补上再重启 profile）', initialValue: true }));
  }

  const envReferences = [...(credentials.envReference ? [credentials.envReference] : []), ...proxy.envReferences];
  p.log.step(`创建 profile ${name}：${inspection.displayName} @ ${binaryPath}，权限 ${access}，使用范围 ${AUDIENCE_LABELS[audience]}，目录 ${workspace ?? '默认'}`);
  await runProfileCreate(name, {
    rootDir,
    agent: kind,
    workspace,
    binaryPath,
    permissions: { defaultAccess: access, maxAccess: access },
    ...(audience === 'team' ? { mode: 'team' as const } : {}),
    launchEnv: { ...credentials.launchEnv, ...proxy.launchEnv },
    appId,
    tenant,
  });
  if (proxy.network) {
    await patchConfig(configFile, ['channels', 'lark', 'profiles', name, 'network'], proxy.network);
  }
  if (credentials.service) {
    const keyFile = await saveModelService(rootDir, configFile, credentials.service);
    p.log.success(`模型服务 ${credentials.service.name} 已登记，token 保存在 ${keyFile}（仅本账号可读）`);
  }
  if (appMode === 'qr') {
    p.note([
      '扫码创建的应用已按模板带上机器人能力、长连接事件和基础权限。之后可能要补的：',
      ...LARK_BOT_SCOPES.filter(item => item.optional).map(item => `  ○ ${item.scope}  ${item.purpose}`),
      `  ○ 会话助理（用户身份）：${LARK_ASSISTANT_USER_SCOPES.join('、')}`,
      '补权限在开放平台"权限管理"里开通后重新发布版本；日志出现 99991672 时报错里带有缺少的权限名和申请链接。',
    ].join('\n'), '飞书权限');
  }

  p.note([
    `前台运行：${cli} run --profile ${name}`,
    `常驻服务：${cli} start --profile ${name}`,
    '',
    '验收：私聊机器人发送 /status，再发"说明当前项目，先不要修改文件"，收到回复才算打通。',
    '群聊：先把机器人拉进群，用 @选择器真正提及它；纯文本"@机器人"收不到。',
    audience === 'team'
      ? `使用范围：任何人私聊或在群里 @ 机器人即可使用，管理类命令仍只有 owner 和管理员能用；改回仅自己：${cli} config set profiles.${name}.mode personal`
      : audience === 'invited'
        ? '开放给同事和群：机器人启动后，由你（应用 owner）在飞书里发 /invite user @同事 或 /invite group；没邀请的人发消息不会有回应。'
        : '开放给他人：聊天默认只对应用 owner 开放，在飞书里发 /invite user @同事 或 /invite group。',
    '应用侧：租户要求时，在飞书开放平台完成可用范围、权限和发布审批。',
    `改权限：${cli} config set profiles.${name}.permissions.maxAccess <full|workspace|read-only>`,
    `改代理：${cli} config set channels.lark.profiles.${name}.network.proxy <http://主机:端口|env|direct>（飞书连接）；Agent 进程的代理变量在 profile 的 launch.env 里。`,
    ...(envReferences.length ? [`启动 Bridge 的环境里必须有 ${envReferences.join('、')}：前台运行前先在同一个 shell 里 export；注册为系统服务时要写进服务的环境。`] : []),
  ].join('\n'), '下一步');
  p.outro(`配置已写入 ${configFile}`);
}

interface ModelCredentials {
  launchEnv?: Record<string, string>;
  service?: ModelServicePlan;
  /** Third-party endpoint the agent will call, for the proxy step to route. */
  gatewayUrl?: string;
  /** Environment variable the Bridge must be started with. */
  envReference?: string;
}

async function chooseModelCredentials(inspection: AgentInspection, root: RootConfig | null | undefined): Promise<ModelCredentials> {
  const mode = modelCredentialMode(inspection.kind);
  if (mode === 'none') {
    p.log.info(`第 5 步：${inspection.displayName} 的模型凭据由它自己的登录或 provider 配置管理，向导不改动（Antigravity 见 docs/antigravity.md）。`);
    return {};
  }
  const source = ask(await p.select<'native' | 'gateway'>({
    message: '第 5 步：模型凭据',
    options: [
      { value: 'native', label: `沿用 ${inspection.displayName} 自己的登录或已有配置`, hint: '官方账号登录，或已在它的配置里设好 provider' },
      { value: 'gateway', label: '第三方 API 网关（地址 + token）', hint: mode === 'env' ? 'Anthropic 兼容接口' : 'Responses 兼容接口' },
    ],
  }));
  if (source === 'native') return {};

  if (mode === 'env') {
    const baseUrl = ask(await p.text({
      message: '网关地址（ANTHROPIC_BASE_URL）',
      placeholder: 'https://gateway.example.com',
      validate: value => (/^https?:\/\/\S+$/.test((value ?? '').trim()) ? undefined : '需要 http(s):// 开头的地址'),
    })).trim();
    const storage = ask(await p.select<'config' | 'env'>({
      message: 'token 放在哪里？',
      options: [
        { value: 'config', label: '写入 config.toml', hint: '明文保存，文件权限 600；前台运行和系统服务都直接可用' },
        { value: 'env', label: '引用环境变量 ANTHROPIC_AUTH_TOKEN', hint: 'token 不落盘，但每次启动 Bridge 前要自己 export' },
      ],
    }));
    const token = storage === 'config'
      ? ask(await p.password({ message: 'API token（ANTHROPIC_AUTH_TOKEN，输入不回显）', validate: value => ((value ?? '').trim() ? undefined : 'token 不能为空') })).trim()
      : undefined;
    if (storage === 'env' && !process.env.ANTHROPIC_AUTH_TOKEN) {
      p.log.warn('当前 shell 没有 ANTHROPIC_AUTH_TOKEN；启动 Bridge 时缺少它，Agent 会启动失败。');
    }
    const model = ask(await p.text({ message: '默认模型 ID（留空由 Claude Code 决定，之后可在飞书里 /model 切换）', defaultValue: '' })).trim();
    return {
      launchEnv: claudeGatewayEnv({ baseUrl, token, model: model || undefined }),
      gatewayUrl: baseUrl,
      ...(storage === 'env' ? { envReference: 'ANTHROPIC_AUTH_TOKEN' } : {}),
    };
  }

  const existing = root?.modelServices ?? {};
  const name = ask(await p.text({
    message: '给这个模型服务起个名字（在 /model <名字>/<模型> 里使用）',
    initialValue: existing.gateway ? '' : 'gateway',
    validate: (value) => {
      const trimmed = (value ?? '').trim();
      try { modelServiceName(trimmed); } catch (err) { return err instanceof Error ? err.message : String(err); }
      return existing[trimmed] ? `模型服务 ${trimmed} 已存在` : undefined;
    },
  })).trim();
  const baseUrl = ask(await p.text({
    message: 'API 根地址（不带 /responses）',
    placeholder: 'https://gateway.example.com/v1',
    validate: value => serviceError({ baseUrl: (value ?? '').trim(), model: 'm' }),
  })).trim();
  const model = ask(await p.text({
    message: '默认模型 ID',
    validate: value => serviceError({ baseUrl, model: (value ?? '').trim() }),
  })).trim();
  const token = ask(await p.password({ message: 'API token（输入不回显）', validate: value => ((value ?? '').trim() ? undefined : 'token 不能为空') })).trim();
  if (Object.keys(existing).length) {
    p.log.warn('已有其他模型服务：Codex 需要用 launch.provider 指明用哪一个，见 docs/model-services.md。');
  }
  return { service: { name, baseUrl, model, token }, gatewayUrl: baseUrl };
}

async function chooseProxy(gatewayUrl: string | undefined): Promise<ProxyPlan> {
  const detected = detectProxyEnv();
  const found = [detected.http, detected.https, detected.all, detected.noProxy].filter((item): item is ProxyVariable => Boolean(item));
  const hasProxy = Boolean(detected.http ?? detected.https ?? detected.all);
  const mode = ask(await p.select<ProxyChoice['mode']>({
    message: '第 6 步：网络代理（访问飞书和模型时使用；系统服务不带 shell 里的代理变量，所以选定后写进配置）',
    options: [
      ...(hasProxy ? [{
        value: 'inherit' as const,
        label: '沿用当前 shell 的代理',
        hint: found.map(item => `${item.name}=${shorten(redactProxy(item.value))}`).join('  '),
      }] : []),
      { value: 'direct' as const, label: '不用代理，直连', hint: hasProxy ? '忽略当前 shell 的代理变量' : '当前 shell 没有设置代理变量' },
      { value: 'manual' as const, label: '手动填写', hint: 'HTTP(S) 代理地址' },
    ],
    initialValue: hasProxy ? 'inherit' : 'direct',
  }));

  let manualProxy = '';
  let noProxy = detected.noProxy?.value;
  if (mode === 'manual') {
    manualProxy = ask(await p.text({
      message: '代理地址',
      placeholder: 'http://proxy.example.com:3128',
      validate: (value) => {
        const trimmed = (value ?? '').trim();
        try {
          if (trimmed === 'env' || trimmed === 'direct') throw new Error();
          validateLarkNetwork({ proxy: trimmed });
          return undefined;
        } catch {
          return '需要 http(s)://主机:端口，不带路径和账号密码；带账号密码的代理请先在 shell 里 export，再选"沿用"';
        }
      },
    })).trim();
    noProxy = (ask(await p.text({
      message: '不走代理的地址（NO_PROXY，逗号分隔，可清空）',
      initialValue: detected.noProxy?.value ?? 'localhost,127.0.0.1',
      defaultValue: '',
    })) ?? '').trim();
  }
  if (mode !== 'direct' && gatewayUrl && goesThroughProxy(gatewayUrl, noProxy)) {
    const host = new URL(gatewayUrl).hostname;
    const route = ask(await p.select<'proxy' | 'bypass'>({
      message: `模型网关 ${host} 怎么访问？`,
      options: [
        { value: 'proxy', label: '经代理', hint: '公网网关' },
        { value: 'bypass', label: '直连（加入 NO_PROXY）', hint: '内网网关通常不能走代理' },
      ],
    }));
    if (route === 'bypass') noProxy = [noProxy, host].filter(Boolean).join(',');
  }

  const plan = proxyPlan(mode === 'manual' ? { mode, proxy: manualProxy, noProxy: noProxy ?? '' }
    : mode === 'inherit' ? { mode, detected, ...(noProxy !== detected.noProxy?.value ? { noProxy } : {}) }
      : { mode, detected });
  for (const warning of plan.warnings) p.log.warn(warning);

  // The app is registered and checked from this process; give it the network the profile will use.
  if (mode !== 'inherit') {
    for (const name of ['http_proxy', 'https_proxy', 'all_proxy']) {
      delete process.env[name];
      delete process.env[name.toUpperCase()];
    }
  }
  if (mode === 'manual') {
    process.env.http_proxy = manualProxy;
    process.env.https_proxy = manualProxy;
  }
  if (mode !== 'direct' && noProxy !== undefined) {
    delete process.env.NO_PROXY;
    process.env.no_proxy = noProxy;
  }
  return plan;
}

function serviceError(input: { baseUrl: string; model: string }): string | undefined {
  try {
    normalizeModelService({ protocol: 'responses', ...input, apiKey: { source: 'file', id: '/placeholder' } });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Store the token in a private file under the config root and register the service that refers to it. */
export async function saveModelService(rootDir: string, configFile: string, plan: ModelServicePlan): Promise<string> {
  const keyFile = join(resolve(rootDir), 'model-keys', `${plan.name}.key`);
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  await writeFileAtomic(keyFile, `${plan.token}\n`, { mode: 0o600 });
  await configureModelService(configFile, plan.name, {
    protocol: 'responses',
    baseUrl: plan.baseUrl,
    model: plan.model,
    apiKey: { source: 'file', id: keyFile },
  });
  return keyFile;
}

async function chooseBinary(inspection: AgentInspection): Promise<string> {
  const MANUAL = '\0manual';
  const good = usable(inspection);
  if (!good.length) {
    const hint = INSTALL_HINTS[inspection.kind];
    p.log.warn(`没有找到可用的 ${inspection.displayName}（命令 ${inspection.command}）。` +
      (hint ? `尚未安装可执行：${hint}。` : '') +
      '已安装但不在 PATH 里时，在装它的那个 shell 里运行 `command -v ' + inspection.command + '` 得到路径后填在下面。');
  }
  const picked = good.length
    ? ask(await p.select<string>({
        message: `用哪一个 ${inspection.displayName}？`,
        options: [
          ...good.map(candidate => ({
            value: candidate.path,
            label: candidate.path,
            hint: `${candidate.version}${candidate.onPath ? '' : '，不在当前 PATH 中'}`,
          })),
          { value: MANUAL, label: '手动输入路径' },
        ],
      }))
    : MANUAL;
  if (picked !== MANUAL) return picked;

  for (;;) {
    const input = ask(await p.text({
      message: `${inspection.displayName} 可执行文件的路径`,
      placeholder: resolve(homedir(), '.local/bin', inspection.command),
      validate: value => ((value ?? '').trim() ? undefined : '路径不能为空'),
    }));
    const candidate = resolve(expandHome(input.trim()));
    try {
      await resolveExecutablePath(candidate);
      const version = await checkAgentVersion({
        agentId: inspection.kind,
        agentName: inspection.displayName,
        command: inspection.command,
        binaryPath: candidate,
        timeoutMs: 10_000,
      });
      p.log.success(`${candidate}：${version}`);
      return candidate;
    } catch (err) {
      p.log.error(`${candidate} 不可用：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function usable(inspection: AgentInspection): AgentCandidate[] {
  return inspection.candidates.filter(candidate => candidate.version);
}

function formatInspections(inspections: AgentInspection[]): string {
  return inspections.map((item) => {
    if (!item.candidates.length) return `${item.displayName}：未找到（命令 ${item.command}）`;
    return [
      `${item.displayName}：`,
      ...item.candidates.map(candidate => candidate.version
        ? `  ✓ ${candidate.path}  ${candidate.version}${candidate.onPath ? '' : '  （不在 PATH 中）'}`
        : `  ✗ ${candidate.path}  无法运行：${firstLine(candidate.error)}`),
    ].join('\n');
  }).join('\n');
}

function formatProfiles(root: RootConfig): string {
  return Object.entries(root.profiles).map(([name, profile]) => {
    const launch = profile[profile.agentKind] as { binaryPath?: string } | undefined;
    const binary = launch?.binaryPath ?? `${agentBackendSpec(profile.agentKind).defaultCommand}（按 PATH 查找）`;
    return `${name}${name === root.activeProfile ? ' *' : ''}：${agentBackendSpec(profile.agentKind).displayName} @ ${binary}，` +
      `权限 ${profile.permissions.defaultAccess}（上限 ${profile.permissions.maxAccess}），应用 ${profile.accounts.app.id}`;
  }).join('\n');
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n')[0] ?? '';
}

function expandHome(input: string): string {
  return input === '~' || input.startsWith('~/') ? resolve(homedir(), input.slice(2)) : input;
}

/** Unwrap a prompt answer; Ctrl+C ends the guide without touching the config. */
function ask<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('已取消，未修改配置。');
    process.exit(130);
  }
  return value as T;
}
