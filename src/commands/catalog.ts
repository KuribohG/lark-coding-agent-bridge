export type CommandChannel = 'lark' | 'slack';

export interface CommandDefinition {
  name: string;
  aliases?: readonly string[];
  access: 'user' | 'admin';
  pending: 'preserve' | 'cancel';
  arguments: 'words' | 'verbatim';
  help: readonly string[];
  /** Channels that expose this command. Defaults to Lark. */
  channels?: readonly CommandChannel[];
  /** Channel-specific help lines, used instead of `help` when present. */
  channelHelp?: Partial<Record<CommandChannel, readonly string[]>>;
}

export interface ParsedSlashCommand {
  /** Command name without the leading slash, lowercased when case-insensitive. */
  name: string;
  /** Catalog entry when the command (or an alias) is known. */
  definition?: CommandDefinition;
  /** Arguments parsed according to the definition's `arguments` mode. */
  args: string;
}

/** Data-only command metadata is shared by intake, dispatch and help rendering. */
export const commandDefinitions = [
  { name: 'new', aliases: ['reset'], access: 'user', pending: 'cancel', arguments: 'words', channels: ['lark', 'slack'], channelHelp: {
    slack: ['`/new` — forget this thread\'s native session'],
  }, help: [
    '`/new` `/reset` — 清空当前 chat 的会话', '`/new chat [name]` — 新建群+新会话，自动拉你进群',
  ] },
  { name: 'btw', access: 'user', pending: 'preserve', arguments: 'verbatim', help: ['`/btw 问题` — 当前话题/聊天的旁问，记住此前旁问，不打断主任务'] },
  { name: 'resume', access: 'user', pending: 'cancel', arguments: 'words', help: ['`/resume [N]` — 列出并恢复历史会话（最多 N 条）'] },
  { name: 'recent', access: 'user', pending: 'preserve', arguments: 'words', help: ['`/recent [N]` — 列出最近完成的 session（默认 5 条，最多 20 条）'] },
  { name: 'cd', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/cd <path>` — 切换工作目录（会重置 session）'] },
  { name: 'ws', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/ws list|save <name>|use <name>|remove <name>` — 工作目录'] },
  { name: 'account', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/account` — 查看当前应用；`/account change` 换 appId/secret 并重连'] },
  { name: 'config', access: 'admin', pending: 'preserve', arguments: 'words', help: [
    '`/config` — 查看配置摘要；`/config run|lark|access` 编辑对应分组（全局默认，所有私聊和群话题共用）；`lark-cli 身份策略` 在 `/config access`',
    '`/config reload` — 立即重载配置文件并报告生效情况（文件修改平时自动加载）',
  ] },
  { name: 'model', aliases: ['provider'], access: 'user', pending: 'preserve', arguments: 'words', channels: ['lark', 'slack'], channelHelp: {
    slack: ['`/model` — show the current engine'],
  }, help: [
    '`/model [模型名|default] [强度] [任务]` — 当前话题/聊天的模型和强度；带任务时切换后立即执行',
    '`/provider` — 打开 Provider 与模型切换卡片',
  ] },
  { name: 'agent', access: 'user', pending: 'preserve', arguments: 'verbatim', help: [
    '`/agent [claude|codex|…|default] [模型名|default] [强度] [任务]` — 当前话题/聊天的执行引擎，各引擎上下文独立；带任务时切换后立即执行',
  ] },
  { name: 'effort', access: 'user', pending: 'preserve', arguments: 'words', help: ['`/effort [强度|default]` — 当前话题/聊天的思考强度；全局默认用 `/config run`'] },
  { name: 'run', access: 'user', pending: 'preserve', arguments: 'verbatim', help: ['`/run` — 限时任务表单；`/run 任务` 用默认值，`/run defaults` 设置默认值，`/run status` 查看，`/run stop` 取消'] },
  { name: 'status', access: 'user', pending: 'preserve', arguments: 'words', channels: ['lark', 'slack'], channelHelp: {
    slack: ['`/status` — show engine and run state'],
  }, help: ['`/status` — 当前状态'] },
  // /stop owns cancellation so it can report how many pending messages it removed.
  { name: 'stop', access: 'user', pending: 'preserve', arguments: 'words', channels: ['lark', 'slack'], channelHelp: {
    slack: ['`/stop` — stop the active run'],
  }, help: [
    '`/stop` — 停止当前任务并取消排队消息（也可点卡片底部 ⏹ 终止 按钮）', '`/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
  ] },
  { name: 'timeout', access: 'user', pending: 'cancel', arguments: 'words', help: [
    '`/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认', '`/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
  ] },
  { name: 'ps', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/ps` — 列出本机所有 bot,标识当前正在回复的那个'] },
  { name: 'exit', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)'] },
  { name: 'reconnect', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)'] },
  { name: 'doctor', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/doctor [描述]` — 把日志和描述交给 {agent} 自助诊断'] },
  { name: 'invite', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/invite` — 管理用户、群聊和管理员访问权限'] },
  { name: 'remove', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/remove` — 移除用户、群聊或管理员访问权限'] },
  { name: 'meeting', access: 'admin', pending: 'cancel', arguments: 'words', help: ['`/meeting` — 加入、离开或查看会议，以及向会议智能体提问'] },
  { name: 'doc', access: 'user', pending: 'cancel', arguments: 'words', help: ['`/doc` — 云文档使用说明'] },
  { name: 'help', access: 'user', pending: 'cancel', arguments: 'words', channels: ['lark', 'slack'], channelHelp: {
    slack: ['`/help [command]` — list commands or show details for one'],
  }, help: ['`/help [命令]` — 本帮助；指定命令查看单条详情'] },
] as const satisfies readonly CommandDefinition[];

export type CommandName = typeof commandDefinitions[number]['name'];

const byName = new Map<string, CommandDefinition>();
for (const definition of commandDefinitions) {
  const aliases = 'aliases' in definition ? definition.aliases : [];
  for (const name of [definition.name, ...aliases]) {
    if (byName.has(name)) throw new Error(`duplicate command: ${name}`);
    byName.set(name, definition);
  }
}

export function findCommand(name: string): CommandDefinition | undefined {
  return byName.get(name.startsWith('/') ? name.slice(1) : name);
}

/** Commands exposed by a channel. Definitions without `channels` are Lark commands. */
export function commandDefinitionsFor(channel: CommandChannel): readonly CommandDefinition[] {
  return commandDefinitions.filter(definition =>
    ((definition as CommandDefinition).channels ?? ['lark']).includes(channel));
}

/**
 * Parse a leading slash command. Every channel uses this so alias handling,
 * whitespace collapse and verbatim arguments stay consistent.
 */
export function parseSlashCommand(
  input: string,
  resolve: (name: string) => CommandDefinition | undefined = findCommand,
  options: { caseInsensitive?: boolean } = {},
): ParsedSlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const name = match?.[1] ?? '';
  if (!name) return undefined;
  const lookupName = options.caseInsensitive ? name.toLowerCase() : name;
  const definition = resolve(lookupName);
  const rest = match?.[2] ?? '';
  const args = definition?.arguments === 'verbatim'
    ? rest.trimStart()
    : rest.split(/\s+/).filter(Boolean).join(' ');
  return { name: lookupName, ...(definition ? { definition } : {}), args };
}

export function commandHelpLines(
  escapedAgentName: string,
  definitions: readonly CommandDefinition[] = commandDefinitions,
  channel: CommandChannel = 'lark',
): string[] {
  return definitions.flatMap(definition => {
    const lines = (definition as CommandDefinition).channelHelp?.[channel] ?? definition.help;
    return lines.map(line => `- ${line.replace('{agent}', () => escapedAgentName)}`);
  });
}
