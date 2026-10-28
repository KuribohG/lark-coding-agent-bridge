import type { FeatureCommandContribution } from '../commands/types';
import {
  pluginRouteMatches,
  type BridgePlugin,
  type BridgePluginFactory,
  type PluginAction,
  type PluginContext,
  type PluginHttpRoute,
} from './api';

export class PluginHost {
  private readonly plugins = new Map<string, BridgePlugin>();
  private closing?: Promise<void>;

  constructor(factory: BridgePluginFactory | undefined, context: PluginContext) {
    const plugins = factory?.(context) ?? [];
    for (const plugin of plugins) {
      if (!plugin.id.trim()) throw new Error('plugin id is required');
      if (this.plugins.has(plugin.id)) throw new Error(`duplicate plugin: ${plugin.id}`);
      this.plugins.set(plugin.id, plugin);
    }
    this.validateRoutes();
  }

  get<T extends BridgePlugin = BridgePlugin>(id: string): T | undefined {
    return this.plugins.get(id) as T | undefined;
  }

  commands(): FeatureCommandContribution[] {
    return [...this.plugins.values()].flatMap(plugin => [...(plugin.commands ?? [])]);
  }

  routes(): PluginHttpRoute[] {
    return [...this.plugins.values()].flatMap(plugin => [...(plugin.httpRoutes ?? [])]);
  }

  findRoute(method: string, path: string): PluginHttpRoute | undefined {
    return this.routes().find(route => pluginRouteMatches(route, method, path));
  }

  async validateAction(action: PluginAction): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.validateAction?.(action);
    }
  }

  async reconcile(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.plugins.values()].map(plugin => plugin.reconcile()),
    );
    throwIfFailed(results, 'plugin reconcile failed');
  }

  close(): Promise<void> {
    return this.closing ??= this.closeAll();
  }

  private async closeAll(): Promise<void> {
    const results: PromiseSettledResult<void>[] = [];
    for (const plugin of [...this.plugins.values()].reverse()) {
      try {
        await plugin.close();
        results.push({ status: 'fulfilled', value: undefined });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }
    }
    this.plugins.clear();
    throwIfFailed(results, 'plugin shutdown failed');
  }

  private validateRoutes(): void {
    const ids = new Set<string>();
    const routes = this.routes();
    for (const route of routes) {
      if (!route.id.trim()) throw new Error('plugin route id is required');
      if (ids.has(route.id)) throw new Error(`duplicate plugin route: ${route.id}`);
      ids.add(route.id);
    }
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        const left = routes[i]!;
        const right = routes[j]!;
        if (!routesCanOverlap(left, right)) continue;
        const methods = routeMethods(left).filter(method => routeMethods(right).includes(method));
        if (methods.length) {
          throw new Error(`overlapping plugin routes: ${left.id} and ${right.id}`);
        }
      }
    }
  }
}

function routeMethods(route: PluginHttpRoute): readonly string[] {
  return route.methods ?? ['GET', 'POST'];
}

function routesCanOverlap(left: PluginHttpRoute, right: PluginHttpRoute): boolean {
  if (typeof left.path === 'string' && typeof right.path === 'string') {
    return left.path === right.path;
  }
  if (left.path instanceof RegExp && right.path instanceof RegExp) {
    return true;
  }
  const literal = typeof left.path === 'string' ? left.path : right.path as string;
  const pattern = left.path instanceof RegExp ? left.path : right.path as RegExp;
  return pattern.test(literal);
}

function throwIfFailed(results: PromiseSettledResult<void>[], message: string): void {
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), message);
}
