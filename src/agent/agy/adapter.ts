import { isAbsolute } from 'node:path';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import { withExecutionContract } from '../execution';
import { parseEffort } from '../model-settings';
import { resolveModelArg } from '../models';
import { startProcessRun } from '../process-run';
import { resolveSystemPrompt, type AgentSystemPrompt } from '../system-prompt';
import type { AgentAdapter, AgentBotIdentity, AgentExecutionCapabilities, AgentRun, AgentRunOptions } from '../types';
import { AgyStreamTranslator } from './stream-json';
import { agyProviderLaunch } from './provider';

export const AGY_EXECUTION_CAPABILITIES: AgentExecutionCapabilities = Object.freeze({
  finalAnswer: 'separate-event', input: 'unsupported',
});

export interface AgyAdapterOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  systemPrompt?: AgentSystemPrompt;
}

export class AgyAdapter implements AgentAdapter {
  readonly id = 'agy';
  readonly displayName = 'Antigravity CLI';
  readonly capabilities = AGY_EXECUTION_CAPABILITIES;
  private botIdentity?: AgentBotIdentity;

  constructor(private readonly options: AgyAdapterOptions = {}) {}
  setBotIdentity(identity: AgentBotIdentity): void { this.botIdentity = identity; }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  checkAvailability(): Promise<AgentAvailability> {
    const binary = this.options.binary ?? 'agy';
    return checkAgentAvailability({ agentId: 'agy', agentName: this.displayName,
      command: binary, binaryPath: binary, env: this.options.env, minimumVersion: '1.4.10' });
  }
  async prepareRun(options: AgentRunOptions): Promise<void> {
    validateRun(options);
    const availability = await this.checkAvailability();
    if (!availability.ok) throw new SpawnFailed('agy binary check failed', availability.error,
      availability.diagnostic.code, availability.diagnostic);

  }
  run(options: AgentRunOptions): AgentRun {
    validateRun(options);
    const provider = options.modelProvider ? agyProviderLaunch(options.modelProvider) : undefined;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--disable-slash-commands', '--print-timeout', '0', '--dangerously-skip-permissions',
      '--settings', JSON.stringify({ artifactReviewPolicy: 'always-proceed', allowNonWorkspaceAccess: true, ...provider?.settings })];
    if (options.sessionId) args.push('--conversation', options.sessionId);
    const model = provider?.model ?? resolveModelArg('agy', options.model);
    if (model) args.push('--model', model);
    if (options.reasoningEffort) args.push('--effort', parseEffort(options.reasoningEffort, 'agy')!);
    const instructions = options.systemPrompt ?? resolveSystemPrompt(this.options.systemPrompt, this.botIdentity);
    const attachments = options.images?.length ? `\n\nAttached image files (absolute paths):\n${JSON.stringify(options.images)}` : '';
    const content = `${instructions}\n\n${options.prompt}${attachments}`;
    return withExecutionContract(startProcessRun({
      agent: this.id, runId: options.runId, command: this.options.binary ?? 'agy', args,
      cwd: options.cwd!, env: mergeProcessEnv(mergeProcessEnv(mergeProcessEnv(process.env, this.options.env), provider?.env), options.env),
      stdin: `${JSON.stringify({ event: 'user', message: { content } })}\n`,
      translator: new AgyStreamTranslator(), strictJson: true,
      deadlineAt: options.deadlineAt, stopGraceMs: options.stopGraceMs ?? 1000, stopSignal: 'SIGINT',
    }), this.capabilities);
  }
}

function validateRun(options: AgentRunOptions): void {
  if (!options.cwd) throw new Error('cwd is required for AgyAdapter.run');
  if (options.forkSession) throw new Error('Antigravity headless mode does not support conversation forks');
  if (options.modelProvider && !options.modelProvider.agy) throw new Error('Antigravity requires a native Gemini provider binding');
  if (options.sandbox && options.sandbox !== 'danger-full-access') {
    throw new Error('Antigravity headless mode cannot guarantee a portable read-only or workspace sandbox; select full access explicitly');
  }
  if (options.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(options.sessionId)) throw new Error('Invalid Antigravity conversation ID');
  if (options.images?.some(path => !isAbsolute(path))) throw new Error('Antigravity image paths must be absolute');
}
