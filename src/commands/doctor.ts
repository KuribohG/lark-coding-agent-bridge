import { capabilityForProfile } from '../agent/backends';
import { profileForAgentKind } from '../runtime/agent-runtime';
import { getAgentStopGraceMs } from '../config/schema';
import { canRunAdminCommand, canUseDm, canUseGroup } from '../policy/access';
import { log, reportMetric } from '../core/logger';
import { renderCard } from '../card/run-renderer';
import { finalizeIfRunning, initialState, markInterrupted, reduce, type RunState } from '../card/run-state';
import { resolveWorkingDirectory } from '../policy/workspace';
import { evaluateRunPolicy } from '../policy/run-policy';
import type { RunExecutor } from '../runtime/run-executor';
import { RunRejected } from '../runtime/errors';
import type { CommandContext } from './types';
import { reply } from './presentation';
import { effectiveWorkspaceCwd } from './context';
import { runtimeAccessStatus, formatOwnerState } from './status';

const DOCTOR_ECHO_PROMPT =
  'Bridge doctor agent echo check. Do not inspect files, do not use history, and reply exactly: OK';

const DOCTOR_RATE_LIMIT_MS = 30_000;

const doctorInFlightProfiles = new Set<string>();

const doctorLastByOperator = new Map<string, number>();

