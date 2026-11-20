/**
 * Time limits for Pi's shell tools.
 *
 * Pi's `bash` takes an optional `timeout` and waits for ever without one. A
 * model passes it for commands it expects to be slow and leaves it out for the
 * ones it takes to be instant, and it is those that hang: a `find` or
 * `grep -r` over a network mount holds the turn until someone stops it. So a
 * call without `timeout` gets a default and an explicit one is capped; the
 * model still decides how long a build may take by saying so.
 *
 * This file is shared by the CLI extension, which runs inside Pi, and by the
 * bridge, which derives from the same numbers when a call is overdue. It must
 * stay free of imports for the first of the two.
 */

export interface PiBashTimeouts {
  /** Seconds a shell call without `timeout` may run; absent leaves such calls unbounded. */
  defaultSeconds?: number;
  /** Largest `timeout` a call may ask for; absent leaves it uncapped. */
  maxSeconds?: number;
}

const PI_BASH_DEFAULT_TIMEOUT_SECONDS = 600;
const PI_BASH_MAX_TIMEOUT_SECONDS = 4 * 60 * 60;

const DEFAULT_ENV = 'LARK_PI_BASH_DEFAULT_TIMEOUT';
const MAX_ENV = 'LARK_PI_BASH_MAX_TIMEOUT';

/** Pi's shell tools; both take `timeout` in seconds. */
const SHELL_TOOLS = new Set(['bash', 'powershell']);
/** Pi's file tools: they take no timeout and are quick unless the file system hangs under them. */
const FILE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'edit', 'write']);

/** The limits a profile's settings ask for: unset takes the default and 0 switches that limit off. */
export function piBashTimeouts(
  settings: { bashDefaultTimeoutSeconds?: number; bashMaxTimeoutSeconds?: number } = {},
): PiBashTimeouts {
  const maxSeconds = limit(settings.bashMaxTimeoutSeconds, PI_BASH_MAX_TIMEOUT_SECONDS);
  const defaultSeconds = limit(settings.bashDefaultTimeoutSeconds, PI_BASH_DEFAULT_TIMEOUT_SECONDS);
  return {
    ...(defaultSeconds === undefined ? {}
      : { defaultSeconds: maxSeconds === undefined ? defaultSeconds : Math.min(defaultSeconds, maxSeconds) }),
    ...(maxSeconds === undefined ? {} : { maxSeconds }),
  };
}

export function isPiShellTool(name: unknown): boolean {
  return typeof name === 'string' && SHELL_TOOLS.has(name);
}

/** Where a call's time limit came from; `declared` means the call's own `timeout` stands as given. */
export type BashTimeoutSource = 'declared' | 'default' | 'capped';

/**
 * The time limit one shell call runs under. A `timeout` Pi would refuse stays
 * `declared` with no limit, so that Pi reports it instead of the call silently
 * getting another value.
 */
export function boundBashTimeout(
  declared: unknown,
  limits: PiBashTimeouts,
): { seconds: number | undefined; source: BashTimeoutSource } {
  // The run's event stream carries arguments as the model wrote them, before Pi coerces them.
  const asked = typeof declared === 'string' && declared.trim() ? Number(declared) : declared;
  if (asked === undefined || asked === null) return { seconds: limits.defaultSeconds, source: 'default' };
  if (typeof asked !== 'number' || !Number.isFinite(asked) || asked <= 0) return { seconds: undefined, source: 'declared' };
  if (limits.maxSeconds !== undefined && asked > limits.maxSeconds) return { seconds: limits.maxSeconds, source: 'capped' };
  return { seconds: asked, source: 'declared' };
}

/**
 * How long Pi lets a tool call run before it stops the call itself, in
 * milliseconds, for a caller that waits on the call. File tools have no limit
 * of their own in Pi; the default is given for them too, as none of them has
 * reason to outlast a shell call nobody expected to be slow.
 */
export function piToolTimeoutMs(name: string, input: unknown, limits: PiBashTimeouts): number | undefined {
  if (SHELL_TOOLS.has(name)) {
    const declared = input && typeof input === 'object' ? (input as { timeout?: unknown }).timeout : undefined;
    const seconds = boundBashTimeout(declared, limits).seconds;
    return seconds === undefined ? undefined : seconds * 1000;
  }
  if (FILE_TOOLS.has(name) && limits.defaultSeconds !== undefined) return limits.defaultSeconds * 1000;
  return undefined;
}

/** What the model is told up front, since the tool's own description still says there is no default. */
export function bashTimeoutInstructions(limits: PiBashTimeouts): string | undefined {
  const { defaultSeconds, maxSeconds } = limits;
  if (defaultSeconds === undefined && maxSeconds === undefined) return undefined;
  const rules = [
    ...(defaultSeconds === undefined ? [] : [`a call without \`timeout\` is stopped after ${defaultSeconds} seconds`]),
    ...(maxSeconds === undefined ? [] : [`\`timeout\` cannot exceed ${maxSeconds} seconds`]),
  ].join(', and ');
  return [
    `Shell command time limits: ${rules}.`,
    ...(defaultSeconds === undefined ? []
      : ['Pass `timeout` (in seconds) for builds, test suites and any other command you expect to take longer than the default.']),
    ...(maxSeconds === undefined ? []
      : ['For work longer than the cap, start it detached (`setsid nohup <command> > <log> 2>&1 &`) and check its log with short calls.']),
    'Keep `find` and `grep -r` inside the directories you work in: over `/` or a whole network mount they can run for hours.',
  ].join(' ');
}

/** Appended to the result of a call the adjusted limit stopped, so the model knows the limit was not its own. */
export function bashTimeoutHint(source: BashTimeoutSource, seconds: number, limits: PiBashTimeouts): string | undefined {
  if (source === 'default') {
    const most = limits.maxSeconds === undefined ? '' : `, at most ${limits.maxSeconds}`;
    return `No timeout was given, so the default of ${seconds} seconds applied. If the command needs longer, pass timeout (in seconds${most}); `
      + 'if it was a search, it covered too much: narrow its path.';
  }
  if (source === 'capped') {
    return `The timeout asked for is above the limit and was reduced to ${seconds} seconds. `
      + 'Run longer work detached (setsid nohup <command> > <log> 2>&1 &) and check its log with short calls.';
  }
  return undefined;
}

/** The limits as the environment of a Pi process, where the extension reads them. */
export function bashTimeoutEnv(limits: PiBashTimeouts): Record<string, string> {
  return {
    ...(limits.defaultSeconds === undefined ? {} : { [DEFAULT_ENV]: String(limits.defaultSeconds) }),
    ...(limits.maxSeconds === undefined ? {} : { [MAX_ENV]: String(limits.maxSeconds) }),
  };
}

export function bashTimeoutsFromEnv(env: Record<string, string | undefined>): PiBashTimeouts {
  const defaultSeconds = limit(Number(env[DEFAULT_ENV] ?? 0), 0);
  const maxSeconds = limit(Number(env[MAX_ENV] ?? 0), 0);
  return {
    ...(defaultSeconds === undefined ? {} : { defaultSeconds }),
    ...(maxSeconds === undefined ? {} : { maxSeconds }),
  };
}

function limit(value: number | undefined, fallback: number): number | undefined {
  const seconds = value === undefined ? fallback : value;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
