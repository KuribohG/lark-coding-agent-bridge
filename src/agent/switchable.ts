import type { AgentAdapter, AgentBotIdentity, AgentRunOptions } from './types';
import { checkRuntimeAgentAvailability } from '../runtime/agent-runtime';
import { RunRejected } from '../runtime/errors';

/** Keeps channel/executor references stable when an idle bot changes engines. */
export class SwitchableAgent implements AgentAdapter {
  private identity?: AgentBotIdentity;
  constructor(private current: AgentAdapter) {}
  get id() { return this.current.id; }
  get displayName() { return this.current.displayName; }
  isAvailable() { return this.current.isAvailable(); }
  checkAvailability() { return checkRuntimeAgentAvailability(this.current); }
  prepareRun(opts: AgentRunOptions) {
    this.assertAgent(opts);
    return this.current.prepareRun?.(opts) ?? Promise.resolve();
  }
  run(opts: AgentRunOptions) {
    this.assertAgent(opts);
    return this.current.run(opts);
  }
  private assertAgent(opts: AgentRunOptions) {
    if (opts.agentId && opts.agentId !== this.id) throw new RunRejected('agent-changed', '执行引擎已改变，请重新发送任务。');
  }
  setBotIdentity(identity: AgentBotIdentity) {
    this.identity = identity;
    this.current.setBotIdentity?.(identity);
  }
  replace(next: AgentAdapter) {
    if (this.identity) next.setBotIdentity?.(this.identity);
    this.current = next;
  }
}