export async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });

  const rateKey = `${ctx.controls.profile}:${ctx.controls.configPath}:${ctx.msg.senderId}`;
  const now = Date.now();
  const last = doctorLastByOperator.get(rateKey);
  if (last !== undefined && now - last < DOCTOR_RATE_LIMIT_MS) {
    await reply(ctx, 'doctor rate limited: 同一用户 30 秒内只能触发一次。');
    return;
  }

  const requestedCwd = effectiveWorkspaceCwd(ctx);
  if (!requestedCwd) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck:
          '未设置工作目录。先用 `/cd <path>` 或 `/ws use <name>` 选择工作目录后再运行 agent echo check。',
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `${workspace.userVisible} 工作目录不可用时只执行 self-check，不启动 agent。`,
        echoCheck: 'skipped',
      }),
    );
    return;
  }

  if (!ctx.runExecutor) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: 'run executor unavailable',
      }),
    );
    return;
  }

  const profileKey = ctx.controls.profile;
  if (doctorInFlightProfiles.has(profileKey)) {
    await reply(ctx, 'doctor in-flight: 当前 profile 已有诊断运行中。');
    return;
  }
  doctorLastByOperator.set(rateKey, now);

  const agentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
  const scopedProfile = profileForAgentKind(ctx.controls.profileConfig, agentKind);
  const capability = capabilityForProfile(scopedProfile);
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: ctx.msg.chatId,
      actorId: ctx.msg.senderId,
      ...(ctx.msg.threadId ? { threadId: ctx.msg.threadId } : {}),
    },
    attachments: [],
    prompt: DOCTOR_ECHO_PROMPT,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: canRunAdminCommand(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId),
    capability,
    profileConfig: ctx.controls.profileConfig,
    now,
    ttlMs: 60_000,
  });
  if (!policy.ok) {
    await reply(
      ctx,
      buildDoctorReport(ctx, {
        workspaceCheck: `ok (${workspace.cwdRealpath})`,
        echoCheck: policy.rejectReason.userVisible,
      }),
    );
    return;
  }
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig, agentKind);
  const doctorReport = (echoCheck: string): string =>
    buildDoctorReport(ctx, {
      workspaceCheck: `ok (${workspace.cwdRealpath})`,
      policyCheck:
        runtimeAccess.label === 'sandbox'
          ? `ok sandbox=${policy.sandbox}`
          : `ok ${runtimeAccess.label}=${policy.permissionMode}`,
      echoCheck,
    });

  // In group / topic chats other members would see the result card. Ack
  // in-channel, deliver the actual analysis privately to the operator's
  // open_id (Lark auto-opens the p2p chat with the bot).
  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  doctorInFlightProfiles.add(profileKey);
  let execution: Awaited<ReturnType<RunExecutor['submit']>>;
  try {
    execution = await ctx.runExecutor.submit({
      scopeId: `${ctx.scope}:doctor`,
      policy,
      nowait: true,
      stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
      observability: {
        profile: ctx.controls.profile,
        agent: capability.agentId,
        source: 'doctor',
        stage: 'agent-probe',
      },
    });
  } catch (err) {
    doctorInFlightProfiles.delete(profileKey);
    if (err instanceof RunRejected && err.code === 'pool-full') {
      await reply(ctx, doctorReport('pool-full'));
      return;
    }
    log.fail('command', err, { step: 'doctor.submit' });
    reportMetric('command_fail', 1, { step: 'doctor.submit' });
    await reply(ctx, doctorReport('failed'));
    return;
  }

  try {
    if (isP2p) {
      // Streaming card path — operator is the only viewer in p2p.
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(withDoctorReport(initialState, doctorReport('pending'))),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              let echoText = '';
              const echoStatus = (): string => formatDoctorEchoStatus(echoText, state);
              const flush = (): Promise<void> =>
                ctrl.update(renderCard(withDoctorReport(state, doctorReport(echoStatus()))));
              for await (const evt of execution.subscribe()) {
                if (execution.handle.interrupted) break;
                // /doctor runs are session-less: skip 'system' so we don't
                // persist a doctor's sessionId over the user's real session.
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  continue;
                }
                if (evt.type === 'text') echoText += evt.delta;
                if (evt.type === 'final_text') echoText = evt.content;
                state = reduce(state, evt);
                await flush();
                // Don't wait for stdout to close — some claude versions hang
                // briefly post-result, which would leave the for-await stuck.
                if (state.terminal !== 'running') break;
              }
              state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      // Group / topic: buffer to completion, then DM the final card to the
      // operator. No live streaming — the group should see nothing past the
      // ack reply above.
      let state: RunState = initialState;
      let echoText = '';
      for await (const evt of execution.subscribe()) {
        if (execution.handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          continue;
        }
        if (evt.type === 'text') echoText += evt.delta;
        if (evt.type === 'final_text') echoText = evt.content;
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = execution.handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      // Send a one-shot interactive card by open_id. Lark routes it to the
      // user's p2p chat with the bot (auto-creates it if needed); other
      // group members never see this payload.
      await ctx.channel.send(ctx.msg.senderId, {
        card: renderCard(
          withDoctorReport(state, doctorReport(formatDoctorEchoStatus(echoText, state))),
        ),
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
    reportMetric('command_fail', 1, { step: 'doctor' });
  } finally {
    doctorInFlightProfiles.delete(profileKey);
  }
}

function buildDoctorReport(
  ctx: CommandContext,
  opts: {
    workspaceCheck?: string;
    policyCheck?: string;
    echoCheck?: string;
  } = {},
): string {
  const agentKind = ctx.agentKind ?? ctx.controls.profileConfig.agentKind;
  const queue = ctx.processPool?.snapshot();
  const queueLine = queue
    ? `${queue.active}/${queue.cap} active, ${queue.waiting} waiting`
    : 'unknown';
  const cwd = effectiveWorkspaceCwd(ctx);
  const runtimeAccess = runtimeAccessStatus(ctx.controls.profileConfig, agentKind);
  const access =
    ctx.msg.chatType === 'p2p'
      ? canUseDm(ctx.controls.profileConfig, ctx.controls, ctx.msg.senderId)
      : canUseGroup(
          ctx.controls.profileConfig,
          ctx.controls,
          ctx.msg.chatId,
          ctx.msg.senderId,
        );
  return [
    'self-check: ok',
    `profile: ${ctx.controls.profile}`,
    `agent: ${ctx.agent.displayName} (${agentKind})`,
    `workspace: ${cwd ?? '(未设置)'}`,
    `workspace default: ${ctx.controls.profileConfig.workspaces.default ? 'set' : 'missing'}`,
    `${runtimeAccess.label}: ${runtimeAccess.value}`,
    `access: ${access.ok ? 'ok' : 'denied'} (${access.reason})`,
    `owner API: ${formatOwnerState(ctx)}`,
    `queue: ${queueLine}`,
    `run executor: ${ctx.runExecutor ? 'available' : 'unavailable'}`,
    ...(opts.workspaceCheck ? [`workspace check: ${opts.workspaceCheck}`] : []),
    ...(opts.policyCheck ? [`policy check: ${opts.policyCheck}`] : []),
    ...(opts.echoCheck ? [`agent echo check: ${opts.echoCheck}`] : []),
  ].join('\n');
}

function withDoctorReport(state: RunState, report: string): RunState {
  return {
    ...state,
    blocks: [{ kind: 'text', content: report, streaming: false }, ...state.blocks],
  };
}

function formatDoctorEchoStatus(echoText: string, state: RunState): string {
  const trimmed = echoText.trim();
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  if (state.terminal === 'running') return 'pending';
  if (state.terminal === 'done') return 'empty';
  return state.terminal;
}
