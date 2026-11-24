// Local reference implementation only. Never use a Vercel ephemeral filesystem for this database.
// One durable SQLite file / one coordinator process can serve many app instances.
// Do not automatically reclaim pending intents: an upstream Airtable write may have succeeded
// before its acknowledgement was received. Manual reconciliation is required.
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';

const KEY=/^[a-f0-9]{64}$/;
const RECORD=/^[A-Za-z0-9_-]{1,128}$/;
function checkKey(value){if(typeof value!=='string'||!KEY.test(value))throw new Error('Invalid shared-state key')}

export class SqliteSharedState {
 constructor(filename){
  if(!filename||filename===':memory:')throw new Error('Durable path required; in-memory coordinator is not sufficient');
  this.db=new DatabaseSync(filename);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS revocations (jti_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS rate_limits (bucket_key TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, attempt_count INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS intents (
    intent_key TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('pending','done')),
    owner_token TEXT NOT NULL,
    record_id TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
   );`);
  this.upsertRate=this.db.prepare(`INSERT INTO rate_limits(bucket_key,window_start_ms,attempt_count) VALUES (?, ?, 1)
    ON CONFLICT(bucket_key) DO UPDATE SET
    window_start_ms=CASE WHEN window_start_ms <= (? - ?) THEN ? ELSE window_start_ms END,
    attempt_count=CASE WHEN window_start_ms <= (? - ?) THEN 1 ELSE MIN(attempt_count+1,1000000) END
    RETURNING attempt_count`);
  this.checkRevoked=this.db.prepare('SELECT expires_at FROM revocations WHERE jti_hash=?');
  this.insertRevocation=this.db.prepare('INSERT INTO revocations(jti_hash,expires_at) VALUES (?,?) ON CONFLICT(jti_hash) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)');
  this.insertIntent=this.db.prepare("INSERT OR IGNORE INTO intents (intent_key,status,owner_token,created_at) VALUES (?,'pending',?,?)");
  this.readIntent=this.db.prepare('SELECT status,record_id FROM intents WHERE intent_key=?');
  this.finishIntent=this.db.prepare("UPDATE intents SET status='done',record_id=?,completed_at=? WHERE intent_key=? AND status='pending' AND owner_token=?");
 }
 checkRateLimit(key,max,periodMs){
  checkKey(key);
  if(!Number.isSafeInteger(max)||max<1||max>10000||!Number.isSafeInteger(periodMs)||periodMs<1000||periodMs>86400000)throw new Error('Invalid rate limit');
  const now=Date.now();
  const row=this.upsertRate.get(key,now,now,periodMs,now,now,periodMs);
  if(!row||!Number.isSafeInteger(row.attempt_count))throw new Error('Shared rate limit unavailable');
  return {allowed:row.attempt_count<=max};
 }
 isRevoked(hash){checkKey(hash);const row=this.checkRevoked.get(hash);return Boolean(row&&row.expires_at>Date.now())}
 revoke(hash,expiration){checkKey(hash);if(!Number.isSafeInteger(expiration)||expiration<=0)throw new Error('Invalid expiry');this.insertRevocation.run(hash,expiration);return {ok:true}}
 claim(hash){checkKey(hash);const ownerToken=randomBytes(24).toString('hex');const inserted=this.insertIntent.run(hash,ownerToken,Date.now());if(inserted.changes===1)return {state:'claimed',ownerToken};const row=this.readIntent.get(hash);if(!row)throw new Error('Intent disappeared');return row.status==='done'?{state:'done',recordId:row.record_id}:{state:'pending'};}
 complete(hash,ownerToken,recordId){checkKey(hash);if(!/^[a-f0-9]{48}$/.test(ownerToken)||!RECORD.test(recordId))throw new Error('Invalid completion');const updated=this.finishIntent.run(recordId,Date.now(),hash,ownerToken);if(updated.changes!==1)throw new Error('Intent completion owner mismatch');return {ok:true};}
 close(){this.db.close();}
}
