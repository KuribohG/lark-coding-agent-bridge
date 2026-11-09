import type { IncomingMessage, ServerResponse } from 'node:http';
import { readActiveProfile } from '../config/profile-store';
import type { MutableProfileState } from '../config/config-ops';
import {
  addBotToChatView,
  meetingJoin,
  meetingPreflight,
  meetingLeave,
  meetingsView,
  applyConfig,
  applyConfigToDisk,
  buildConfigView,
  listChats,
  loadProfileState,
  mutateAccess,
  userAuthStatus,
  userChatsView,
  userLoginComplete,
  userLoginStart,
} from './api';
import { activateProfile, listBots, listProfiles, setProfileAutostart } from './fleet';
import { resolveAppPaths } from '../config/app-paths';
import { modelServiceName } from '../model-service/config';
import { checkModelService, configureModelService, listModelServices, removeModelService } from '../model-service/registry';
import { onboardCreate, onboardState, onboardValidate } from './onboard';
import { finishQrRegistration, qrStatus, startQrRegistration } from './qr-register';
import { HttpError, readJsonBody, sendJson } from './http';
import type { Controls } from '../commands';
import type { UiServerDeps } from './types';
import { pluginRouteMatches } from '../plugins/api';

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  deps: UiServerDeps;
  url: URL;
}

type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** When false the route is treated as absent (falls through to plugins / 404). */
  enabled?: (deps: UiServerDeps) => boolean;
  handle: RouteHandler;
}

/** Resolve the target profile's state + whether edits apply live (online). */
async function resolveTargetState(
  deps: UiServerDeps,
  url: URL,
): Promise<{ state: MutableProfileState; live: boolean; controls?: Controls }> {
  const profile = url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
  if (!profile) throw new HttpError(400, 'no profile');
  const controls = deps.supervisor.controlsFor(profile);
  if (controls) return { state: controls, live: true, controls };
  return { state: await loadProfileState(profile, deps.rootDir), live: false };
}

async function queryProfile({ deps, url }: RouteContext): Promise<string | undefined> {
  return url.searchParams.get('profile') ?? (await readActiveProfile(deps.rootDir));
}

async function requireQueryProfile(ctx: RouteContext): Promise<string> {
  const profile = await queryProfile(ctx);
  if (!profile) throw new HttpError(400, 'no profile');
  return profile;
}

async function requireBodyProfile(deps: UiServerDeps, body: { profile?: string }): Promise<string> {
  const profile = body.profile ?? (await readActiveProfile(deps.rootDir));
  if (!profile) throw new HttpError(400, 'profile is required');
  return profile;
}

// --- model services ---

type ModelServiceAction = (
  ctx: RouteContext,
  configPath: string,
) => Promise<void>;

/** Every model-service failure, including body parsing, surfaces as a 400. */
function modelServiceRoute(action: ModelServiceAction): RouteHandler {
  return async (ctx) => {
    const configPath = resolveAppPaths({ rootDir: ctx.deps.rootDir }).configFile;
    try {
      await action(ctx, configPath);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : '模型服务配置失败');
    }
  };
}

async function readModelServiceBody(req: IncomingMessage): Promise<{ name: string; config: unknown }> {
  const input = await readJsonBody(req);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型服务请求须为对象');
  const body = input as { name?: unknown; config?: unknown };
  return { name: modelServiceName(body.name), config: body.config };
}

async function sendModelServices({ res, deps }: RouteContext, configPath: string): Promise<void> {
  await deps.supervisor.reconcilePlugins?.();
  sendJson(res, 200, { services: await listModelServices(configPath) });
}

const listModelServicesRoute = modelServiceRoute(async ({ res }, configPath) => {
  sendJson(res, 200, { services: await listModelServices(configPath) });
});

const configureModelServiceRoute = modelServiceRoute(async (ctx, configPath) => {
  const { name, config } = await readModelServiceBody(ctx.req);
  await configureModelService(configPath, name, config);
  await sendModelServices(ctx, configPath);
});

const checkModelServiceRoute = modelServiceRoute(async ({ req, res }, configPath) => {
  const { name } = await readModelServiceBody(req);
  sendJson(res, 200, await checkModelService(configPath, name));
});

const removeModelServiceRoute = modelServiceRoute(async (ctx, configPath) => {
  const { name } = await readModelServiceBody(ctx.req);
  await ctx.deps.supervisor.validatePluginAction?.({
    type: 'model-service.remove',
    resource: name,
  });
  await removeModelService(configPath, name);
  await sendModelServices(ctx, configPath);
});

// --- host ---

