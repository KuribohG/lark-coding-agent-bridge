import type { NormalizedMessage } from '@larksuite/channel';
import { capabilityForProfile } from '../agent/backends';
import type { Controls } from '../commands';
import type { AccessDecision } from '../policy/access';
import { evaluateRunPolicy } from '../policy/run-policy';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { SessionCatalogIdentity } from '../session/catalog';
import type { WorkspaceStore } from '../workspace/store';
import type { ChatMode } from './chat-mode-cache';
import type { AgentKind } from '../config/profile-schema';
import { profileForAgentKind } from '../runtime/agent-runtime';

export async function commandSessionCatalogIdentity(input: {
  msg: NormalizedMessage;
  scope: string;
  mode: ChatMode;
  workspaces: WorkspaceStore;
  controls: Controls;
  access: AccessDecision;
  agentKind?: AgentKind;
}): Promise<SessionCatalogIdentity | undefined> {
  const requestedCwd =
    input.workspaces.cwdFor(input.scope) ?? input.controls.profileConfig.workspaces.default;
  if (!requestedCwd) return undefined;
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) return undefined;
  const profile = profileForAgentKind(
    input.controls.profileConfig,
    input.agentKind ?? input.controls.profileConfig.agentKind,
  );
  const capability = capabilityForProfile(profile);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: input.msg.chatId,
      actorId: input.msg.senderId,
      ...(input.mode === 'topic' && input.msg.threadId ? { threadId: input.msg.threadId } : {}),
    },
    attachments: [],
    prompt: '',
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability,
    profileConfig: profile,
    now: Date.now(),
    codexHome: input.controls.profileConfig.codex?.codexHome,
    inheritCodexHome: input.controls.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) return undefined;
  return {
    scopeId: input.scope,
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}
