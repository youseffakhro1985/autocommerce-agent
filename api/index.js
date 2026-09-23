// Vercel Function: all HTTP traffic (dashboard, approvals, webhooks, /api/cron) → Fastify app compiled to dist/.
import { buildServer } from '../dist/src/server.js';

let appPromise;
export default async function handler(req, res) {
  appPromise ??= buildServer().then(async (app) => { await app.ready(); return app; });
  const app = await appPromise;
  app.server.emit('request', req, res);
}
export const config = { maxDuration: 300 };