function shutdown({ res, deps }: RouteContext): void {
  sendJson(res, 200, { ok: true });
  setImmediate(deps.requestShutdown!);
}

async function status({ res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, {
    hosted: true,
    pid: process.pid,
    version: deps.version,
    activeProfile: await readActiveProfile(deps.rootDir),
    online: deps.supervisor.list().length,
  });
}

// --- online channels ---

function bots({ res, deps }: RouteContext): void {
  sendJson(res, 200, { bots: listBots(deps.supervisor, deps.version, Date.now()) });
}

// --- profiles ---

async function profiles({ res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, { profiles: await listProfiles(deps.supervisor, deps.rootDir) });
}

async function createProfile({ req, res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, await onboardCreate(await readJsonBody(req), deps.rootDir));
}

async function startProfile({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string };
  if (!body.profile) throw new HttpError(400, 'profile is required');
  try {
    await deps.supervisor.startProfile(body.profile);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  sendJson(res, 200, { ok: true, profile: body.profile });
}

async function stopProfile({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string };
  if (!body.profile) throw new HttpError(400, 'profile is required');
  await deps.supervisor.stopProfile(body.profile);
  sendJson(res, 200, { ok: true, profile: body.profile });
}

async function activate({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string };
  if (!body.profile) throw new HttpError(400, 'profile is required');
  sendJson(res, 200, await activateProfile(body.profile, deps.rootDir));
}

async function autostart({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string; enabled?: boolean };
  if (!body.profile || typeof body.enabled !== 'boolean') {
    throw new HttpError(400, 'profile and enabled are required');
  }
  sendJson(res, 200, await setProfileAutostart(body.profile, body.enabled, deps.rootDir));
}

async function validateProfile({ req, res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, await onboardValidate(await readJsonBody(req), deps.rootDir));
}

async function qrStart({ res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, await startQrRegistration(deps.rootDir));
}

function qrPoll({ res, url }: RouteContext): void {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) throw new HttpError(400, 'sessionId is required');
  sendJson(res, 200, qrStatus(sessionId));
}

async function qrFinish({ req, res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, await finishQrRegistration(await readJsonBody(req), deps.rootDir));
}

async function onboard({ res, deps }: RouteContext): Promise<void> {
  sendJson(res, 200, await onboardState(deps.rootDir));
}

// --- per-profile config ---

async function getConfig({ res, deps, url }: RouteContext): Promise<void> {
  const { state, live } = await resolveTargetState(deps, url);
  sendJson(res, 200, await buildConfigView(state, live));
}

async function postConfig({ req, res, deps, url }: RouteContext): Promise<void> {
  const { state, live, controls } = await resolveTargetState(deps, url);
  const body = await readJsonBody(req);
  sendJson(res, 200, live && controls ? await applyConfig(controls, body) : await applyConfigToDisk(state, body));
}

async function access({ req, res, deps, url }: RouteContext): Promise<void> {
  const { state } = await resolveTargetState(deps, url);
  sendJson(res, 200, await mutateAccess(state, await readJsonBody(req)));
}

async function chats(ctx: RouteContext): Promise<void> {
  const profile = await queryProfile(ctx);
  sendJson(ctx.res, 200, await listChats(profile ? ctx.deps.supervisor.channelFor(profile) : undefined));
}

// --- "我的群": owner's groups via user identity (lark-cli device-flow auth) ---

async function authStatus(ctx: RouteContext): Promise<void> {
  const profile = await requireQueryProfile(ctx);
  sendJson(ctx.res, 200, await userAuthStatus(profile, ctx.deps.rootDir));
}

async function loginStart({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string; scopes?: unknown };
  const profile = await requireBodyProfile(deps, body);
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === 'string')
    : undefined;
  sendJson(res, 200, await userLoginStart(profile, deps.rootDir, scopes));
}

async function loginComplete({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string; deviceCode?: string };
  const profile = await requireBodyProfile(deps, body);
  sendJson(res, 200, await userLoginComplete(profile, deps.rootDir, body));
}

async function userChats(ctx: RouteContext): Promise<void> {
  const profile = await requireQueryProfile(ctx);
  const { url, deps } = ctx;
  const query = url.searchParams.get('query') ?? undefined;
  const pageToken = url.searchParams.get('pageToken') ?? undefined;
  sendJson(ctx.res, 200, await userChatsView(profile, deps.rootDir, deps.supervisor.channelFor(profile), { query, pageToken }));
}

async function addBot({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string; chatId?: string };
  const profile = await requireBodyProfile(deps, body);
  sendJson(res, 200, await addBotToChatView(profile, deps.rootDir, body));
}

