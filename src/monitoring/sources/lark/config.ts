import { table, string, boolean, integer, choice, fail } from '../../validation';
import { destinationSchema as destination, deliveryModeSchema as deliveryMode } from '../../notification';
import { defineMonitorConfig } from '../../module';
import { normalizeInbox, validateInbox } from '../../../inbox/config';
import { inboxTriageSource } from '../../../inbox/model-routing';

const schema = table({
  enabled: boolean, executorProfile: string, ownerOpenId: string, destination, deliveryMode,
  intakeScope: choice('private', 'private_mentions', 'all'), watchPrivate: boolean, watchMentions: boolean,
  autoAnalyze: (v, p) => { if (v !== false) fail(p, '旧版 autoAnalyze 仅支持 false'); },
  attentionProfile: string, analysisModel: string, triageService: string, triageProfile: string, triageModel: string,
  analysisTimeoutMinutes: integer(1, 1440),
  triageMessageLimit: integer(2, 100), triageMessageChars: integer(200, 16_000),
  dailyTriageLimit: integer(0, 1_000_000), waitMinutes: integer(1, 1440), pollSeconds: integer(1, 3600),
  contextMinutes: integer(5, 1440), maxContextChars: integer(2000, 100_000), dailyAutoLimit: integer(0, 1000),
  h5: table({ publicUrl: string, port: integer(1024, 65535) }), gui: table({ publicUrl: string, apiKeyFile: string }),
});

export const larkMonitorConfig = defineMonitorConfig({
  id: 'lark', key: 'inbox',
  parse(value) { schema(value, 'monitors.sources.lark'); const config = normalizeInbox(value); validateInbox(config); return config; },
  references(config, root) { if (config.enabled || config.triageService) inboxTriageSource(config, root); },
});
