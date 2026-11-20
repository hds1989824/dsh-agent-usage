/**
 * Host half of the Agent usage bundle.
 *
 * Exposes one authenticated JSON route over the Host web server:
 *   GET /plugins/agent-usage/today[?date=YYYY-MM-DD][&force=1]
 *
 * The route scans the local agent-client session logs and returns the day's
 * session count and token consumption per platform. Results are cached for a
 * short interval so the sidebar panel can poll without re-reading every log.
 *
 * The route is registered lazily: a headless profile without a web server or
 * connection simply never gains the route, and the plugin stays inert.
 */

import { collectAgentUsage } from './scanner.js';

const CACHE_TTL_MS = 30_000;
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
const CONNECTION_KEYS = ['connection'];

let cached = null;

async function getUsage({ date, range }, force) {
  const key = `${date || ''}|${range || 'today'}`;
  const now = Date.now();
  if (!force && cached && cached.key === key && now - cached.time < CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = collectAgentUsage({ date, range }).catch((error) => {
    cached = null;
    throw error;
  });
  cached = { promise, time: now, key };
  return promise;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx) {
  let registered = false;

  const registerRoutes = () => {
    if (registered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    const connection = ctx.get(CONNECTION_KEYS[0]);
    if (!webServer || !connection) return;
    registered = true;

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/agent-usage/today',
      handler: async (req, res) => {
        // Raw webServer routes do not inherit the Connection authentication
        // fence, so apply it here before any local log leaves the host.
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) {
          sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const date = url.searchParams.get('date') || undefined;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          sendJson(res, 400, { error: 'invalid date, expected YYYY-MM-DD' });
          return;
        }
        const range = url.searchParams.get('range') || 'today';
        if (range !== 'today' && range !== 'week' && range !== 'month') {
          sendJson(res, 400, { error: 'invalid range, expected today|week|month' });
          return;
        }
        const force = url.searchParams.get('force') === '1';
        try {
          const data = await getUsage({ date, range }, force);
          sendJson(res, 200, data);
        } catch (error) {
          ctx.logger.warn(`agent-usage: scan failed: ${String(error)}`);
          sendJson(res, 500, { error: 'scan failed' });
        }
      },
    }), 'agent-usage: today route');
  };

  registerRoutes();
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name) || CONNECTION_KEYS.includes(name)) registerRoutes();
  });
}
