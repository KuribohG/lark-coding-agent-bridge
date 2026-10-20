import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { formatMonitorConfig, parseMonitorConfig } from '../../../src/monitoring/config';
import { parseWorkItemConcurrency } from '../../../src/work-items/concurrency';

it('ships a valid, disabled example for both sources', async () => {
  const example = await readFile(new URL('../../../docs/monitors.example.toml', import.meta.url), 'utf8');
  expect(parseMonitorConfig(example)).toMatchObject({ inbox: { enabled: false }, gitlabCi: { enabled: false } });
});

it('reads comments, nested notification targets and multiple repositories in one TOML file', () => {
  const settings = parseMonitorConfig(`
version = 1
[sources.lark]
enabled = false # not active yet
executorProfile = "codex"
intakeScope = "private_mentions"
attentionProfile = """关注 CI 失败
和需要我处理的消息"""
[sources.gitlab_ci]
enabled = true
executorProfile = "codex"
url = "https://gitlab.example.com"
outputDir = "/private/ci"
pollSeconds = 1
tokenEnv = "MY_GITLAB_TOKEN"
[sources.gitlab_ci.notification]
ownerOpenId = "ou_owner"
deliveryMode = "new_topic"
[sources.gitlab_ci.notification.destination]
chatId = "oc_results"
threadId = "omt_topic"
replyTo = "om_message"
[[sources.gitlab_ci.repositories]]
project = "group/one"
refs = ["dev"]
[[sources.gitlab_ci.repositories]]
project = "group/two"
refs = []
`);
  expect(settings.inbox).toMatchObject({ enabled: false, intakeScope: 'private_mentions' });
  expect(settings.gitlabCi).toMatchObject({ enabled: true, pollSeconds: 1, tokenEnv: 'MY_GITLAB_TOKEN',
    repositories: [{ project: 'group/one', refs: ['dev'] }, { project: 'group/two', refs: [] }] });
  expect(parseMonitorConfig(formatMonitorConfig(settings))).toEqual(settings);
});

it.each([
  ['version = 2\n[sources]', 'monitors.version'],
  ['[sources]', 'version'],
  ['version = 1\n[sources.unknown]', 'sources.unknown'],
  ['version = 1\n[sources.lark]\nenabled = "false"', 'enabled'],
  ['version = 1\n[sources.gitlab_ci]\npollSeconds = 0', 'pollSeconds'],
  ['version = 1\n[sources.gitlab_ci]\npollSeconds = 1.5', 'pollSeconds'],
  ['version = 1\n[sources.lark]\nintakeScope = "everyone"', 'intakeScope'],
  ['version = 1\n[sources.gitlab_ci]\n[[sources.gitlab_ci.repositories]]\nprojet = "typo"', 'projet'],
  ['version = 1\n[sources.gitlab_ci]\ntoken = "secret"', 'token'],
  ['version = 1\n[sources.lark]\nautoAnalyze = true', 'autoAnalyze'],
  ['version = 1\n[sources.lark]\ntriageMessageLimit = 1', 'triageMessageLimit'],
  ['version = 1\n[sources.lark]\ntriageMessageLimit = 101', 'triageMessageLimit'],
  ['version = 1\n[sources.lark]\ntriageMessageChars = 199', 'triageMessageChars'],
  ['version = 1\n[sources.lark]\ntriageMessageChars = 16001', 'triageMessageChars'],
  ['version = 1\n[sources.lark]\ntriageMessageChars = 500.5', 'triageMessageChars'],
  ...['0', '1441', '1.5', '"60"'].map(value => [`version = 1\n[sources.lark]\nanalysisTimeoutMinutes = ${value}`, 'analysisTimeoutMinutes']),
])('rejects malformed or unsupported settings instead of silently defaulting: %s', (text, field) => {
  expect(() => parseMonitorConfig(text)).toThrow(field);
});

it('round-trips screening limits and applies defaults to existing TOML installations', () => {
  const old = parseMonitorConfig('version = 1\n[sources.lark]');
  expect(old.inbox).toMatchObject({ triageMessageLimit: 12, triageMessageChars: 2000 });
  const settings = parseMonitorConfig('version = 1\n[sources.lark]\ntriageMessageLimit = 6\ntriageMessageChars = 500');
  expect(parseMonitorConfig(formatMonitorConfig(settings)).inbox).toMatchObject({ triageMessageLimit: 6, triageMessageChars: 500 });
});

it('defaults old installations to 30 minutes and round-trips configurable analysis timeouts', () => {
  expect(parseMonitorConfig('version = 1\n[sources.lark]').inbox?.analysisTimeoutMinutes).toBe(30);
  for (const minutes of [1, 90, 1440]) {
    const settings = parseMonitorConfig(`version = 1\n[sources.lark]\nanalysisTimeoutMinutes = ${minutes}`);
    expect(parseMonitorConfig(formatMonitorConfig(settings)).inbox?.analysisTimeoutMinutes).toBe(minutes);
  }
});

it('reports syntax locations without echoing the input code block', () => {
  let message = '';
  try { parseMonitorConfig('version = 1\nsecret = "SENSITIVE'); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('第 2 行'); expect(message).not.toContain('SENSITIVE');
});

it('preserves legacy model omission and explicit default-model selection across saves', () => {
  const implicit = parseMonitorConfig('version = 1\n[sources.lark]\n[sources.gitlab_ci]');
  const explicit = parseMonitorConfig('version = 1\n[sources.lark]\nanalysisModel = ""\n[sources.gitlab_ci]\nmodel = ""');
  expect(parseMonitorConfig(formatMonitorConfig(implicit)).inbox?.analysisModel).toBeUndefined();
  expect(parseMonitorConfig(formatMonitorConfig(implicit)).gitlabCi?.model).toBeUndefined();
  expect(parseMonitorConfig(formatMonitorConfig(explicit)).inbox?.analysisModel).toBe('');
  expect(parseMonitorConfig(formatMonitorConfig(explicit)).gitlabCi?.model).toBe('');
});

it('defaults old configurations to five analysis and fifty screening slots and round-trips overrides', () => {
  const old = parseMonitorConfig('version = 1\n[sources]');
  expect(parseWorkItemConcurrency(old.workItemConcurrency)).toEqual({ analysis: 5, triage: 50 });
  const settings = parseMonitorConfig('version = 1\n[concurrency]\nanalysis = 8\ntriage = 60\n[sources]');
  expect(settings.workItemConcurrency).toEqual({ analysis: 8, triage: 60 });
  expect(parseMonitorConfig(formatMonitorConfig(settings))).toEqual(settings);
});

it.each(['analysis = 0', 'triage = 101', 'triage = -1', 'triage = 1.5', 'analysis = "5"', 'maxConcurrent = 10', 'incidentAnalysis = 5'])(
  'rejects invalid concurrency settings: %s', field => {
    expect(() => parseMonitorConfig(`version = 1\n[concurrency]\n${field}\n[sources]`)).toThrow('monitors.concurrency');
  });
