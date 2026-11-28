import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID, createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {SharedStateHttpClient} from './shared/http.mjs';
import {SqliteSharedState} from './shared/sqlite.mjs';
import {AirtableRepo,stagingTableMapFromEnv,extraTableMapFromEnv,PRODUCTION_TABLES,STAGING_BASE_ID} from './storage/airtable.mjs';
import {DemoRepo} from './storage/demo.mjs';
import {HttpError, leadInput, requiredString, optionalString, optionalEmail, isoDate, pricingInput, parseServiceCatalog, serviceCatalogInput, DEFAULT_SERVICES} from './lib/validators.mjs';
import {computeEstimate} from './lib/pricing.mjs';
import {demoUsers, findLoginUser, issueCookie, parseSession, clearCookie, requireCsrf, credentialVersion, hashPassword, verifyPassword} from './lib/auth.mjs';
import {buildMessaging, parseSmtpUrl, estimateEmail, estimateSms, followupEmail, bookingConfirmation, verifyEmailMessage, resetEmailMessage} from './lib/messaging.mjs';
import {validateUpload, MemoryUploadStore, LocalUploadStore, newUploadRef, DEFAULT_UPLOAD_MAX_BYTES} from './lib/uploads.mjs';
import {PRIVACY_HTML, TERMS_HTML} from './content/legal.mjs';
import {requestIP} from './lib/request-ip.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(here,'..','public');
export function configFromEnv(env=process.env){
 const mode=env.QP_DATA_MODE||'airtable';
 const demo=mode==='demo';
 const host=env.HOST||'127.0.0.1';
 if (!['demo','airtable'].includes(mode)) throw new Error('QP_DATA_MODE must be demo or airtable');
 if(demo && (env.QP_ALLOW_DEMO!=='1'||!['127.0.0.1','localhost','::1'].includes(host))) throw new Error('Demo only allowed when explicitly enabled on localhost');
 if(demo && env.NODE_ENV==='production')throw new Error('Demo cannot run in production');
 const stage=env.QP_AIRTABLE_STAGING==='1';
 if(stage){
  if(mode!=='airtable'||env.QP_AIRTABLE_STAGING_BASE_ID!==STAGING_BASE_ID)throw new Error('Staging requires dedicated Airtable base');
  if(env.QP_PUBLIC_INTAKE_ENABLED==='1'||env.QP_ALLOW_CUSTOMER_SENDS==='1'||env.QP_ALLOW_LIVE_BILLING==='1'||env.QP_ALLOW_AUTOMATED_BOOKINGS==='1')throw new Error('Staging forbids customer-facing actions');
 }
 const stagingTables=stagingTableMapFromEnv(env);
 const extraTables=extraTableMapFromEnv(env);
 const secret=env.QP_SESSION_SECRET||'';
 if(secret.length<32) throw new Error('QP_SESSION_SECRET must be >=32 chars');
 // External-action capabilities (2026-11-27 founder build order): each flag is
 // validated PER CAPABILITY. A flag may only be enabled when everything that
 // capability needs is configured; an enabled flag with missing configuration
 // refuses startup, and all flags off boots exactly as the private pilot did.
 const emailProvider=env.QP_EMAIL_PROVIDER||'';
 if(!['','smtp','outbox'].includes(emailProvider))throw new Error('QP_EMAIL_PROVIDER must be smtp or outbox');
 if(emailProvider&&!env.QP_EMAIL_FROM)throw new Error('QP_EMAIL_FROM required when an email provider is configured');
 if(emailProvider==='smtp'){if(!env.QP_SMTP_URL)throw new Error('QP_SMTP_URL required for the SMTP email provider');parseSmtpUrl(env.QP_SMTP_URL);}
 const smsProvider=env.QP_SMS_PROVIDER||'';
 if(!['','http','outbox'].includes(smsProvider))throw new Error('QP_SMS_PROVIDER must be http or outbox');
 if(smsProvider&&!env.QP_SMS_FROM)throw new Error('QP_SMS_FROM required when an SMS provider is configured');
 if(smsProvider==='http'&&(!env.QP_SMS_API_URL||!env.QP_SMS_API_TOKEN))throw new Error('QP_SMS_API_URL and QP_SMS_API_TOKEN required for the HTTP SMS provider');
 const sendsEnabled=env.QP_ALLOW_CUSTOMER_SENDS==='1';
 if(sendsEnabled&&!emailProvider&&!smsProvider)throw new Error('Customer sends require a configured channel: set QP_EMAIL_PROVIDER or QP_SMS_PROVIDER');
 const checkoutUrl=env.QP_GUMROAD_CHECKOUT_URL||'';
 if(checkoutUrl){let u;try{u=new URL(checkoutUrl)}catch{throw new Error('QP_GUMROAD_CHECKOUT_URL must be a valid HTTPS URL')};if(u.protocol!=='https:'||u.username||u.password)throw new Error('QP_GUMROAD_CHECKOUT_URL must be a valid HTTPS URL');}
 const billingEnabled=env.QP_ALLOW_LIVE_BILLING==='1';
 if(billingEnabled&&!checkoutUrl)throw new Error('Live billing requires QP_GUMROAD_CHECKOUT_URL');
 const webhookSecret=env.QP_GUMROAD_WEBHOOK_SECRET||'';
 if(billingEnabled&&webhookSecret.length<16)throw new Error('Live billing requires QP_GUMROAD_WEBHOOK_SECRET (>=16 chars)');
 const planPriceRaw=env.QP_PLAN_PRICE_USD||'19';
 if(!/^\d+(?:\.\d{1,2})?$/.test(planPriceRaw))throw new Error('QP_PLAN_PRICE_USD must be a nonnegative amount');
 const planPriceMonthly=Number(planPriceRaw);
 const bookingsEnabled=env.QP_ALLOW_AUTOMATED_BOOKINGS==='1';
 const signupEnabled=env.QP_ALLOW_SIGNUP==='1';
 if(signupEnabled&&!emailProvider)throw new Error('Self-serve signup requires an email provider for verification (QP_EMAIL_PROVIDER)');
 if(signupEnabled&&!demo&&!extraTables?.Accounts)throw new Error('Self-serve signup requires the Accounts table (QP_AIRTABLE_EXTRA_TABLES_JSON)');
 const uploadsEnabled=env.QP_UPLOADS_ENABLED==='1';
 const uploadDir=env.QP_UPLOAD_DIR||'';
 let uploadMaxBytes=DEFAULT_UPLOAD_MAX_BYTES;
 if(env.QP_UPLOAD_MAX_BYTES){uploadMaxBytes=Number(env.QP_UPLOAD_MAX_BYTES);if(!Number.isSafeInteger(uploadMaxBytes)||uploadMaxBytes<1024||uploadMaxBytes>25*1024*1024)throw new Error('QP_UPLOAD_MAX_BYTES must be an integer between 1024 and 26214400');}
 const appBaseUrl=env.QP_APP_BASE_URL||'';
 if(appBaseUrl){let u;try{u=new URL(appBaseUrl)}catch{throw new Error('QP_APP_BASE_URL must be a valid origin URL')};if(u.origin!==appBaseUrl.replace(/\/$/,'')||!['http:','https:'].includes(u.protocol))throw new Error('QP_APP_BASE_URL must be an exact origin URL');}
 let users=[];if(!demo){if(!env.AIRTABLE_TOKEN)throw new Error('AIRTABLE_TOKEN required in production data mode');try{users=JSON.parse(env.QP_USERS_JSON||'[]');}catch{throw new Error('QP_USERS_JSON must be valid JSON');}if(!Array.isArray(users)||!users.length||users.some(x=>!x.email||!x.businessKey||!['owner','operator'].includes(x.role)||!/^([a-f0-9]{32}):([a-f0-9]{128})$/i.test(x.passwordHash||'')))throw new Error('Valid configured user credentials required');if(new Set(users.map(x=>x.email.toLowerCase())).size!==users.length)throw new Error('Duplicate user email configuration blocked');}
 let intakeKeys={};try{intakeKeys=JSON.parse(env.QP_TENANT_INTAKE_KEYS_JSON||'{}');}catch{throw new Error('Invalid intake mapping JSON');}
 const secure=env.NODE_ENV==='production';const allowedOrigins=(env.QP_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
 if(secure&&allowedOrigins.length===0)throw new Error('Production requires explicit QP_ALLOWED_ORIGINS');
 for(const origin of allowedOrigins){let url;try{url=new URL(origin)}catch{throw new Error('Invalid allowed origin')};if(origin!==url.origin||(secure&&url.protocol!=='https:'))throw new Error('QP_ALLOWED_ORIGINS must contain exact HTTPS origins');}
 if(secure&&env.QP_PUBLIC_INTAKE_ENABLED==='1')throw new Error('Public intake blocked until abuse and privacy release review');
 if(uploadsEnabled&&secure&&!uploadDir)throw new Error('Uploads in production require a durable QP_UPLOAD_DIR');
 if(uploadsEnabled&&!demo&&!extraTables?.Uploads)throw new Error('Uploads require the Uploads table (QP_AIRTABLE_EXTRA_TABLES_JSON)');
 const coordinatorUrl=env.QP_SHARED_STATE_URL||'';
 const coordinatorToken=env.QP_SHARED_STATE_TOKEN||'';
 // Multi-instance shared state is the standard production path (2026-11-27
 // build): a production connected deployment MUST name a shared-state
 // backend — per-instance revocation/rate limiting is a private-pilot
 // fallback only and is refused here, fail-closed.
 const sharedStateRequired=env.QP_SHARED_STATE_REQUIRED==='1'||(secure&&mode==='airtable');
 const sharedStateProvider=env.QP_SHARED_STATE_PROVIDER||'';
 if(!['','neon','sqlite'].includes(sharedStateProvider))throw new Error('Unsupported shared-state provider');
 if(sharedStateProvider==='neon' && !sharedStateRequired)throw new Error('Neon shared-state requires fail-closed enforcement');
 if(sharedStateProvider==='neon' && coordinatorUrl)throw new Error('Only one shared-state provider is permitted');
 if(sharedStateProvider==='neon' && !env.QP_SECURITY_DATABASE_URL)throw new Error('QuotePilot security database secret required');
 const sqlitePath=env.QP_SHARED_STATE_SQLITE_PATH||'';
 if(sharedStateProvider==='sqlite' && coordinatorUrl)throw new Error('Only one shared-state provider is permitted');
 if(sharedStateProvider==='sqlite' && (!sqlitePath||sqlitePath===':memory:'))throw new Error('SQLite shared-state requires a durable QP_SHARED_STATE_SQLITE_PATH');
 if(coordinatorUrl){let u;try{u=new URL(coordinatorUrl);}catch{throw new Error('QP_SHARED_STATE_URL invalid');}
   if(u.username||u.password||u.search||u.hash||u.origin!==coordinatorUrl.replace(/\/$/,'')||(secure&&u.protocol!=='https:'))throw new Error('Shared-state URL requires an exact HTTPS origin without credentials');
   if(coordinatorToken.length<32)throw new Error('Shared-state strong token required');
 }
 if(sharedStateRequired&&!coordinatorUrl&&!['neon','sqlite'].includes(sharedStateProvider))throw new Error('Shared-state backend required before commercial rollout');
 return {mode,stagingTables,extraTables,stagingBaseId:stage?STAGING_BASE_ID:null,host,port:Number(env.PORT||3333),secret,users,secure,allowedOrigins,publicIntake:env.QP_PUBLIC_INTAKE_ENABLED==='1',intakeKeys,allowDemo:env.QP_ALLOW_DEMO==='1',sessionEpoch:env.QP_SESSION_EPOCH||(secure?'quotepilot-private-pilot-auth-r2':''),coordinatorUrl,coordinatorToken,sharedStateRequired,sharedStateProvider,sqlitePath,vercelRuntime:env.VERCEL==='1',
  sendsEnabled,emailProvider,emailFrom:env.QP_EMAIL_FROM||'',smtpUrl:env.QP_SMTP_URL||'',smsProvider,smsFrom:env.QP_SMS_FROM||'',smsApiUrl:env.QP_SMS_API_URL||'',smsApiToken:env.QP_SMS_API_TOKEN||'',
  billingEnabled,checkoutUrl,webhookSecret,planPriceMonthly,bookingsEnabled,signupEnabled,uploadsEnabled,uploadDir,uploadMaxBytes,appBaseUrl};
}
function today(){return new Date().toISOString().slice(0,10);}
function secureHeaders(res,req,cfg){
 const h={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Permissions-Policy':'camera=(),microphone=(),geolocation=()'
 };if(cfg.secure)h['Strict-Transport-Security']='max-age=31536000; includeSubDomains';for(const [k,v] of Object.entries(h))res.setHeader(k,v);
}
function json(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
async function bodyJson(req){const chunks=[];let n=0;for await (const chunk of req){n+=chunk.length;if(n>16000)throw new HttpError(413,'Input too large');chunks.push(chunk);}if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'JSON Content-Type required');try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON body');}}
async function bodyRaw(req,maxBytes){const chunks=[];let n=0;for await (const chunk of req){n+=chunk.length;if(n>maxBytes)throw new HttpError(413,'Input too large');chunks.push(chunk);}return Buffer.concat(chunks);}
function checkedOrigin(req,cfg){const origin=req.headers.origin;const host=req.headers.host;if(!origin)throw new HttpError(403,'Origin required');let u;try{u=new URL(origin);}catch{throw new HttpError(403,'Invalid origin');}if(u.host!==host||!['http:','https:'].includes(u.protocol))throw new HttpError(403,'Cross-site request refused');if(cfg.secure&&u.protocol!=='https:')throw new HttpError(403,'HTTPS required');if(cfg.allowedOrigins?.length&&!cfg.allowedOrigins.includes(u.origin))throw new HttpError(403,'Origin not approved');}
function rateCheck(buckets,key,max,periodMs){const now=Date.now();let cur=buckets.get(key)||[];cur=cur.filter(t=>t>now-periodMs);if(cur.length>=max)throw new HttpError(429,'Too many attempts; retry later');cur.push(now);buckets.set(key,cur);if(buckets.size>6000)for(const [k,v] of buckets){if(v.every(t=>t<now-periodMs))buckets.delete(k);}}
function dedupKey(fields,business){const normalized=[business,fields['Customer Email'].toLowerCase(),fields['Customer Phone'],fields['Service'],fields['Postal Code'],fields['Requested Date']||''].join('|');return createHash('sha256').update(normalized).digest('hex');}
function safeList(records){return records.map(r=>({id:r.id,fields:r.fields}));}
async function dashboard(repo,key,gates={outboundSends:false,paymentCharges:false,automaticBookings:false}){
 const [leads,estimates,bookings,followups,businesses,subs]=await Promise.all(['Leads','Estimates','Bookings','Follow Ups','Businesses','Subscriptions'].map(table=>repo.list(table,key)));
 return {business:businesses[0]?.fields||null,counts:{leads:leads.length,estimates:estimates.length,bookings:bookings.length,followupDrafts:followups.length,needsReview:leads.filter(x=>x.fields.Stage==='Needs Review').length},latestLeads:safeList(leads.slice(-7).reverse()),latestEstimates:safeList(estimates.slice(-7).reverse()),subscriptions:safeList(subs),gate:gates};
}
async function businessRecord(repo,key){
 const businesses=await repo.list('Businesses',key);
 if(!businesses.length)throw new HttpError(404,'Business not found');
 return businesses[0];
}
async function tenantServices(repo,key){
 const business=await businessRecord(repo,key);
 return parseServiceCatalog(business.fields['Services Offered']);
}
async function leadServiceAreaAllows(repo,key,postalCode){
 const business=await businessRecord(repo,key);
 const zipTokens=String(business.fields['Service ZIPs']||'').split(/[\s,;]+/).filter(Boolean);
 return !zipTokens.length||zipTokens.includes(postalCode.slice(0,5));
}
async function findMatchingLead(repo,key,identity){
 return (await repo.list('Leads',key)).find(lead=>lead.fields['Dedup Key']===identity);
}
async function createLead(repo,key,fields,identity,source){
 const previous=await findMatchingLead(repo,key,identity);
 if(previous)return {lead:previous,duplicate:true};
 const lead=await repo.create('Leads',key,{...fields,'Lead Source':source,
  'Lead Key':'QP-LEAD-'+randomUUID().slice(0,12).toUpperCase(),'Created On':today(),'Dedup Key':identity});
 return {lead,duplicate:false};
}
async function pricePreview(repo,key,leadId,ruleId){
 const [lead,rule]=await Promise.all([repo.get('Leads',key,leadId),repo.get('Pricing Rules',key,ruleId)]);
 if(lead.fields.Service!==rule.fields.Service)throw new HttpError(422,'Rule service does not match the lead');
 const estimate=computeEstimate(rule.fields,lead.fields);
 return {estimate,lead:lead.fields,rule:{id:rule.id,key:rule.fields['Rule Key'],version:rule.fields.Version,approved:rule.fields.Approved===true}};
}
export function createApp({config=configFromEnv(),repository=null,sharedState=null,messaging=null,uploadStore=null}={}){
 const repo=repository|| (config.mode==='demo'?new DemoRepo():new AirtableRepo({token:process.env.AIRTABLE_TOKEN,baseId:config.stagingBaseId||process.env.AIRTABLE_BASE_ID||'appWNg4MRrQ2TViqi',tables:{...(config.stagingTables||PRODUCTION_TABLES),...(config.extraTables||{})}}));
 const state=sharedState||(config.coordinatorUrl?new SharedStateHttpClient({url:config.coordinatorUrl,token:config.coordinatorToken}):config.sharedStateProvider==='sqlite'?new SqliteSharedState(config.sqlitePath):null);
 if((config.sharedStateRequired||['neon','sqlite'].includes(config.sharedStateProvider))&&!state)throw new Error('Shared-state backend required before commercial rollout');
 const mailer=messaging||buildMessaging(config);
 const uploads=uploadStore||(config.uploadDir?new LocalUploadStore({dir:config.uploadDir}):new MemoryUploadStore());
 const gates={outboundSends:config.sendsEnabled,paymentCharges:config.billingEnabled,automaticBookings:config.bookingsEnabled};
 // HMAC identities avoid persisting customer PII, raw JTI values, or business keys in the coordinator.
 const sharedKey=(kind,tenant,identity)=>createHmac('sha256',config.secret).update(JSON.stringify([kind,tenant,identity])).digest('hex');
 const buckets=new Map();
 // Every security-sensitive request must use the shared atomic limiter when a
 // durable backend is configured. Never silently fall back to a per-instance map.
 async function checkedRate(scope,identity,max,periodMs){
   if(!state){rateCheck(buckets,scope+':'+identity,max,periodMs);return;}
   if(typeof state.checkRateLimit!=='function')throw new HttpError(503,'Shared rate limit service unavailable');
   const answer=await state.checkRateLimit(sharedKey('rate',scope,identity),max,periodMs);
   if(answer?.allowed===false)throw new HttpError(429,'Too many attempts; retry later');
   if(answer?.allowed!==true)throw new HttpError(503,'Shared rate limit service unavailable');
 }

 // Single-process write serialization prevents simultaneous operator requests from creating
 // duplicate leads, estimates, bookings, or drafts. This is NOT a distributed lock.
 const tenantWrites=new Map();
 async function tenantWrite(key, task){
   const prev=tenantWrites.get(key)||Promise.resolve();
   let release;const current=new Promise(resolve=>{release=resolve});
   tenantWrites.set(key,current);
   await prev;
   try{return await task();}
   finally{release();if(tenantWrites.get(key)===current)tenantWrites.delete(key);}
 }
 // Durable intent is atomically claimed by an external coordinator before any Airtable write.
 // A crashed/ambiguous claim stays pending until deliberate reconciliation; never auto-retry.
 async function durableWrite(tenant,table,kind,identity,run){
   if(!state)return tenantWrite(tenant,run); // private-pilot fallback, NOT commercial release-safe.
   const key=sharedKey(kind,tenant,identity);
   const claim=await state.claim(key);
   if(claim.state==='pending')throw new HttpError(409,'Request is processing or requires operator reconciliation; no duplicate will be created');
   if(claim.state==='done'){
     let record;try{record=await repo.get(table,tenant,claim.recordId)}catch{throw new HttpError(503,'Prior operation requires operator reconciliation');}
     return {status:200,data:table==='Leads'?{lead:record,duplicate:true}:{record,duplicate:true,sendEnabled:config.sendsEnabled,...(table==='Bookings'?{confirmed:false}:{})}};
   }
   const outcome=await tenantWrite(tenant,run);
   const record=outcome.data?.record||outcome.data?.lead;
   if(!record?.id)throw new HttpError(503,'Operation requires operator reconciliation');
   await state.complete(key,claim.ownerToken,record.id);
   return outcome;
 }
 async function submitLead(key,input,source){
   const fields=leadInput(input,await tenantServices(repo,key));
   const identity=dedupKey(fields,key);
   // Reject uncovered ZIPs before claiming a write that could otherwise stay pending.
   if(!await leadServiceAreaAllows(repo,key,fields['Postal Code'])){
     // A lead created before coverage narrowed can still be safely replayed.
     const previous=state?await findMatchingLead(repo,key,identity):null;
     if(previous)return {status:200,data:{lead:previous,duplicate:true}};
     throw new HttpError(422,'ZIP not currently included in service area');
   }
   return durableWrite(key,'Leads','lead',identity,async()=>{
     const result=await createLead(repo,key,fields,identity,source);
     return {status:result.duplicate?200:201,data:result};
   });
 }

 // In-process revoke list: sufficient for a single-instance private pilot, NOT a multi-region production session store.
 const revoked=new Map();
 // Versioned production epoch: consistent across Vercel functions even when VERCEL_URL
 // or VERCEL_DEPLOYMENT_ID are absent; rotate QP_SESSION_EPOCH to revoke all sessions.
 // Local nonproduction runs retain process-restart invalidation. Logout revocation remains
 // per-instance until a distributed session store is introduced.
 const processEpoch=config.sessionEpoch
   ? createHash('sha256').update('quotepilot-session-v1|' + config.sessionEpoch).digest('hex')
   : randomBytes(18).toString('hex');
 // Bounded same-process cache prevents Airtable read bursts during multi-view refresh.
 // A production distributed cache/central session store remains an explicit release gate.
 const tenantStates=new Map();
 async function tenantAllowed(businessKey){
   if(config.mode==='demo')return true;
   const current=tenantStates.get(businessKey);
   if(current&&current.expires>Date.now())return current.allowed;
   if(current?.inflight)return current.inflight;
   const inflight=(async()=>{
     const businesses=await repo.list('Businesses',businessKey);
     return businesses.length===1&&['Active','Onboarding'].includes(businesses[0].fields.Status);
   })();
   tenantStates.set(businessKey,{inflight});
   try{const allowed=await inflight;tenantStates.set(businessKey,{allowed,expires:Date.now()+15000});return allowed}
   catch(error){tenantStates.delete(businessKey);throw error}
 }
 const tokenHash=(token)=>createHash('sha256').update(String(token)).digest('hex');
 const accountLink=(p)=>(config.appBaseUrl||'')+p;
 const app=async(req,res)=>{
  secureHeaders(res,req,config);
  try{
   const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
   const pathname=u.pathname;
   const method=req.method||'GET';
   if(method==='GET'&&pathname==='/health'){json(res,200,{ok:true,service:'quotepilot'});return;}
   if(method==='GET'&&pathname.startsWith('/intake/')){
     const intakeKey=pathname.slice('/intake/'.length);
     if(!config.publicIntake||!config.intakeKeys[intakeKey])throw new HttpError(404,'Intake unavailable');
     res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await readFile(path.join(root,'intake.html')));return;
   }
   if(method==='GET'&&(pathname==='/privacy'||pathname==='/terms')){
     res.setHeader('Content-Type','text/html; charset=utf-8');
     res.end(pathname==='/privacy'?PRIVACY_HTML:TERMS_HTML);return;
   }
   const staticFiles={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/app.css':'app.css','/intake.js':'intake.js','/signup':'signup.html','/signup.html':'signup.html','/verify-email':'verify.html','/reset-password':'reset.html','/account.js':'account.js'};
   if(method==='GET'&&staticFiles[pathname]){
     const file=staticFiles[pathname];
     res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
     res.end(await readFile(path.join(root,file)));return;
   }
   let session=parseSession(req,config.secret);
   if(session){
     const isRevoked=state?await state.isRevoked(sharedKey('jti','',session.jti)):revoked.has(session.jti);
     if(isRevoked || (config.mode==='airtable'&&session.epoch!==processEpoch))session=null;
     else if(config.mode==='airtable'){
       const current=config.users.find(x=>x.email.toLowerCase()===session.email.toLowerCase()&&x.businessKey===session.businessKey&&x.role===session.role);
       if(current){if(session.credentialVersion!==credentialVersion(current))session=null;}
       else if(config.signupEnabled&&typeof repo.findAccount==='function'){
         // Self-serve account: the credential version binds to the account
         // record, so a password reset invalidates live sessions exactly as
         // a configured-user rotation does.
         const acct=await repo.findAccount('Email',session.email.toLowerCase());
         if(!acct||acct.fields['Business Key']!==session.businessKey||acct.fields['Email Verified']!==true||session.credentialVersion!==credentialVersion({email:acct.fields.Email,businessKey:acct.fields['Business Key'],role:acct.fields.Role||'owner',passwordHash:acct.fields['Password Hash']}))session=null;
       }
       else session=null;
     }
   }
   if(revoked.size>5000)for(const [id,expiration] of revoked)if(expiration<Date.now())revoked.delete(id);
   if(pathname==='/api/login'&&method==='POST'){
     checkedOrigin(req,config);await checkedRate('login-ip',requestIP(req,config),12,15*60*1000);
     const data=await bodyJson(req);
     const accountKey=createHash('sha256').update(String(data.email||'').trim().toLowerCase()).digest('hex');
     await checkedRate('login-account',accountKey,20,15*60*1000);
     let user=findLoginUser(data.email,data.password,config.mode,config.users);
     if(!user&&config.signupEnabled&&typeof repo.findAccount==='function'){
       const acct=await repo.findAccount('Email',String(data.email||'').trim().toLowerCase());
       if(acct&&verifyPassword(String(data.password||''),acct.fields['Password Hash']||'')){
         if(acct.fields['Email Verified']!==true)throw new HttpError(403,'Email address not verified yet');
         user={email:acct.fields.Email,businessKey:acct.fields['Business Key'],role:acct.fields.Role||'owner'};
       }
     }
     if(!user)throw new HttpError(401,'Invalid login');
     if(!(await tenantAllowed(user.businessKey)))throw new HttpError(403,'Business tenant is not active or authorized for private access');
     let account=config.mode==='airtable'?config.users.find(x=>x.email.toLowerCase()===user.email.toLowerCase()):null;
     if(!account&&config.mode==='airtable'&&config.signupEnabled&&typeof repo.findAccount==='function'){
       const acct=await repo.findAccount('Email',user.email.toLowerCase());
       if(acct)account={email:acct.fields.Email,businessKey:acct.fields['Business Key'],role:acct.fields.Role||'owner',passwordHash:acct.fields['Password Hash']};
     }
     const {cookie,session:s}=issueCookie(user,config.secret,config.secure,config.mode==='airtable'?processEpoch:'',account?credentialVersion(account):'');
     // Fail closed if the centralized revocation service cannot be reached.
     if(state)await state.isRevoked(sharedKey('jti','',s.jti));
     res.setHeader('Set-Cookie',cookie);
     json(res,200,{user:{email:user.email,role:user.role,businessKey:user.businessKey},csrf:s.csrf});return;
   }
   if(pathname==='/api/logout'&&method==='POST'){
     if(!session)throw new HttpError(401,'Authentication required');checkedOrigin(req,config);requireCsrf(req,session);
     if(state)await state.revoke(sharedKey('jti','',session.jti),session.exp);
     else revoked.set(session.jti,session.exp);
     res.setHeader('Set-Cookie',clearCookie(config.secure));json(res,200,{ok:true});return;
   }
   if(pathname.startsWith('/api/intake/')){
     if(!config.publicIntake)throw new HttpError(404,'Intake unavailable');
     const intakeKey=pathname.slice('/api/intake/'.length);
     const key=config.intakeKeys[intakeKey];if(!key)throw new HttpError(404,'Intake unavailable');
     if(method==='POST'){
       checkedOrigin(req,config);await checkedRate('public-intake',requestIP(req,config),8,60*60*1000);const data=await bodyJson(req);
       if(data.website){json(res,202,{received:true});return;}// honeypot
       const result=await submitLead(key,data,'Website');
       json(res,202,{received:true,duplicate:result.data.duplicate});return;
     }
     throw new HttpError(405,'Method not allowed');
   }
   if(pathname==='/api/public-info'&&method==='GET'){
     json(res,200,{name:'QuotePilot AI',mode:config.mode==='demo'?'local demo':'connected private pilot',publicIntake:config.publicIntake,signupEnabled:config.signupEnabled,planPriceMonthly:config.planPriceMonthly,sendsEnabled:config.sendsEnabled,billingEnabled:config.billingEnabled,bookingsEnabled:config.bookingsEnabled});return;
   }
   if(pathname==='/api/billing/webhook'&&method==='POST'){
     // Gumroad checkout-completion hook. Authenticated by a shared secret
     // header (constant-time compare), rate-limited, and state values are
     // allowlisted — a webhook can never invent a subscription state.
     if(!config.billingEnabled)throw new HttpError(404,'Billing unavailable');
     await checkedRate('billing-webhook',requestIP(req,config),60,60*60*1000);
     const provided=Buffer.from(String(req.headers['x-qp-webhook-secret']||''));
     const expected=Buffer.from(config.webhookSecret);
     if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new HttpError(401,'Invalid webhook secret');
     const data=await bodyJson(req);
     const businessKey=requiredString(data.businessKey,'Business',60);
     const externalId=requiredString(data.externalSubscriptionId,'External subscription',120);
     if(!['Active','Trialing','Past Due','Cancelled'].includes(data.state))throw new HttpError(400,'Unsupported subscription state');
     const businesses=await repo.list('Businesses',businessKey);
     if(businesses.length!==1)throw new HttpError(404,'Business not found');
     const subs=await repo.list('Subscriptions',businessKey);
     const existing=subs.find(s=>s.fields['External Subscription ID']===externalId);
     const fields={'Plan':'QuotePilot Monthly','Amount Monthly':config.planPriceMonthly,'State':data.state,'External Subscription ID':externalId,'Customer Email':optionalEmail(data.email),'Last Event':requiredString(data.event||'update','Event',60),'Updated On':today()};
     const record=existing?await repo.update('Subscriptions',businessKey,existing.id,fields):await repo.create('Subscriptions',businessKey,{...fields,'Subscription Key':'QP-SUB-'+randomUUID().slice(0,10).toUpperCase()});
     json(res,200,{ok:true,recordId:record.id,state:data.state});return;
   }
   if(pathname==='/api/signup'&&method==='POST'){
     if(!config.signupEnabled)throw new HttpError(404,'Signup unavailable');
     checkedOrigin(req,config);await checkedRate('signup-ip',requestIP(req,config),5,60*60*1000);
     const data=await bodyJson(req);
     const companyName=requiredString(data.companyName,'Company name',120);
     const email=optionalEmail(data.email);if(!email)throw new HttpError(400,'Email is required');
     const passwordHash=hashPassword(typeof data.password==='string'?data.password:'');
     if(config.users.some(u=>u.email.toLowerCase()===email)||await repo.findAccount('Email',email))throw new HttpError(409,'An account with this email already exists');
     const businessKey='QP-'+randomUUID().slice(0,8).toUpperCase();
     await repo.create('Businesses',businessKey,{'Company Name':companyName,'Plan':'QuotePilot Monthly','Status':'Onboarding','Service ZIPs':optionalString(data.serviceZips,'Service ZIPs',200),'Time Zone':optionalString(data.timeZone,'Time zone',60)||'America/New_York','Services Offered':''});
     const token=randomBytes(24).toString('hex');
     await repo.create('Accounts',businessKey,{'Email':email,'Password Hash':passwordHash,'Role':'owner','Email Verified':false,'Verify Token Hash':tokenHash(token),'Verify Token Expires':Date.now()+24*3600*1000,'Created On':today()});
     const msg=verifyEmailMessage({companyName,link:accountLink(`/verify-email?token=${token}`)});
     await mailer.email.send({to:email,subject:msg.subject,body:msg.body});
     json(res,201,{ok:true,businessKey,verificationRequired:true});return;
   }
   if(pathname==='/api/verify-email'&&method==='POST'){
     if(!config.signupEnabled)throw new HttpError(404,'Verification unavailable');
     checkedOrigin(req,config);await checkedRate('verify-ip',requestIP(req,config),20,60*60*1000);
     const data=await bodyJson(req);const token=requiredString(data.token,'Token',100);
     const acct=await repo.findAccount('Verify Token Hash',tokenHash(token));
     if(!acct||Number(acct.fields['Verify Token Expires']||0)<Date.now())throw new HttpError(400,'Verification link is invalid or expired');
     await repo.update('Accounts',acct.fields['Business Key'],acct.id,{'Email Verified':true,'Verify Token Hash':'','Verify Token Expires':0});
     json(res,200,{ok:true});return;
   }
   if(pathname==='/api/verify-email/resend'&&method==='POST'){
     if(!config.signupEnabled)throw new HttpError(404,'Verification unavailable');
     checkedOrigin(req,config);await checkedRate('verify-resend-ip',requestIP(req,config),5,60*60*1000);
     const data=await bodyJson(req);const email=optionalEmail(data.email);
     const acct=email?await repo.findAccount('Email',email):null;
     if(acct&&acct.fields['Email Verified']!==true){
       const token=randomBytes(24).toString('hex');
       await repo.update('Accounts',acct.fields['Business Key'],acct.id,{'Verify Token Hash':tokenHash(token),'Verify Token Expires':Date.now()+24*3600*1000});
       const business=await businessRecord(repo,acct.fields['Business Key']);
       const msg=verifyEmailMessage({companyName:business.fields['Company Name']||'your business',link:accountLink(`/verify-email?token=${token}`)});
       try{await mailer.email.send({to:email,subject:msg.subject,body:msg.body});}catch{/* response stays generic */}
     }
     json(res,202,{received:true});return;
   }
   if(pathname==='/api/password-reset/request'&&method==='POST'){
     if(!config.signupEnabled)throw new HttpError(404,'Password reset unavailable');
     checkedOrigin(req,config);await checkedRate('reset-ip',requestIP(req,config),5,60*60*1000);
     const data=await bodyJson(req);const email=optionalEmail(data.email);
     if(email)await checkedRate('reset-account',createHash('sha256').update(email).digest('hex'),5,60*60*1000);
     const acct=email?await repo.findAccount('Email',email):null;
     if(acct){
       const token=randomBytes(24).toString('hex');
       await repo.update('Accounts',acct.fields['Business Key'],acct.id,{'Reset Token Hash':tokenHash(token),'Reset Token Expires':Date.now()+60*60*1000});
       const msg=resetEmailMessage({link:accountLink(`/reset-password?token=${token}`)});
       try{await mailer.email.send({to:email,subject:msg.subject,body:msg.body});}catch{/* response stays generic — never reveal account existence */}
     }
     json(res,202,{received:true});return;
   }
   if(pathname==='/api/password-reset/confirm'&&method==='POST'){
     if(!config.signupEnabled)throw new HttpError(404,'Password reset unavailable');
     checkedOrigin(req,config);await checkedRate('reset-confirm-ip',requestIP(req,config),10,60*60*1000);
     const data=await bodyJson(req);const token=requiredString(data.token,'Token',100);
     const acct=await repo.findAccount('Reset Token Hash',tokenHash(token));
     if(!acct||Number(acct.fields['Reset Token Expires']||0)<Date.now())throw new HttpError(400,'Reset link is invalid or expired');
     const passwordHash=hashPassword(typeof data.newPassword==='string'?data.newPassword:'');
     await repo.update('Accounts',acct.fields['Business Key'],acct.id,{'Password Hash':passwordHash,'Reset Token Hash':'','Reset Token Expires':0});
     json(res,200,{ok:true});return;
   }
   if(!pathname.startsWith('/api/'))throw new HttpError(404,'Not found');
   if(!session)throw new HttpError(401,'Authentication required');
   if(!(await tenantAllowed(session.businessKey)))throw new HttpError(403,'Business tenant is not active or authorized for private access');
   if(method!=='GET'){checkedOrigin(req,config);requireCsrf(req,session);}
   const key=session.businessKey;
   if(pathname==='/api/me'&&method==='GET'){
     json(res,200,{email:session.email,businessKey:key,role:session.role,csrf:session.csrf,dataMode:config.mode,gates:{outbound:config.sendsEnabled,checkout:config.billingEnabled,automatedBookings:config.bookingsEnabled},planPriceMonthly:config.planPriceMonthly});return;
   }
   if(pathname==='/api/dashboard'&&method==='GET'){json(res,200,await dashboard(repo,key,gates));return;}
   if(pathname==='/api/services'&&method==='GET'){
     json(res,200,{services:await tenantServices(repo,key),defaults:DEFAULT_SERVICES});return;
   }
   if(pathname==='/api/services'&&method==='POST'){
     if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
     const names=serviceCatalogInput(await bodyJson(req));
     const business=await businessRecord(repo,key);
     const record=await repo.update('Businesses',key,business.id,{'Services Offered':names.join('\n')});
     json(res,200,{record,services:names});return;
   }
   if(pathname==='/api/billing'&&method==='GET'){
     const subs=await repo.list('Subscriptions',key);
     const current=subs.filter(s=>s.fields['External Subscription ID']).slice(-1)[0]||subs.slice(-1)[0]||null;
     json(res,200,{billingEnabled:config.billingEnabled,checkoutUrl:config.billingEnabled?config.checkoutUrl:null,priceMonthly:config.planPriceMonthly,subscription:current?{id:current.id,fields:current.fields}:null});return;
   }
   const routes={'/api/leads':'Leads','/api/rules':'Pricing Rules','/api/estimates':'Estimates','/api/followups':'Follow Ups','/api/bookings':'Bookings','/api/subscriptions':'Subscriptions','/api/uploads':'Uploads'};
   if(method==='GET'&&routes[pathname]){json(res,200,{records:safeList(await repo.list(routes[pathname],key))});return;}
   if(method==='POST'&&pathname==='/api/rules'){
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const body=await bodyJson(req);const fields=pricingInput(body,await tenantServices(repo,key));
      const existing=await repo.list('Pricing Rules',key);
      if(existing.some(x=>x.fields.Service===fields.Service))throw new HttpError(409,'A pricing rule already exists for this service; edit the existing rule instead');
      const record=await repo.create('Pricing Rules',key,{...fields,'Rule Key':'QP-RULE-'+randomUUID().slice(0,10).toUpperCase(),'Approved':false,'Version':1,'Approval Notes':'New rule requires tenant owner review'});
      json(res,201,{record});return;
   }
   const ruleEdit=pathname.match(/^\/api\/rules\/([^/]+)\/(update|approve)$/);
   if(method==='POST'&&ruleEdit){
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const rule=await repo.get('Pricing Rules',key,ruleEdit[1]);
      if(ruleEdit[2]==='update'){
       const input=await bodyJson(req);const fields=pricingInput(input,await tenantServices(repo,key));
       if(fields.Service!==rule.fields.Service)throw new HttpError(409,'Service changes require a separate rule');
       const record=await repo.update('Pricing Rules',key,rule.id,{...fields,'Approved':false,'Version':Number(rule.fields.Version||0)+1,'Approval Notes':`Edited by ${session.email} on ${today()}; requires reapproval`});
       json(res,200,{record,approved:false});return;
      }
      if(Number(rule.fields['Base Price'])<0||rule.fields['Minimum Price']===undefined)throw new HttpError(409,'Pricing rule incomplete');
      const record=await repo.update('Pricing Rules',key,rule.id,{'Approved':true,'Approval Notes':`Internally approved by tenant owner ${session.email} on ${today()}. ${config.sendsEnabled?'Customer sending is enabled for this deployment.':'Customer sending remains disabled.'}`});
      json(res,200,{record,sendEnabled:config.sendsEnabled});return;
   }
   if(method==='POST'&&pathname==='/api/bookings'){
      const data=await bodyJson(req);const estimateId=requiredString(data.estimateId,'Estimate',100);const date=isoDate(data.requestedDate);
      const outcome=await durableWrite(key,'Bookings','booking',`${estimateId}|${date}`,async()=>{
      const estimate=await repo.get('Estimates',key,estimateId);
      if(estimate.fields.Status!=='Approved')throw new HttpError(409,'Estimate must be owner-approved before entering a booking request');
      const currentRule=(await repo.list('Pricing Rules',key)).find(r=>r.fields['Rule Key']===estimate.fields['Pricing Rule Key']);
      if(!currentRule||currentRule.fields.Approved!==true||Number(currentRule.fields.Version)!==Number(estimate.fields['Rule Version']))throw new HttpError(409,'Pricing is not current and approved for this booking request');
      const existing=(await repo.list('Bookings',key)).find(x=>x.fields['Estimate Key']===estimate.fields['Estimate Key']&&x.fields['Booked Date']===date);
      if(existing)return {status:200,data:{record:existing,duplicate:true,confirmed:false}};
      const record=await repo.create('Bookings',key,{'Booking Key':'QP-REQUEST-'+randomUUID().slice(0,10).toUpperCase(),'Lead Key':estimate.fields['Lead Key'],'Estimate Key':estimate.fields['Estimate Key'],'Booked Date':date,'Amount':estimate.fields['Estimated Total'],'Status':'Requested','Source Verified':false,'Notes':'Internal REQUEST ONLY — availability and actual booking unverified. No confirmation sent.'});
      return {status:201,data:{record,confirmed:false,sendEnabled:config.sendsEnabled}};
      });json(res,outcome.status,outcome.data);return;
   }
   const bookingConfirm=pathname.match(/^\/api\/bookings\/([^/]+)\/attest$/);
   if(method==='POST'&&bookingConfirm){
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const data=await bodyJson(req);const reference=requiredString(data.reference,'External booking confirmation evidence reference',200);
      const booking=await repo.get('Bookings',key,bookingConfirm[1]);
      const record=await repo.update('Bookings',key,booking.id,{'Status':'Requested','Source Verified':false,'Notes':`OWNER-ATTESTED external booking reference: ${reference}. Recorded by ${session.email} on ${today()}. Not verified against external provider by this application.`});
      json(res,200,{record,ownerAttested:true,externalProviderVerified:false,confirmed:false,sendEnabled:config.sendsEnabled});return;
   }
   const bookingDoConfirm=pathname.match(/^\/api\/bookings\/([^/]+)\/confirm$/);
   if(method==='POST'&&bookingDoConfirm){
      // Confirmation is the business's own act, recorded in the app at the
      // owner's direction. No external availability system is consulted or
      // claimed — the note on the record says exactly that.
      if(!config.bookingsEnabled)throw new HttpError(404,'Booking confirmation is not enabled');
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const booking=await repo.get('Bookings',key,bookingDoConfirm[1]);
      if(booking.fields.Status==='Confirmed'){json(res,200,{record:booking,duplicate:true,confirmed:true});return;}
      if(booking.fields.Status!=='Requested')throw new HttpError(409,'Only a requested booking can be confirmed');
      const lead=(await repo.list('Leads',key)).find(x=>x.fields['Lead Key']===booking.fields['Lead Key']);
      const business=await businessRecord(repo,key);
      const companyName=business.fields['Company Name']||'Your service provider';
      const notified={email:false,sms:false};const issues=[];
      if(config.sendsEnabled&&lead){
        const composed=bookingConfirmation({companyName,lead:lead.fields,booking:booking.fields});
        const consent=lead.fields['Consent To Follow Up']===true&&!lead.fields['Opted Out'];
        if(mailer.email&&consent&&lead.fields['Customer Email']){try{await mailer.email.send({to:lead.fields['Customer Email'],subject:composed.subject,body:composed.emailBody});notified.email=true;}catch{issues.push('email delivery failed');}}
        if(mailer.sms&&consent&&lead.fields['Customer Phone']){try{await mailer.sms.send({to:lead.fields['Customer Phone'],body:composed.smsBody});notified.sms=true;}catch{issues.push('sms delivery failed');}}
      }
      const record=await repo.update('Bookings',key,booking.id,{'Status':'Confirmed','Confirmed By':session.email,'Confirmed On':today(),'Confirmation Notification':`email:${notified.email?'sent':'not sent'} sms:${notified.sms?'sent':'not sent'}`,'Notes':`Confirmed by ${session.email} on ${today()} at the business's direction. This confirmation is the business's own record; no external availability system was checked.${issues.length?' Notification issues: '+issues.join('; '):''}`});
      json(res,200,{record,confirmed:true,notified});return;
   }
   if(method==='POST'&&pathname==='/api/leads'){
      const outcome=await submitLead(key,await bodyJson(req),'Manual');
      json(res,outcome.status,outcome.data);return;
   }
   if(method==='POST'&&pathname==='/api/estimate-preview'){
     const data=await bodyJson(req);const leadId=requiredString(data.leadId,'Lead',100),ruleId=requiredString(data.ruleId,'Rule',100);
     json(res,200,await pricePreview(repo,key,leadId,ruleId));return;
   }
   if(method==='POST'&&pathname==='/api/estimates'){
      const data=await bodyJson(req);const leadId=requiredString(data.leadId,'Lead',100),ruleId=requiredString(data.ruleId,'Rule',100);
      const pricingRule=await repo.get('Pricing Rules',key,ruleId);
      const outcome=await durableWrite(key,'Estimates','estimate',`${leadId}|${ruleId}|${pricingRule.fields.Version}`,async()=>{
      const {estimate,lead,rule}=await pricePreview(repo,key,leadId,ruleId);
      const others=await repo.list('Estimates',key);
      const prior=others.find(r=>r.fields['Lead Key']===lead['Lead Key'] && r.fields['Pricing Rule Key']===rule.key && Number(r.fields['Rule Version'])===Number(rule.version));
      if(prior)return {status:200,data:{record:prior,duplicate:true,sendEnabled:config.sendsEnabled}};
      const fields={'Estimate Key':'QP-EST-'+randomUUID().slice(0,12).toUpperCase(),'Lead Key':lead['Lead Key'],'Pricing Rule Key':rule.key,'Rule Version':rule.version,'Base':estimate.base,'Bedroom Charge':estimate.bedroomCharge,'Bathroom Charge':estimate.bathroomCharge,'Area Charge':estimate.areaCharge,'Addon Charge':estimate.addonCharge,'Multiplier':estimate.multiplier,'Minimum':estimate.minimum,'Estimated Total':estimate.total,'Status':'Awaiting Approval','Response Draft':`INTERNAL DRAFT ONLY: preliminary ${lead.Service} estimate $${estimate.total.toFixed(2)}, subject to verified tenant approval, scope and actual availability. NOT SENT.`, 'Assumptions':rule.approved?'Approved pricing rule snapshot; still requires operator acceptance':'FICTIONAL/UNAPPROVED PRICING RULE. Cannot issue externally.','Date':today()};
      const r=await repo.create('Estimates',key,fields);return {status:201,data:{record:r,duplicate:false,sendEnabled:config.sendsEnabled}};
      });json(res,outcome.status,outcome.data);return;
   }
   // A tenant-owner decision is an INTERNAL workflow milestone, not authority to transmit a quote.
   const estimateReview=pathname.match(/^\/api\/estimates\/([^/]+)\/(approve|reject)$/);
   if(method==='POST'&&estimateReview){
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const stored=await repo.get('Estimates',key,estimateReview[1]);
      const body=await bodyJson(req);
      const action=estimateReview[2];
      if(action==='approve' && stored.fields.Status==='Approved'){
       json(res,200,{record:stored,duplicate:true,sendEnabled:config.sendsEnabled});return;
      }
      if(!['Awaiting Approval','Draft'].includes(stored.fields.Status))throw new HttpError(409,'Estimate is not in the review queue');
      if(action==='reject'){
       const reason=requiredString(body.reason,'Rejection reason',500);
       if(reason.length<5)throw new HttpError(400,'Rejection reason must be at least 5 characters');
       const record=await repo.update('Estimates',key,stored.id,{
         'Status':'Rejected','Assumptions':`INTERNAL REJECTION by ${session.email} on ${today()}: ${reason}`
       });
       json(res,200,{record,sendEnabled:config.sendsEnabled});return;
      }
      const rules=await repo.list('Pricing Rules',key);
      const rule=rules.find(r=>r.fields['Rule Key']===stored.fields['Pricing Rule Key']);
      if(!rule||rule.fields.Approved!==true)throw new HttpError(409,'Current pricing rule is not owner-approved');
      if(Number(rule.fields.Version)!==Number(stored.fields['Rule Version']))throw new HttpError(409,'Pricing version changed; create a new estimate from the current rule');
      const lead=(await repo.list('Leads',key)).find(r=>r.fields['Lead Key']===stored.fields['Lead Key']);
      if(!lead)throw new HttpError(404,'Corresponding lead not found');
      if(lead.fields.Service!==rule.fields.Service)throw new HttpError(409,'Lead and pricing rule service mismatch');
      const recomputed=computeEstimate(rule.fields,lead.fields);
      if(Math.abs(recomputed.total-Number(stored.fields['Estimated Total']))>0.009)throw new HttpError(409,'Stored estimate amount does not match the current deterministic calculation');
      const record=await repo.update('Estimates',key,stored.id,{
        'Status':'Approved','Approved By':session.email,
        'Assumptions':`Owner-approved INTERNAL estimate against pricing rule ${rule.fields['Rule Key']} version ${rule.fields.Version} on ${today()}. No customer contact or external availability confirmed.`
      });
      json(res,200,{record,approvedInternally:true,sendEnabled:config.sendsEnabled});return;
   }
   if(method==='POST'&&pathname==='/api/followup-draft'){
      const data=await bodyJson(req),estimateId=requiredString(data.estimateId,'Estimate',100);
      const outcome=await durableWrite(key,'Follow Ups','followup',estimateId,async()=>{
      const estimate=await repo.get('Estimates',key,estimateId);
      const leads=await repo.list('Leads',key);const lead=leads.find(x=>x.fields['Lead Key']===estimate.fields['Lead Key']);
      if(!lead)throw new HttpError(404,'Lead not found');
      if(estimate.fields.Status!=='Approved')throw new HttpError(409,'Internal estimate owner approval required before preparing a follow-up draft');
      if(lead.fields['Opted Out']||lead.fields['Consent To Follow Up']!==true||!lead.fields['Customer Email'])throw new HttpError(409,'Email or follow-up consent not verified');
      const rules=await repo.list('Pricing Rules',key);const rule=rules.find(x=>x.fields['Rule Key']===estimate.fields['Pricing Rule Key']);
      if(!rule||rule.fields.Approved!==true)throw new HttpError(409,'Pricing rule not approved; customer follow-up draft blocked');
      if(Number(rule.fields.Version)!==Number(estimate.fields['Rule Version']))throw new HttpError(409,'Pricing version changed; previous estimate draft cannot be used');
      const existing=(await repo.list('Follow Ups',key)).find(x=>x.fields['Estimate Key']===estimate.fields['Estimate Key']);
      if(existing)return {status:200,data:{record:existing,duplicate:true,sendEnabled:config.sendsEnabled}};
      const r=await repo.create('Follow Ups',key,{'Followup Key':'QP-FU-'+randomUUID().slice(0,12).toUpperCase(),'Lead Key':lead.fields['Lead Key'],'Estimate Key':estimate.fields['Estimate Key'],'Recipient Email':lead.fields['Customer Email'],'Status':'Needs Review','Template':'Quote Ready','Body':'DRAFT ONLY — verify booking availability and pricing before founder-authorized customer outreach.','Consent Verified':true});
      return {status:201,data:{record:r,sendEnabled:config.sendsEnabled}};
      });json(res,outcome.status,outcome.data);return;
   }
   const estimateSend=pathname.match(/^\/api\/estimates\/([^/]+)\/send$/);
   if(method==='POST'&&estimateSend){
      if(!config.sendsEnabled)throw new HttpError(404,'Estimate sending is not enabled');
      const body=await bodyJson(req);const channel=body.channel==='sms'?'sms':'email';
      const transport=channel==='email'?mailer.email:mailer.sms;
      if(!transport)throw new HttpError(409,`The ${channel} channel is not configured`);
      const estimate=await repo.get('Estimates',key,estimateSend[1]);
      if(estimate.fields.Status!=='Approved')throw new HttpError(409,'Estimate must be owner-approved before sending');
      const lead=(await repo.list('Leads',key)).find(x=>x.fields['Lead Key']===estimate.fields['Lead Key']);
      if(!lead)throw new HttpError(404,'Corresponding lead not found');
      if(lead.fields['Opted Out']||lead.fields['Consent To Follow Up']!==true)throw new HttpError(409,'Customer consent to contact is not on record');
      const to=channel==='email'?lead.fields['Customer Email']:lead.fields['Customer Phone'];
      if(!to)throw new HttpError(409,channel==='email'?'Lead has no email address':'Lead has no phone number');
      const business=await businessRecord(repo,key);
      const companyName=business.fields['Company Name']||'Your service provider';
      const est={total:Number(estimate.fields['Estimated Total']),base:Number(estimate.fields.Base),bedroomCharge:Number(estimate.fields['Bedroom Charge']),bathroomCharge:Number(estimate.fields['Bathroom Charge']),areaCharge:Number(estimate.fields['Area Charge']),addonCharge:Number(estimate.fields['Addon Charge']),minimum:Number(estimate.fields.Minimum),multiplier:Number(estimate.fields.Multiplier)};
      const composed=channel==='email'?estimateEmail({companyName,lead:lead.fields,estimate:est}):estimateSms({companyName,lead:lead.fields,estimate:est});
      const sent=await transport.send({to,subject:composed.subject,body:composed.body});
      const record=await repo.update('Estimates',key,estimate.id,{'Send Status':'Sent','Sent Channel':channel,'Sent To':to,'Sent On':new Date().toISOString(),'Send Provider ID':sent.id});
      json(res,200,{record,sendEnabled:true,sent:{channel,transport:sent.transport,id:sent.id}});return;
   }
   const followupSend=pathname.match(/^\/api\/followups\/([^/]+)\/send$/);
   if(method==='POST'&&followupSend){
      if(!config.sendsEnabled)throw new HttpError(404,'Follow-up sending is not enabled');
      if(!mailer.email)throw new HttpError(409,'The email channel is not configured');
      const followup=await repo.get('Follow Ups',key,followupSend[1]);
      if(followup.fields.Status==='Sent'){json(res,200,{record:followup,duplicate:true,sendEnabled:true});return;}
      const lead=(await repo.list('Leads',key)).find(x=>x.fields['Lead Key']===followup.fields['Lead Key']);
      const estimate=(await repo.list('Estimates',key)).find(x=>x.fields['Estimate Key']===followup.fields['Estimate Key']);
      if(!lead||!estimate)throw new HttpError(404,'Corresponding lead or estimate not found');
      if(lead.fields['Opted Out']||lead.fields['Consent To Follow Up']!==true||followup.fields['Consent Verified']!==true)throw new HttpError(409,'Customer consent to contact is not on record');
      const business=await businessRecord(repo,key);
      const composed=followupEmail({companyName:business.fields['Company Name']||'Your service provider',lead:lead.fields,estimate:{total:Number(estimate.fields['Estimated Total'])}});
      const sent=await mailer.email.send({to:followup.fields['Recipient Email'],subject:composed.subject,body:composed.body});
      const record=await repo.update('Follow Ups',key,followup.id,{'Status':'Sent','Sent On':new Date().toISOString(),'Send Provider ID':sent.id});
      json(res,200,{record,sendEnabled:true,sent:{channel:'email',transport:sent.transport,id:sent.id}});return;
   }
   if(method==='POST'&&pathname==='/api/uploads'){
      if(!config.uploadsEnabled)throw new HttpError(404,'Uploads are not enabled');
      const filename=u.searchParams.get('filename')||'';
      const leadId=u.searchParams.get('leadId')||'';
      const estimateId=u.searchParams.get('estimateId')||'';
      let leadKey='',estimateKey='';
      if(leadId){const lead=await repo.get('Leads',key,leadId);leadKey=lead.fields['Lead Key'];}
      if(estimateId){const est=await repo.get('Estimates',key,estimateId);estimateKey=est.fields['Estimate Key'];}
      const data=await bodyRaw(req,config.uploadMaxBytes+1024);
      const checked=validateUpload({filename,contentType:req.headers['content-type'],data,maxBytes:config.uploadMaxBytes});
      const ref=newUploadRef(checked.ext);
      await uploads.put(ref,data);
      const record=await repo.create('Uploads',key,{'Upload Key':'QP-UPL-'+randomUUID().slice(0,10).toUpperCase(),'Lead Key':leadKey,'Estimate Key':estimateKey,'Filename':checked.filename,'Content Type':checked.contentType,'Size Bytes':checked.size,'Storage Ref':ref,'Uploaded By':session.email,'Created On':today()});
      json(res,201,{record});return;
   }
   const uploadDownload=pathname.match(/^\/api\/uploads\/([^/]+)\/download$/);
   if(method==='GET'&&uploadDownload){
      const record=await repo.get('Uploads',key,uploadDownload[1]);
      const data=await uploads.get(record.fields['Storage Ref']);
      res.statusCode=200;res.setHeader('Content-Type',record.fields['Content Type']||'application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${String(record.fields.Filename||'file').replace(/["\\\r\n]/g,'_')}"`);res.end(data);return;
   }
   throw new HttpError(404,'Not found');
  }catch(err){const code=err instanceof HttpError?err.status:500;if(code>=500)console.error('QuotePilot request error:',err?.message||'unknown');json(res,code,{error:code>=500?'Service temporarily unavailable':err.message});}
 };
 return {handler:app,config,repo,messaging:mailer,uploadStore:uploads,sharedState:state};
}
const isDirect=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isDirect){try{const app=createApp();http.createServer(app.handler).listen(app.config.port,app.config.host,()=>{console.log(`QuotePilot ${app.config.mode} mode listening on http://${app.config.host}:${app.config.port}`);console.log(`Customer sends: ${app.config.sendsEnabled?'ENABLED':'DISABLED'} · Live billing: ${app.config.billingEnabled?'ENABLED':'DISABLED'} · Booking confirmations: ${app.config.bookingsEnabled?'ENABLED':'DISABLED'} · Signup: ${app.config.signupEnabled?'ENABLED':'DISABLED'} · Uploads: ${app.config.uploadsEnabled?'ENABLED':'DISABLED'}`);});}catch(err){console.error('QuotePilot startup blocked:',err.message);process.exit(1);}}
