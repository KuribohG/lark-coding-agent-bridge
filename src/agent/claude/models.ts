import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentExecutionProfile } from '../../config/profile-schema';
import { readOptional } from '../model-files';
import { parseEffort, type ModelEnvironment } from '../model-settings';
import { supportedModels, validateModelId } from '../models';

export async function readClaudeModels(profile: AgentExecutionProfile): Promise<ModelEnvironment> {
  const fallback = { defaults: {}, models: supportedModels('claude') };
    const configDir = profile.claude?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const text = await readOptional(join(configDir, 'settings.json'));
    const settings = text ? JSON.parse(text) : {};
    const model = process.env.ANTHROPIC_MODEL ?? settings.model;
    return {
      ...fallback,
      defaults: {
        ...(typeof model === 'string' && model !== 'default' ? { model: validateModelId(model) } : {}),
        reasoningEffort: parseEffort(process.env.CLAUDE_CODE_EFFORT_LEVEL ?? settings.effortLevel, 'claude'),
      },
    };
}
