import { expect, it, vi } from 'vitest';
import { frameRows, GrafanaQueryClient, numberField, type QueryClient } from '../../../src/storage-monitor/grafana';
import { GrafanaStorageProvider } from '../../../src/storage-monitor/provider';
import { parseStorageConfig } from '../../../src/storage-monitor/config';

const config = () => parseStorageConfig({ platforms: [{ id: 'p', datasource: 'db' }], maxTasks: 2 });
const watch = { id: 'u', kind: 'user' as const, uid: 42, platform: 'p', enabled: true, clusters: [] };
const signal = new AbortController().signal;
const row = { id: '123', chain_id: 'chain', user_name: 'alice', queue_status: 'scheduled', nodes: ['n1'], pods: '["alice-123-0"]' };
it('resolves numeric UID using the user table and scans active plus newly finished runs', async () => {
  const query = vi.fn().mockResolvedValueOnce([{ user_name: 'alice' }]).mockResolvedValueOnce([row]);
  const provider = new GrafanaStorageProvider(config(), { query }, () => 1_800_000_000_000);
  const runs = await provider.tasks(watch, ['previous-chain'], 1_799_999_000_000, signal);
  expect(query.mock.calls[0]![2]).toContain('WHERE user_id = 42');
  const sql = query.mock.calls[1]![2];
  expect(sql).toContain('unfinished_task_ng'); expect(sql).toContain('task_ng');
  expect(sql).toContain('DISTINCT ON (chain_id)'); expect(sql).toContain('previous-chain');
  expect(sql).not.toContain('config_json');
  expect(runs).toEqual([{ id: '123', chainId: 'chain', user: 'alice', status: 'scheduled', nodes: ['n1'], pods: ['alice-123-0'] }]);
});
it.each(['missing', 'overflow', 'wrong-owner'])('treats %s discovery as unknown', async kind => {
  const query = vi.fn().mockResolvedValueOnce(kind === 'missing' ? [] : [{ user_name: 'alice' }])
    .mockResolvedValueOnce(kind === 'overflow' ? [row, row, row] : [{ ...row, user_name: 'bob' }]);
  await expect(new GrafanaStorageProvider(config(), { query }).tasks(watch, [], 0, signal)).rejects.toThrow();
});
it('computes weighted latency and validates metric rows', async () => {
  const c = parseStorageConfig({ latencyMs: 100, clusters: [{ id: 'c', database: 'metrics', datasource: 'ch' }] });
  const query: QueryClient['query'] = vi.fn().mockResolvedValueOnce([{ pod: 'p', at: 100, failures: 2, chunks: 50 }])
    .mockResolvedValueOnce([{ pod: 'p', latency: 200 }]).mockResolvedValueOnce([{ at: 100, connected: 20 }]);
  const result = await new GrafanaStorageProvider(c, { query }).cluster(c.clusters[0]!, signal);
  expect(result.io[0]?.latencyMs).toBe(200);
  expect(vi.mocked(query).mock.calls[1]![2]).toContain('sum(count * mean) / nullIf(sum(count), 0)');
  expect(() => numberField({ value: null }, 'value')).toThrow();
});
it('does not convert partial frames or source errors into zero values', () => {
  expect(() => frameRows({ results: { A: { error: 'SENSITIVE SQL', frames: [] } } })).toThrow('查询未成功');
  expect(() => frameRows({ results: { A: { frames: [{ schema: { fields: [{ name: 'a' }] }, data: { values: [[1], [2]] } }] } } })).toThrow('数据列不完整');
  expect(frameRows({ results: { A: { frames: [] } } })).toEqual([]);
});
it('does not follow redirects or expose upstream response bodies', async () => {
  const request = vi.fn().mockResolvedValue(new Response('SENSITIVE', { status: 401 }));
  await expect(new GrafanaQueryClient({ url: 'https://example.com', headers: {} }, request).query('uid', 'postgres', 'SELECT 1', signal)).rejects.toThrow('Grafana HTTP 401');
  expect(request.mock.calls[0]![1].redirect).toBe('error');
});
