export interface LogContext {
  traceId?: string;
  chatId?: string;
  msgId?: string;
}

export type LogFields = Record<string, unknown>;
