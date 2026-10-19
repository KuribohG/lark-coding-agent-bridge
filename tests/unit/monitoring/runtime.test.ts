import { createMonitorRuntime, createMonitorHost } from '../../../src/host/monitors';
import { expect, it, vi } from 'vitest';
import { MonitorRuntime } from '../../../src/monitoring/runtime';
import type { MonitorContext, MonitorModule } from '../../../src/monitoring/module';

const context = { configPath: '/unused/config.json', host: createMonitorHost('/unused/config.json') };
const controller = () => ({ reconcile: vi.fn(async () => {}), close: vi.fn(async () => {}) });

it('shares one engine and closes collectors before the engine, exactly once', async () => {
  const contexts: MonitorContext[] = [];
  const order: string[] = [];
  const module = (id: string): MonitorModule => ({ id, create: c => {
    contexts.push(c); return { reconcile: async () => {}, close: async () => { order.push(id); } };
  } });
  const runtime = new MonitorRuntime(context, { one: module('one'), two: module('two') });
  expect(contexts[0]!.sources).toBe(contexts[1]!.sources);
  expect(contexts[0]!.host).toBe(context.host);
  vi.spyOn(runtime.sources, 'close').mockImplementation(async () => { order.push('engine'); });
  await Promise.all([runtime.close(), runtime.close()]);
  expect(order).toEqual(['two', 'one', 'engine']);
});

it('reconciles other modules while one source waits for I/O', async () => {
  let release!: () => void;
  const first = controller(), second = controller();
  first.reconcile.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const runtime = new MonitorRuntime(context, {
    one: { id: 'one', create: () => first }, two: { id: 'two', create: () => second },
  });
  const reconcile = runtime.reconcile();
  expect(second.reconcile).toHaveBeenCalledOnce();
  release(); await reconcile; await runtime.close();
});

it('does not skip other modules after a reconcile failure and allows later retries', async () => {
  const first = controller(), second = controller();
  first.reconcile.mockImplementationOnce(() => { throw new Error('fixture'); });
  const runtime = new MonitorRuntime(context, {
    one: { id: 'one', create: () => first }, two: { id: 'two', create: () => second },
  });
  await expect(runtime.reconcile()).rejects.toThrow(AggregateError);
  expect(second.reconcile).toHaveBeenCalledOnce();
  await runtime.reconcile(); expect(second.reconcile).toHaveBeenCalledTimes(2);
  await runtime.close();
});

it('releases every module and the engine even if a close fails; never restarts during shutdown', async () => {
  const first = controller(), second = controller();
  second.close.mockRejectedValue(new Error('fixture'));
  const runtime = new MonitorRuntime(context, {
    one: { id: 'one', create: () => first }, two: { id: 'two', create: () => second },
  });
  const close = vi.spyOn(runtime.sources, 'close');
  await expect(runtime.close()).rejects.toThrow(AggregateError);
  expect(first.close).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  await runtime.reconcile(); expect(first.reconcile).not.toHaveBeenCalled();
  await expect(runtime.close()).rejects.toThrow(AggregateError);
  expect(close).toHaveBeenCalledOnce();
});

it('built-in modules leave the shared engine owned by their host', async () => {
  const runtime = createMonitorRuntime({ ...context, profiles: () => undefined });
  const close = vi.spyOn(runtime.sources, 'close');
  await runtime.controllers.lark.close();
  expect(close).not.toHaveBeenCalled();
  await runtime.close();
  expect(close).toHaveBeenCalledOnce();
});
