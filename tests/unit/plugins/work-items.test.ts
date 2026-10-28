import { expect, it } from 'vitest';
import { pluginRouteMatches } from '../../../src/plugins/api';
import { createWorkItemsPlugin } from '../../../src/plugins/work-items/plugin';

it('contributes inbox command and HTTP routes through the plugin boundary', async () => {
  const plugin = createWorkItemsPlugin({
    configPath: '/tmp/config.toml',
    controlsFor: () => undefined,
  });
  try {
    expect(plugin.id).toBe('work-items');
    expect(plugin.commands).toEqual([
      expect.objectContaining({
        pluginId: 'work-items',
        definition: expect.objectContaining({
          name: 'inbox',
          pending: 'preserve',
        }),
      }),
    ]);
    for (const [method, path] of [
      ['GET', '/api/inbox'],
      ['POST', '/api/inbox'],
      ['POST', '/api/inbox/concurrency'],
      ['GET', '/api/inbox/workbench'],
      ['POST', '/api/inbox/command'],
      ['POST', '/api/inbox/check'],
    ] as const) {
      expect(
        plugin.httpRoutes?.some(route => pluginRouteMatches(route, method, path)),
        `${method} ${path}`,
      ).toBe(true);
    }
  } finally {
    await plugin.close();
  }
});
