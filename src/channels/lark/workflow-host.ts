import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import type { Controls } from '../../commands';
import type { AgentKind } from '../../config/profile-schema';
import { getAgentStopGraceMs, getRunIdleTimeoutMs } from '../../config/schema';
import { canUseDm, canUseGroup } from '../../policy/access';
import type { AgentEntry } from '../../runtime/agent-entry';
import { profileForAgentKind } from '../../runtime/execution-controller';
import { resolveRunModelSettings } from '../../runtime/model-settings';
import { WorkflowHost, type WorkflowHostDeps } from '../../runtime/workflow-host';
import type { PendingMessage, PendingQueue } from './pending-queue';
import { WorkflowProgressCards } from './workflow-progress-cards';

export type LarkWorkflowHost = WorkflowHost<NormalizedMessage>;

export interface LarkWorkflowHostDeps extends Omit<WorkflowHostDeps<NormalizedMessage>, 'frontend' | 'settings'> {
  channel: LarkChannel;
  controls: Controls;
  pending: PendingQueue;
  dispatch(scope: string, batch: PendingMessage[], options: { signal: AbortSignal; entry: AgentEntry }): Promise<unknown>;
}

/** The workflow host of one Lark connection: topic replies, chat access and progress cards. */
export function createLarkWorkflowHost(deps: LarkWorkflowHostDeps): LarkWorkflowHost {
  const { channel, pending, dispatch, controls, ...shared } = deps;
  // Chat access is a property of the Lark profile, not of the run profile the host passes back.
  const profileFor = (agentKind: AgentKind) => profileForAgentKind(controls.profileConfig, agentKind);
  return new WorkflowHost<NormalizedMessage>({ ...shared, settings: {
    get profile() { return controls.profile; },
    profileFor: agentKind => profileForAgentKind(controls.profileConfig, agentKind),
    modelSettings: (scope, agentKind, patch) => resolveRunModelSettings(controls, scope, patch, agentKind),
    stallMs: () => getRunIdleTimeoutMs(controls.profileConfig),
    stopGraceMs: () => getAgentStopGraceMs(controls.cfg),
  }, frontend: {
    accepts: origin => typeof (origin as Partial<NormalizedMessage>).chatId === 'string',
    reply: async (message, text) => {
      const receipt = await channel.send(message.chatId, { markdown: text },
        { replyTo: message.messageId, replyInThread: Boolean(message.threadId) });
      if (!receipt.messageId?.trim()) throw new Error('Workflow message delivery returned no message receipt');
    },
    conversation: (message, profileConfig) => ({
      scope: { source: 'im', chatId: message.chatId, actorId: message.senderId, ...(message.threadId ? { threadId: message.threadId } : {}) },
      access: message.chatType === 'p2p' ? canUseDm(profileFor(profileConfig.agentKind), controls, message.senderId)
        : canUseGroup(profileFor(profileConfig.agentKind), controls, message.chatId, message.senderId),
    }),
    blocked: scope => controls.channel?.activeTimedRun(scope) ? '请先结束当前限时任务。' : undefined,
    queue: (scope, message, content, agentEntry) => pending.push(scope, { ...message, content, agentEntry }) !== undefined,
    dispatch,
    progress: (kernel, origins, stateDir) => new WorkflowProgressCards({ channel, kernel, origins,
      path: join(stateDir, 'workflow-progress-cards.json') }),
  } });
}
