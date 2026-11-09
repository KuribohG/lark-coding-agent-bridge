import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../commands';
import type { AgentKind } from '../../config/profile-schema';
import { log } from '../../core/logger';
import type { VcRequestClient } from '../../meeting/api';
import { MeetingManager } from '../../meeting/manager';
import { attachMeetingAgent, summarizeEndedMeeting, type MeetingAgentDeps } from '../../meeting/orchestrator';

export interface LarkMeetingHostDeps {
  channel: LarkChannel;
  controls: Controls;
  conversation: Omit<MeetingAgentDeps, 'session' | 'channel' | 'controls' | 'resolveAgentKind'>;
  resolveAgentKind(scope: string): AgentKind;
}

/**
 * The in-meeting agent of one Lark connection. `meeting.enabled` is hot:
 * raw-event subscriptions compose with the SDK's handlers, so the manager can
 * attach to (or leave) a live connection.
 */
export class LarkMeetingHost {
  private manager: MeetingManager | undefined;

  constructor(private readonly deps: LarkMeetingHostDeps) {}

  current(): MeetingManager | undefined {
    return this.manager;
  }

  async reconcile(): Promise<void> {
    const enabled = this.deps.controls.profileConfig.meeting.enabled;
    if (enabled && !this.manager) {
      this.manager = this.create();
      this.manager.attachPush();
    } else if (!enabled && this.manager) {
      this.manager.dispose();
      this.manager = undefined;
    }
  }

  /** Stops meeting timers but stays in the meetings: a reconnect rebuilds the channel and should not leave them. */
  dispose(): void {
    this.manager?.dispose();
    this.manager = undefined;
  }

  private create(): MeetingManager {
    const { channel, controls, conversation, resolveAgentKind } = this.deps;
    return new MeetingManager({
      client: channel.rawClient as unknown as VcRequestClient,
      config: () => controls.profileConfig.meeting,
      // Sessions are only created on /meeting join or an invite, after connect resolved the identity.
      botOpenId: () => channel.botIdentity?.openId,
      channel,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({ session, ...conversation, channel, controls, resolveAgentKind })
          .catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) => attachMeetingAgent({ session, ...conversation, channel, controls, resolveAgentKind }),
    });
  }
}
