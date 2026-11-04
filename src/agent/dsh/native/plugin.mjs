// Public Cordis plugin seam. The legacy profile name preserves existing native handles.
export const name = 'warp-assistant';
export const inject = ['agents', 'agentLoop', 'sessions', 'sessionQuery', 'sessionPersistence', 'tools', 'systemPrompt'];
const waiting = new Map();
export function profileReady(token) {
  if (!waiting.has(token)) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    waiting.set(token, { promise, resolve });
  }
  return waiting.get(token).promise;
}
export function apply(ctx, config) {
  ctx.effect(function* () {
    profileReady(config.token);
    const owner = waiting.get(config.token);
    owner.resolve(ctx);
    yield () => waiting.delete(config.token);
  });
}
