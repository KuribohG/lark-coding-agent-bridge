import { parseEffort, resolveModelSettings } from '../agent/model-settings';
import { DEFAULT_MODEL, normalizeModelSelection, validateModelId } from '../agent/models';
import { modelEnvironment } from '../runtime/model-settings';
import {
  applyProfileLarkCliIdentity, savePreferencesConfig, type MutableProfileState,
} from './config-ops';
import { effectiveLarkCliIdentity, type MeetingConfig, type LarkCliIdentityPreset, type ProfileMode } from './profile-schema';
import {
  getCotMessages, getMaxConcurrentRuns, getMessageReplyMode, getRequireMentionInGroup,
  getRunIdleTimeoutMs, getShowToolCalls, type AppPreferences, type CotMessagesMode, type MessageReplyMode,
} from './schema';

export class PreferencesValidationError extends Error {}

export class PreferencesApplyError extends Error {
  constructor(
    readonly step: 'config.save' | 'config.lark-cli-policy',
    readonly identityApplied: boolean,
    readonly rollbackFailed: boolean,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Parse the in-meeting agent section. Unspecified fields keep their current
 * value; numbers are clamped to the same bounds the schema normalizer uses.
 */
function parseMeetingBody(body: unknown, current: MeetingConfig): MeetingConfig {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return current;
  const fv = body as Record<string, unknown>;
  const t = (fv.transcript && typeof fv.transcript === 'object' ? fv.transcript : {}) as Record<string, unknown>;
  const trigger = typeof fv.trigger === 'string' && fv.trigger.trim() ? fv.trigger.trim() : current.trigger;
  return {
    enabled: typeof fv.enabled === 'boolean' ? fv.enabled : current.enabled,
    autoJoinOnInvite:
      typeof fv.autoJoinOnInvite === 'boolean' ? fv.autoJoinOnInvite : current.autoJoinOnInvite,
    transcript: {
      keep: t.keep === undefined ? current.transcript.keep : clampInt(t.keep, 10, 2000, current.transcript.keep),
      stabilizeMs:
        t.stabilizeMs === undefined
          ? current.transcript.stabilizeMs
          : clampInt(t.stabilizeMs, 0, 30_000, current.transcript.stabilizeMs),
    },
    respondIn:
      fv.respondIn === 'meeting' || fv.respondIn === 'im' || fv.respondIn === 'both'
        ? fv.respondIn
        : current.respondIn,
    trigger,
    pollIntervalMs:
      fv.pollIntervalMs === undefined
        ? current.pollIntervalMs
        : clampInt(fv.pollIntervalMs, 1000, 60_000, current.pollIntervalMs),
    summaryOnEnd: typeof fv.summaryOnEnd === 'boolean' ? fv.summaryOnEnd : current.summaryOnEnd,
    summaryTarget:
      fv.summaryTarget === 'origin' || fv.summaryTarget === 'owner'
        ? fv.summaryTarget
        : current.summaryTarget,
  };
}

export interface PreferencesChange {
  mode: ProfileMode;
  meeting?: MeetingConfig;
  larkCliIdentity: LarkCliIdentityPreset;
  requireMentionInGroup: boolean;
  nextPreferences: AppPreferences & Required<Pick<AppPreferences,
    'messageReply' | 'showToolCalls' | 'maxConcurrentRuns' | 'runIdleTimeoutMinutes'>> & { cotMessages: CotMessagesMode };
  nextEffectiveIdentity: LarkCliIdentityPreset;
  previousEffectiveIdentity: LarkCliIdentityPreset;
  identityChanged: boolean;
}

/**
 * Unspecified fields retain their current values. Surface adapters translate
 * form-specific representations before reaching this shared validator.
 */
function parsePreferencesChange(state: MutableProfileState, body: unknown): PreferencesChange {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new PreferencesValidationError('expected a JSON object body');
  }
  const fv = body as Record<string, unknown>;
  const agentKind = state.profileConfig.agentKind;

  const mode: ProfileMode =
    fv.mode === 'team' || fv.mode === 'personal' ? fv.mode : state.profileConfig.mode;
  const larkCliIdentity: LarkCliIdentityPreset =
    fv.larkCliIdentity === 'user-default' || fv.larkCliIdentity === 'bot-only'
      ? fv.larkCliIdentity
      : state.profileConfig.larkCli.identityPreset;

  let modelSelection: string;
  let reasoningEffort: import('../agent/model-settings').ReasoningEffort | undefined;
  try {
    if (fv.model !== undefined && typeof fv.model !== 'string') throw new Error('模型名必须是字符串。');
    modelSelection = fv.model === undefined
      ? normalizeModelSelection(agentKind, state.cfg.preferences?.model)
      : fv.model === '' ? DEFAULT_MODEL : validateModelId(fv.model as string);
    reasoningEffort = fv.reasoningEffort === undefined
      ? state.cfg.preferences?.reasoningEffort : parseEffort(fv.reasoningEffort, agentKind);
  } catch (err) {
    throw new PreferencesValidationError(err instanceof Error ? err.message : String(err));
  }
  const model = modelSelection === DEFAULT_MODEL ? undefined : modelSelection;

  const messageReply: MessageReplyMode =
    fv.messageReply === 'markdown' || fv.messageReply === 'text' || fv.messageReply === 'card'
      ? fv.messageReply
      : getMessageReplyMode(state.cfg);
  const showToolCalls =
    typeof fv.showToolCalls === 'boolean' ? fv.showToolCalls : getShowToolCalls(state.cfg);
  const cotMessages: CotMessagesMode =
    fv.cotMessages === 'brief' || fv.cotMessages === 'detailed' || fv.cotMessages === 'off'
      ? fv.cotMessages
      : getCotMessages(state.cfg);
  const maxConcurrentRuns =
    fv.maxConcurrentRuns === undefined
      ? getMaxConcurrentRuns(state.cfg)
      : clampInt(fv.maxConcurrentRuns, 1, 50, getMaxConcurrentRuns(state.cfg));

  const currentIdleMs = getRunIdleTimeoutMs(state.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (fv.runIdleTimeoutMinutes === undefined) {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const n = Number(fv.runIdleTimeoutMinutes);
    runIdleTimeoutMinutes =
      !Number.isFinite(n) || n < 0 ? currentIdleMinutes : n === 0 ? 0 : clampInt(n, 1, 120, currentIdleMinutes);
  }

  const requireMentionInGroup =
    typeof fv.requireMentionInGroup === 'boolean'
      ? fv.requireMentionInGroup
      : getRequireMentionInGroup(state.cfg);

  const meeting = fv.meeting === undefined ? undefined : parseMeetingBody(fv.meeting, state.profileConfig.meeting);

  const nextEffectiveIdentity: LarkCliIdentityPreset = mode === 'team' ? 'bot-only' : larkCliIdentity;
  const previousEffectiveIdentity = effectiveLarkCliIdentity(state.profileConfig);

  return {
    mode,
    meeting,
    larkCliIdentity,
    requireMentionInGroup,
    nextEffectiveIdentity,
    previousEffectiveIdentity,
    identityChanged: nextEffectiveIdentity !== previousEffectiveIdentity,
    nextPreferences: {
      ...(state.cfg.preferences ?? {}),
      model,
      reasoningEffort,
      messageReply,
      messageReplyMigrated: true,
      showToolCalls,
      cotMessages,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
    },
  };
}

async function validateModelPreferences(state: MutableProfileState, preferences: AppPreferences): Promise<void> {
  try {
    const resolved = resolveModelSettings(preferences, {}, await modelEnvironment(state));
    if (preferences.reasoningEffort && preferences.reasoningEffort !== resolved.reasoningEffort) {
      throw new Error(resolved.notice ?? '模型与思考强度不匹配。');
    }
  } catch (err) {
    throw new PreferencesValidationError(err instanceof Error ? err.message : String(err));
  }
}

export async function preparePreferencesChange(state: MutableProfileState, body: unknown): Promise<PreferencesChange> {
  const change = parsePreferencesChange(state, body);
  await validateModelPreferences(state, change.nextPreferences);
  return change;
}

/** Offline profiles apply their identity policy on their next startup. */
export async function applyPreferencesChange(
  state: MutableProfileState,
  change: PreferencesChange,
  mode: 'live' | 'disk' = 'live',
): Promise<void> {
  let step: PreferencesApplyError['step'] = 'config.save';
  let identityAttempted = false;
  let identityApplied = false;
  try {
    if (mode === 'live' && change.identityChanged) {
      step = 'config.lark-cli-policy';
      identityAttempted = true;
      if (!await applyProfileLarkCliIdentity(state, change.nextEffectiveIdentity)) {
        throw new Error('lark-cli 身份策略未生效');
      }
      identityApplied = true;
    }
    step = 'config.save';
    await savePreferencesConfig(state, change.nextPreferences, change.requireMentionInGroup,
      change.larkCliIdentity, change.mode, change.meeting);
  } catch (cause) {
    // A failed policy call may already have applied one of its CLI settings.
    const rollbackFailed = identityAttempted && !await applyProfileLarkCliIdentity(state, change.previousEffectiveIdentity).catch(() => false);
    throw new PreferencesApplyError(step, identityApplied, rollbackFailed, cause);
  }
}
