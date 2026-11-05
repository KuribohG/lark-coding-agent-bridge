import { table, string, boolean, integer, choice } from '../../validation';
import { targetSchema as target, deliveryModeSchema as deliveryMode } from '../../notification';
import { defineMonitorConfig } from '../../module';
import { INTAKE_SCOPES, normalizeInbox, validateInbox } from '../../../inbox/config';
import { inboxTriageService } from '../../../inbox/model-routing';

const schema = table({
  enabled: boolean, executorProfile: string, recipientKey: string, target, deliveryMode,
  intakeScope: choice(...INTAKE_SCOPES),
  attentionProfile: string, analysisModel: string, triageService: string, triageModel: string,
  analysisTimeoutMinutes: integer(1, 1440),
  workbenchUrl: string,
  triageMessageLimit: integer(2, 100), triageMessageChars: integer(200, 16_000),
  dailyTriageLimit: integer(0, 1_000_000), pollSeconds: integer(1, 3600),
  contextMinutes: integer(5, 1440), maxContextChars: integer(2000, 100_000),
  h5: table({ publicUrl: string, port: integer(1024, 65535) }), gui: table({ publicUrl: string, apiKeyFile: string }),
});

export const larkMonitorConfig = defineMonitorConfig({
  id: 'lark', key: 'inbox',
  parse(value) { schema(value, 'monitors.sources.lark'); const config = normalizeInbox(value); validateInbox(config); return config; },
  format(config) {
    const { ownerKey: _, ...stored } = config;
    return JSON.parse(JSON.stringify(stored));
  },
  references(config, root) { if (config.enabled || config.triageService) inboxTriageService(config, root); },
});
