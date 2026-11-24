// QuotePilot AI PostgreSQL shared-state adapter — PREPARED, NOT CONNECTED.
// Intended for src/shared/postgres.mjs in the existing tested QuotePilot source.
// `query` must be a server-side parametrized SQL function (text, values) -> row[].
// Do not expose this module to browser code. No database connection is opened here.
import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from '../lib/validators.mjs';
const DIGEST=/^[a-f0-9]{64}$/;
const OWNER=/^[a-f0-9]{48}$/;
const RECORD=/^[A-Za-z0-9_-]{1,128}$/;
function digest(x){return createHash('sha256').update(x).digest('hex')}
function hexKey(key){if(typeof key!=='string'||!DIGEST.test(key))throw new HttpError(400,'Invalid security identifier')}
function safeRows(value){if(!Array.isArray(value))throw new HttpError(503,'Shared security service unavailable');return value}
export class PostgresSharedState {
 constructor({query}){if(typeof query!=='function')throw new Error('A server-only parameterized SQL query function is required');this.query=query}
 async sql(text,values){try{return safeRows(await this.query(text,values))}catch(err){if(err instanceof HttpError&&err.status===400)throw err;throw new HttpError(503,'Shared security service unavailable')}}
 async isRevoked(key){hexKey(key);
  const rows=await this.sql('SELECT (expires_at_ms > $2::bigint) AS revoked FROM qp_security.revocations WHERE jti_hash = $1',[key,Date.now()]);
  return rows.length>0?rows[0].revoked===true:false;
 }
 async revoke(key,expires){hexKey(key);if(!Number.isSafeInteger(expires)||expires<=Date.now())throw new HttpError(400,'Invalid session expiration');
  const rows=await this.sql(`INSERT INTO qp_security.revocations (jti_hash, expires_at_ms) VALUES ($1, $2::bigint)
    ON CONFLICT (jti_hash) DO UPDATE SET expires_at_ms = GREATEST(qp_security.revocations.expires_at_ms, EXCLUDED.expires_at_ms)
    RETURNING jti_hash`,[key,expires]);if(rows.length!==1)throw new HttpError(503,'Shared security service unavailable');
 }
 async checkRateLimit(key,max,periodMs){
  hexKey(key);
  if(!Number.isSafeInteger(max)||max<1||max>10000||!Number.isSafeInteger(periodMs)||periodMs<1000||periodMs>86400000)
   throw new HttpError(400,'Invalid rate limit');
  const now=Date.now();
  // One atomic UPSERT prevents concurrent replicas from exceeding the global cap.
  // Window restarts only after its original TTL, not on every failed attempt.
  const rows=await this.sql(`INSERT INTO qp_security.rate_limits AS l (bucket_key, window_start_ms, attempt_count)
    VALUES ($1,$2::bigint,1)
    ON CONFLICT (bucket_key) DO UPDATE SET
      window_start_ms=CASE WHEN l.window_start_ms <= ($2::bigint-$3::bigint) THEN $2::bigint ELSE l.window_start_ms END,
      attempt_count=CASE WHEN l.window_start_ms <= ($2::bigint-$3::bigint) THEN 1 ELSE LEAST(l.attempt_count+1,1000000) END
    RETURNING attempt_count`,[key,now,periodMs]);
  if(rows.length!==1||!Number.isSafeInteger(rows[0].attempt_count))throw new HttpError(503,'Shared rate limit service unavailable');
  return {allowed:rows[0].attempt_count<=max};
 }
 async claim(key){hexKey(key);const ownerToken=randomBytes(24).toString('hex');const ownerTokenHash=digest(ownerToken);
  // A *single* upsert statement provides row locking/atomic conflict handling under concurrency.
  // The conflict branch leaves ownership unchanged, returns existing pending/done state.
  const rows=await this.sql(`INSERT INTO qp_security.intents AS i (intent_key,status,owner_token_sha256,created_at)
    VALUES ($1, 'pending', $2, NOW())
    ON CONFLICT (intent_key) DO UPDATE SET intent_key = EXCLUDED.intent_key
    RETURNING i.status, i.record_id, (i.owner_token_sha256 = $2) AS is_owner`,[key,ownerTokenHash]);
  if(rows.length!==1)throw new HttpError(503,'Shared security service unavailable');
  const row=rows[0];if(row.status==='pending'&&row.is_owner===true)return {state:'claimed',ownerToken};
  if(row.status==='pending'&&row.is_owner===false)return {state:'pending'};
  if(row.status==='done'&&row.is_owner===false&&typeof row.record_id==='string'&&RECORD.test(row.record_id))return {state:'done',recordId:row.record_id};
  throw new HttpError(503,'Invalid shared security response');
 }
 async complete(key,ownerToken,recordId){hexKey(key);if(typeof ownerToken!=='string'||!OWNER.test(ownerToken)||typeof recordId!=='string'||!RECORD.test(recordId))throw new HttpError(400,'Invalid security completion');
  const rows=await this.sql(`UPDATE qp_security.intents SET status = 'done', record_id = $3, completed_at = NOW()
    WHERE intent_key = $1 AND owner_token_sha256 = $2 AND status = 'pending'
    RETURNING intent_key`,[key,digest(ownerToken),recordId]);
  if(rows.length!==1)throw new HttpError(409,'Security claim is not pending or owned by caller');
 }
}
