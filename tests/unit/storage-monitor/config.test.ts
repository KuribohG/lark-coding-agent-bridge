import { expect, it } from 'vitest';
import { parseMonitorConfig, formatMonitorConfig } from '../../../src/monitoring/config';
import { parseStorageConfig } from '../../../src/storage-monitor/config';

it('round trips UID and cluster subscriptions alongside existing sources', () => {
  const config = parseMonitorConfig(`version = 1
[sources.lark]
enabled = false
[sources.gitlab_ci]
enabled = false
[sources.storage]
enabled = false
[[sources.storage.clusters]]
id = "prod"
datasource = "metrics"
database = "hf3fs_prod"
[[sources.storage.platforms]]
id = "platform"
datasource = "tasks"
[[sources.storage.watches]]
id = "user-42"
kind = "user"
platform = "platform"
uid = 42
clusters = ["prod"]
[[sources.storage.watches]]
id = "important"
kind = "cluster"
cluster = "prod"
`);
  expect(config.storageMonitor?.model).toBe('deepseek-flash');
  expect(config.storageMonitor?.watches).toHaveLength(2);
  expect(parseMonitorConfig(formatMonitorConfig(config))).toEqual(config);
});

it.each([
  [{ enabled: true }, 'executorProfile'],
  [{ watches: [{ id: 'one', kind: 'chain', chainId: 'chain' }] }, 'kind'],
  [{ watches: [{ id: 'one', kind: 'user', platform: 'x', uid: '42' }] }, 'uid'],
  [{ clusters: [{ id: 'a', datasource: 'd', database: 'db;DROP' }] }, 'database'],
  [{ clusters: [{ id: 'a', datasource: 'd', database: 'db' }, { id: 'a', datasource: 'd', database: 'db' }] }, 'id'],
  [{ grafana: { token: 'SENSITIVE' } }, 'token'],
  [{ grafana: { url: 'https://user:secret@example.com' } }, 'url'],
  [{ pollSeconds: 1 }, 'pollSeconds'],
  [{ outputDir: 'relative' }, 'outputDir'],
])('rejects invalid source settings without silent coercion', (value, field) => {
  expect(() => parseStorageConfig(value)).toThrow(field as string);
});
