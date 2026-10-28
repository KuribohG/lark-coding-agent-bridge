import { describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../../../src/plugins/host';
import type {
  BridgePlugin,
  PluginContext,
  PluginHttpRoute,
} from '../../../src/plugins/api';

const context: PluginContext = {
  configPath: '/tmp/config.toml',
  controlsFor: () => undefined,
};

describe('plugin host', () => {
  it('composes lifecycle, commands and HTTP routes without knowing concrete plugins', async () => {
    const calls: string[] = [];
    const route: PluginHttpRoute = {
      id: 'example:status',
      path: '/api/example',
      methods: ['GET'],
      handle: () => ({ body: { ok: true } }),
    };
    const first: BridgePlugin = {
      id: 'first',
      httpRoutes: [route],
      commands: [{
        pluginId: 'first',
        definition: {
          name: 'example',
          access: 'user',
          pending: 'preserve',
          arguments: 'words',
          help: ['`/example` — example plugin'],
        },
        handler: async () => {},
      }],
      validateAction: async action => { calls.push(`first:validate:${action.type}`); },
      reconcile: async () => { calls.push('first:reconcile'); },
      close: async () => { calls.push('first:close'); },
    };
    const second: BridgePlugin = {
      id: 'second',
      reconcile: async () => { calls.push('second:reconcile'); },
      close: async () => { calls.push('second:close'); },
    };
    const host = new PluginHost(() => [first, second], context);

    expect(host.get('first')).toBe(first);
    expect(host.commands()).toHaveLength(1);
    expect(host.findRoute('GET', '/api/example')).toBe(route);
    expect(host.findRoute('POST', '/api/example')).toBeUndefined();
    await host.validateAction({ type: 'example.remove', resource: 'one' });
    await host.reconcile();
    await host.close();
    expect(calls).toEqual([
      'first:validate:example.remove',
      'first:reconcile',
      'second:reconcile',
      'second:close',
      'first:close',
    ]);
  });

  it('rejects duplicate plugin and route identities', () => {
    const plugin = (id: string, path?: string): BridgePlugin => ({
      id,
      ...(path ? {
        httpRoutes: [{
          id: `${id}:route`,
          path,
          methods: ['GET'],
          handle: () => ({ body: null }),
        }],
      } : {}),
      reconcile: async () => {},
      close: async () => {},
    });
    expect(() => new PluginHost(() => [plugin('same'), plugin('same')], context))
      .toThrow('duplicate plugin');
    expect(() => new PluginHost(() => [
      plugin('first', '/api/duplicate'),
      plugin('second', '/api/duplicate'),
    ], context)).toThrow('overlapping plugin routes');
  });

  it('contains plugin failures and closes the remaining plugins', async () => {
    const close = vi.fn(async () => {});
    const host = new PluginHost(() => [{
      id: 'broken',
      reconcile: async () => { throw new Error('broken'); },
      close,
    }], context);
    await expect(host.reconcile()).rejects.toThrow('plugin reconcile failed');
    await host.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
