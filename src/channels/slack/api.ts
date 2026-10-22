import { WebClient } from '@slack/web-api';

export interface SlackAuthIdentity {
  teamId: string;
  userId: string;
  teamName?: string;
  userName?: string;
}

export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs: string;
}

export interface SlackUpdateMessageInput {
  channel: string;
  ts: string;
  text: string;
}

export interface SlackReactionInput {
  channel: string;
  timestamp: string;
  name: string;
}

export interface SlackApi {
  authTest(): Promise<SlackAuthIdentity>;
  postMessage(input: SlackPostMessageInput): Promise<string>;
  updateMessage(input: SlackUpdateMessageInput): Promise<void>;
  addReaction(input: SlackReactionInput): Promise<void>;
  removeReaction(input: SlackReactionInput): Promise<void>;
}

export function createSlackApi(botToken: string): SlackApi {
  if (!botToken.trim()) throw new Error('Slack bot token is required');
  const client = new WebClient(botToken);

  return {
    async authTest() {
      const response = await client.auth.test();
      if (!response.team_id || !response.user_id) {
        throw new Error('Slack auth.test did not return team_id and user_id');
      }
      return {
        teamId: response.team_id,
        userId: response.user_id,
        ...(response.team ? { teamName: response.team } : {}),
        ...(response.user ? { userName: response.user } : {}),
      };
    },

    async postMessage(input) {
      const response = await client.chat.postMessage({
        channel: input.channel,
        text: input.text,
        thread_ts: input.threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!response.ok || !response.ts) throw new Error('Slack chat.postMessage failed');
      return response.ts;
    },

    async updateMessage(input) {
      const response = await client.chat.update({
        channel: input.channel,
        ts: input.ts,
        text: input.text,
      });
      if (!response.ok) throw new Error('Slack chat.update failed');
    },

    async addReaction(input) {
      const response = await client.reactions.add({
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
      });
      if (!response.ok) throw new Error('Slack reactions.add failed');
    },

    async removeReaction(input) {
      const response = await client.reactions.remove({
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
      });
      if (!response.ok) throw new Error('Slack reactions.remove failed');
    },
  };
}
