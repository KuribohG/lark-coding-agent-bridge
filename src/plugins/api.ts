import type {
  Controls,
  FeatureCommandContribution,
} from '../commands/types';

export interface PluginContext {
  configPath: string;
  rootDir?: string;
  controlsFor(profile: string): Controls | undefined;
}

export interface PluginHttpRequest {
  method: string;
  path: string;
  url: URL;
  readJson(): Promise<unknown>;
}

export interface PluginHttpResponse {
  status?: number;
  body: unknown;
}

export interface PluginHttpRoute {
  id: string;
  path: string | RegExp;
  methods?: readonly string[];
  handle(request: PluginHttpRequest): Promise<PluginHttpResponse> | PluginHttpResponse;
}

export interface PluginAction {
  type: string;
  [key: string]: unknown;
}

/**
 * A host extension that owns its lifecycle and contributes capabilities.
 * Plugins are statically composed; configuration never loads executable code.
 */
export interface BridgePlugin {
  readonly id: string;
  readonly commands?: readonly FeatureCommandContribution[];
  readonly httpRoutes?: readonly PluginHttpRoute[];
  validateAction?(action: PluginAction): Promise<void> | void;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

export type BridgePluginFactory = (context: PluginContext) => readonly BridgePlugin[];

export function pluginRouteMatches(
  route: PluginHttpRoute,
  method: string,
  path: string,
): boolean {
  if (route.methods && !route.methods.includes(method)) return false;
  return typeof route.path === 'string' ? route.path === path : route.path.test(path);
}
