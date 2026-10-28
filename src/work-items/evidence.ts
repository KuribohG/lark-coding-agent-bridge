export interface EvidenceMention {
  id: string;
  name: string;
  key?: string;
}

export interface EvidenceMessage {
  id: string;
  containerId: string;
  containerName: string;
  containerKind: string;
  senderId: string;
  senderName: string;
  senderBot: boolean;
  senderAliases?: string[];
  time: number;
  text: string;
  threadId?: string;
  replyTo?: string;
  link?: string;
  sequence?: string;
  mentions: EvidenceMention[];
  metadata?: Record<string, unknown>;
}

export interface Attention {
  state: 'pending' | 'needed' | 'quiet' | 'uncertain';
  reason: string;
  priority?: 'normal' | 'high';
  /** Evidence message IDs whose structured mentions matched the relevant principal. */
  mentionedPrincipalMessageIds?: string[];
  /** Execution failures stay pending; genuine uncertainty is a completed decision. */
  retry?: { attempts: number; nextAt: number; error: string };
  /** Transient output preview; not a final decision and never persisted to the store. */
  progress?: { startedAt: number; updatedAt: number; text: string };
}

export type TriageDecision = Attention & {
  id: string;
  followUp?: 'unchanged' | 'reanalyze' | 'resolved';
};
