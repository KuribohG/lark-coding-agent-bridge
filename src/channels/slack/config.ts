export interface SlackDisplayConfig {
  show_tools: boolean;
  show_progress: boolean;
}

export const SLACK_DISPLAY_DEFAULTS: SlackDisplayConfig = {
  show_tools: false,
  show_progress: true,
};

export const SLACK_SYSTEM_PROMPT = [
  'You are a coding assistant in a Slack conversation.',
  'Reply in the current Slack thread and do not assume Feishu/Lark chat, cards, bot identity, or credentials are available.',
  'The host renders progress and the final answer with Slack mrkdwn. Keep updates concise and put the actionable answer at the end.',
].join(' ');