// --- in-meeting agent (智能体入会) ---

async function meetings(ctx: RouteContext): Promise<void> {
  const profile = await requireQueryProfile(ctx);
  const controls = ctx.deps.supervisor.controlsFor(profile);
  // Falls back to disk config so a stopped profile still reports why it's
  // unavailable rather than looking broken.
  const enabled = controls
    ? controls.profileConfig.meeting.enabled
    : (await loadProfileState(profile, ctx.deps.rootDir)).profileConfig.meeting.enabled;
  sendJson(ctx.res, 200, meetingsView(controls?.meeting, enabled));
}

async function preflight(ctx: RouteContext): Promise<void> {
  const profile = await requireQueryProfile(ctx);
  // The probe needs some user open_id; the bot owner is the natural choice.
  const probeUserId = ctx.deps.supervisor.controlsFor(profile)?.botOwnerId;
  sendJson(ctx.res, 200, await meetingPreflight(profile, ctx.deps.rootDir, probeUserId));
}

async function join({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string; meetingNo?: string };
  const profile = await requireBodyProfile(deps, body);
  sendJson(res, 200, await meetingJoin(deps.supervisor.controlsFor(profile)?.meeting, body));
}

async function leave({ req, res, deps }: RouteContext): Promise<void> {
  const body = (await readJsonBody(req)) as { profile?: string; meetingId?: string };
  const profile = await requireBodyProfile(deps, body);
  sendJson(res, 200, await meetingLeave(deps.supervisor.controlsFor(profile)?.meeting, body));
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/api/model-services', handle: listModelServicesRoute },
  { method: 'POST', path: '/api/model-services', handle: configureModelServiceRoute },
  { method: 'POST', path: '/api/model-services/check', handle: checkModelServiceRoute },
  { method: 'POST', path: '/api/model-services/remove', handle: removeModelServiceRoute },
  { method: 'POST', path: '/api/shutdown', enabled: deps => !!deps.requestShutdown, handle: shutdown },
  { method: 'GET', path: '/api/status', handle: status },
  { method: 'GET', path: '/api/bots', handle: bots },
  { method: 'GET', path: '/api/profiles', handle: profiles },
  { method: 'POST', path: '/api/profiles', handle: createProfile },
  { method: 'POST', path: '/api/profiles/start', handle: startProfile },
  { method: 'POST', path: '/api/profiles/stop', handle: stopProfile },
  { method: 'POST', path: '/api/profiles/activate', handle: activate },
  { method: 'POST', path: '/api/profiles/autostart', handle: autostart },
  { method: 'POST', path: '/api/profiles/validate', handle: validateProfile },
  { method: 'POST', path: '/api/profiles/qr/start', handle: qrStart },
  { method: 'GET', path: '/api/profiles/qr/status', handle: qrPoll },
  { method: 'POST', path: '/api/profiles/qr/finish', handle: qrFinish },
  { method: 'GET', path: '/api/onboard/state', handle: onboard },
  { method: 'GET', path: '/api/config', handle: getConfig },
  { method: 'POST', path: '/api/config', handle: postConfig },
  { method: 'POST', path: '/api/access', handle: access },
  { method: 'GET', path: '/api/chats', handle: chats },
  { method: 'GET', path: '/api/auth/status', handle: authStatus },
  { method: 'POST', path: '/api/auth/login/start', handle: loginStart },
  { method: 'POST', path: '/api/auth/login/complete', handle: loginComplete },
  { method: 'GET', path: '/api/user-chats', handle: userChats },
  { method: 'POST', path: '/api/chats/add-bot', handle: addBot },
  { method: 'GET', path: '/api/meetings', handle: meetings },
  { method: 'GET', path: '/api/meetings/preflight', handle: preflight },
  { method: 'POST', path: '/api/meetings/join', handle: join },
  { method: 'POST', path: '/api/meetings/leave', handle: leave },
];

/**
 * Dispatch an authenticated `/api/*` request: built-in routes first, then
 * plugin routes, else 404. Unknown methods on a known path also 404.
 */
export async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UiServerDeps,
  url: URL,
): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  const builtin = ROUTES.find(route =>
    route.method === method && route.path === path && (route.enabled?.(deps) ?? true));
  if (builtin) {
    await builtin.handle({ req, res, deps, url });
    return;
  }

  const pluginRoute = deps.supervisor.pluginRoutes?.().find(route =>
    pluginRouteMatches(route, method, path));
  if (pluginRoute) {
    const response = await pluginRoute.handle({
      method,
      path,
      url,
      readJson: () => readJsonBody(req),
    });
    sendJson(res, response.status ?? 200, response.body);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
