export type WorkItemMode = 'off' | 'on';
export interface DeliveryTarget { chatId: string; threadId: string; replyTo: string }

/** Existing inbox configuration is structurally compatible with these shared settings. */
export interface WorkItemConfig {
  enabled: boolean;
  executorProfile: string;
  ownerOpenId: string;
  destination: DeliveryTarget;
  autoAnalyze: boolean;
  dailyTriageLimit: number;
  gui: { publicUrl: string };
  h5: { publicUrl: string };
}
