import type { AgentPreflightDiagnostic, AgentPreflightErrorCode } from './preflight';

export type SpawnFailedCode =
  | 'agent-spawn-failed'
  | 'agent-prepare-failed'
  | AgentPreflightErrorCode;

export class SpawnFailed extends Error {
  override readonly cause: unknown;
  readonly code: SpawnFailedCode;
  readonly diagnostic: AgentPreflightDiagnostic | undefined;

  constructor(
    message: string,
    cause: unknown,
    code: SpawnFailedCode = 'agent-spawn-failed',
    diagnostic?: AgentPreflightDiagnostic,
  ) {
    super(message);
    this.name = 'SpawnFailed';
    this.cause = cause;
    this.code = code;
    this.diagnostic = diagnostic;
  }
}
