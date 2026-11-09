import type { AgentKind } from '../../config/profile-schema';

/** Per-scope facts carried between turns of one channel connection; a restart starts empty. */
export class ScopeRunMemory {
  private readonly fingerprints = new Map<string, string>();
  private readonly models = new Map<string, string>();

  /** Policy fingerprint of the scope's running turn, checked by card callbacks. */
  policyFingerprint(scope: string): string | undefined {
    return this.fingerprints.get(scope);
  }

  runStarted(scope: string, policyFingerprint: string): void {
    this.fingerprints.set(scope, policyFingerprint);
  }

  runEnded(scope: string): void {
    this.fingerprints.delete(scope);
  }

  /** Records this turn's model and reports whether the scope's previous turn used another one. */
  modelSwitched(agentKind: AgentKind, scope: string, selection: string): boolean {
    const key = `${agentKind}\x1f${scope}`;
    const previous = this.models.get(key);
    this.models.set(key, selection);
    return previous !== undefined && previous !== selection;
  }
}
