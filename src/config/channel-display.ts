/** Display preferences of the non-Lark channels, stored under `channels.*` in the profile config. */
export interface WebDisplayConfig {
  show_tools: boolean;
  show_reasoning: boolean;
}

export const WEB_DISPLAY_DEFAULTS: WebDisplayConfig = { show_tools: true, show_reasoning: true };

export interface SlackDisplayConfig {
  show_tools: boolean;
  show_progress: boolean;
}

export const SLACK_DISPLAY_DEFAULTS: SlackDisplayConfig = {
  show_tools: false,
  show_progress: true,
};
