export interface EvidenceMessage {
  id: string;
  chatId: string;
  chatName: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  senderOpenId?: string;
  senderName: string;
  bot: boolean;
  time: number;
  text: string;
  threadId?: string;
  parentId?: string;
  link?: string;
  position?: string;
  mentions: string[];
  mentionDetails?: { openId: string; name: string; key?: string }[];
  incidentId?: string;
  recovered?: boolean;
}

export interface Attention {
  state: 'pending' | 'needed' | 'quiet' | 'uncertain';
  reason: string;
  priority?: 'normal' | 'high';
  /** Message IDs whose structured mentions were checked against the owner ID. */
  ownerMentionMessageIds?: string[];
  /** Execution failures stay pending; genuine uncertainty is a completed decision. */
  retry?: { attempts: number; nextAt: number; error: string };
  /** Transient output preview; not a final decision and never persisted to the store. */
  progress?: { startedAt: number; updatedAt: number; text: string };
}

export type TriageDecision = Attention & {
  id: string;
  followUp?: 'unchanged' | 'reanalyze' | 'resolved';
};
