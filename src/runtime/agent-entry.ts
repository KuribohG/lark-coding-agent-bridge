/** Selected by the bridge before preparing an agent turn, never inferred by the model. */
export type AgentEntry =
  | { kind: 'direct' }
  | { kind: 'workflow'; trigger: 'command' | 'event' };
