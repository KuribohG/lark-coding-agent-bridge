import { LogLevel, SocketModeClient } from '@slack/socket-mode';

export interface SlackMessageEvent {
  type: 'message' | 'app_mention';
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel: string;
  channel_type?: 'im' | 'channel' | 'group' | 'mpim';
  ts: string;
  thread_ts?: string;
}

export interface SlackEventEnvelope {
  event: SlackMessageEvent;
  eventId?: string;
  teamId: string;
}

export type SlackEventHandler = (input: SlackEventEnvelope) => Promise<void> | void;
export type SlackTransportErrorHandler = (error: unknown) => void;

export interface SlackTransport {
  onEvent(type: SlackMessageEvent['type'], handler: SlackEventHandler): void;
  onError(handler: SlackTransportErrorHandler): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface SlackSocketPayload {
  ack: () => Promise<void>;
  body: {
    team_id?: string;
    event_id?: string;
    authorizations?: Array<{ team_id?: string }>;
  };
  event: SlackMessageEvent;
}

export function createSocketModeSlackTransport(appToken: string): SlackTransport {
  if (!appToken.trim()) throw new Error('Slack app-level token is required');
  const client = new SocketModeClient({
    appToken,
    autoReconnectEnabled: true,
    logLevel: LogLevel.ERROR,
  });
  const errorHandlers: SlackTransportErrorHandler[] = [];

  client.on('error', error => {
    for (const handler of errorHandlers) handler(error);
  });

  return {
    onEvent(type, handler) {
      client.on(type, (raw: SlackSocketPayload) => {
        const teamId =
          raw.body.team_id ??
          raw.body.authorizations?.find(item => item.team_id)?.team_id;
        if (!teamId) {
          void raw.ack().catch(error => {
            for (const onError of errorHandlers) onError(error);
          });
          return;
        }
        void (async () => {
          await raw.ack();
          await handler({
            event: raw.event,
            teamId,
            ...(raw.body.event_id ? { eventId: raw.body.event_id } : {}),
          });
        })().catch(error => {
          for (const onError of errorHandlers) onError(error);
        });
      });
    },

    onError(handler) {
      errorHandlers.push(handler);
    },

    async start() {
      await client.start();
    },

    async close() {
      await client.disconnect();
    },
  };
}
