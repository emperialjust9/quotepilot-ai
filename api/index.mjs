// QuotePilot AI — protected Vercel private-pilot adapter.
// Uses the original, unmodified authenticated app handler. Never falls back to demo.
import {createApp, configFromEnv} from '../src/server.mjs';
import {createNeonSharedState} from '../src/shared/neon.mjs';
let handler;
export default async function quotepilot(req, res) {
  if (!handler) {
    try { const config=configFromEnv();
      const sharedState=config.sharedStateProvider==='neon'
        ?await createNeonSharedState({connectionString:process.env.QP_SECURITY_DATABASE_URL})
        :null;
      handler=createApp({config,sharedState}).handler; }
    catch (err) {
      // Missing tenant auth, host origin, or Airtable token: do not expose details.
      console.error('QuotePilot private-pilot initialization blocked; check protected service configuration');
      res.statusCode=503;
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({error:'Private pilot not yet configured'}));
      return;
    }
  }
  return handler(req, res);
}
