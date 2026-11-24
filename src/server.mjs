import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID, createHash, createHmac, randomBytes} from 'node:crypto';
import {SharedStateHttpClient} from './shared/http.mjs';
import {AirtableRepo,stagingTableMapFromEnv,STAGING_BASE_ID} from './storage/airtable.mjs';
import {DemoRepo} from './storage/demo.mjs';
import {HttpError, leadInput, requiredString, isoDate, pricingInput} from './lib/validators.mjs';
import {computeEstimate} from './lib/pricing.mjs';
import {demoUsers, findLoginUser, issueCookie, parseSession, clearCookie, requireCsrf, credentialVersion} from './lib/auth.mjs';
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
 const secret=env.QP_SESSION_SECRET||'';
 if(secret.length<32) throw new Error('QP_SESSION_SECRET must be >=32 chars');
 if(env.QP_ALLOW_CUSTOMER_SENDS==='1'||env.QP_ALLOW_LIVE_BILLING==='1'||env.QP_ALLOW_AUTOMATED_BOOKINGS==='1')throw new Error('External actions not included or authorized in this build');
 let users=[];if(!demo){if(!env.AIRTABLE_TOKEN)throw new Error('AIRTABLE_TOKEN required in production data mode');try{users=JSON.parse(env.QP_USERS_JSON||'[]');}catch{throw new Error('QP_USERS_JSON must be valid JSON');}if(!Array.isArray(users)||!users.length||users.some(x=>!x.email||!x.businessKey||!['owner','operator'].includes(x.role)||!/^([a-f0-9]{32}):([a-f0-9]{128})$/i.test(x.passwordHash||'')))throw new Error('Valid configured user credentials required');if(new Set(users.map(x=>x.email.toLowerCase())).size!==users.length)throw new Error('Duplicate user email configuration blocked');}
 let intakeKeys={};try{intakeKeys=JSON.parse(env.QP_TENANT_INTAKE_KEYS_JSON||'{}');}catch{throw new Error('Invalid intake mapping JSON');}
 const secure=env.NODE_ENV==='production';const allowedOrigins=(env.QP_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
 if(secure&&allowedOrigins.length===0)throw new Error('Production requires explicit QP_ALLOWED_ORIGINS');
 for(const origin of allowedOrigins){let url;try{url=new URL(origin)}catch{throw new Error('Invalid allowed origin')};if(origin!==url.origin||(secure&&url.protocol!=='https:'))throw new Error('QP_ALLOWED_ORIGINS must contain exact HTTPS origins');}
 if(secure&&env.QP_PUBLIC_INTAKE_ENABLED==='1')throw new Error('Public intake blocked until abuse and privacy release review');
 const coordinatorUrl=env.QP_SHARED_STATE_URL||'';
 const coordinatorToken=env.QP_SHARED_STATE_TOKEN||'';
 const sharedStateRequired=env.QP_SHARED_STATE_REQUIRED==='1';
 const sharedStateProvider=env.QP_SHARED_STATE_PROVIDER||'';
 if(!['','neon'].includes(sharedStateProvider))throw new Error('Unsupported shared-state provider');
 if(sharedStateProvider==='neon' && !sharedStateRequired)throw new Error('Neon shared-state requires fail-closed enforcement');
 if(sharedStateProvider==='neon' && coordinatorUrl)throw new Error('Only one shared-state provider is permitted');
 if(sharedStateProvider==='neon' && !env.QP_SECURITY_DATABASE_URL)throw new Error('QuotePilot security database secret required');
 if(coordinatorUrl){let u;try{u=new URL(coordinatorUrl);}catch{throw new Error('QP_SHARED_STATE_URL invalid');}
   if(u.username||u.password||u.search||u.hash||u.origin!==coordinatorUrl.replace(/\/$/,'')||(secure&&u.protocol!=='https:'))throw new Error('Shared-state URL requires an exact HTTPS origin without credentials');
   if(coordinatorToken.length<32)throw new Error('Shared-state strong token required');
 }
 if(sharedStateRequired&&!coordinatorUrl&&sharedStateProvider!=='neon')throw new Error('Shared-state backend required before commercial rollout');
 return {mode,stagingTables,stagingBaseId:stage?STAGING_BASE_ID:null,host,port:Number(env.PORT||3333),secret,users,secure,allowedOrigins,publicIntake:env.QP_PUBLIC_INTAKE_ENABLED==='1',intakeKeys,allowDemo:env.QP_ALLOW_DEMO==='1',sessionEpoch:env.QP_SESSION_EPOCH||(secure?'quotepilot-private-pilot-auth-r2':''),coordinatorUrl,coordinatorToken,sharedStateRequired,sharedStateProvider,vercelRuntime:env.VERCEL==='1'};
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
function checkedOrigin(req,cfg){const origin=req.headers.origin;const host=req.headers.host;if(!origin)throw new HttpError(403,'Origin required');let u;try{u=new URL(origin);}catch{throw new HttpError(403,'Invalid origin');}if(u.host!==host||!['http:','https:'].includes(u.protocol))throw new HttpError(403,'Cross-site request refused');if(cfg.secure&&u.protocol!=='https:')throw new HttpError(403,'HTTPS required');if(cfg.allowedOrigins?.length&&!cfg.allowedOrigins.includes(u.origin))throw new HttpError(403,'Origin not approved');}
function rateCheck(buckets,key,max,periodMs){const now=Date.now();let cur=buckets.get(key)||[];cur=cur.filter(t=>t>now-periodMs);if(cur.length>=max)throw new HttpError(429,'Too many attempts; retry later');cur.push(now);buckets.set(key,cur);if(buckets.size>6000)for(const [k,v] of buckets){if(v.every(t=>t<now-periodMs))buckets.delete(k);}}
function dedupKey(fields,business){const normalized=[business,fields['Customer Email'].toLowerCase(),fields['Customer Phone'],fields['Service'],fields['Postal Code'],fields['Requested Date']||''].join('|');return createHash('sha256').update(normalized).digest('hex');}
function safeList(records){return records.map(r=>({id:r.id,fields:r.fields}));}
async function dashboard(repo,key){
 const [leads,estimates,bookings,followups,businesses,subs]=await Promise.all(['Leads','Estimates','Bookings','Follow Ups','Businesses','Subscriptions'].map(table=>repo.list(table,key)));
 return {business:businesses[0]?.fields||null,counts:{leads:leads.length,estimates:estimates.length,bookings:bookings.length,followupDrafts:followups.length,needsReview:leads.filter(x=>x.fields.Stage==='Needs Review').length},latestLeads:safeList(leads.slice(-7).reverse()),latestEstimates:safeList(estimates.slice(-7).reverse()),subscriptions:safeList(subs),gate:{outboundSends:false,paymentCharges:false,automaticBookings:false}};
}
async function leadServiceAreaAllows(repo,key,postalCode){
 const businesses=await repo.list('Businesses',key);
 if(!businesses.length)throw new HttpError(404,'Business not found');
 const zipTokens=String(businesses[0].fields['Service ZIPs']||'').split(/[\s,;]+/).filter(Boolean);
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
export function createApp({config=configFromEnv(),repository=null,sharedState=null}={}){
 const repo=repository|| (config.mode==='demo'?new DemoRepo():new AirtableRepo({token:process.env.AIRTABLE_TOKEN,baseId:config.stagingBaseId||process.env.AIRTABLE_BASE_ID||'appWNg4MRrQ2TViqi',tables:config.stagingTables||undefined}));
 const state=sharedState||(config.coordinatorUrl?new SharedStateHttpClient({url:config.coordinatorUrl,token:config.coordinatorToken}):null);
 if((config.sharedStateRequired||config.sharedStateProvider==='neon')&&!state)throw new Error('Shared-state backend required before commercial rollout');
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
     return {status:200,data:table==='Leads'?{lead:record,duplicate:true}:{record,duplicate:true,sendEnabled:false,...(table==='Bookings'?{confirmed:false}:{})}};
   }
   const outcome=await tenantWrite(tenant,run);
   const record=outcome.data?.record||outcome.data?.lead;
   if(!record?.id)throw new HttpError(503,'Operation requires operator reconciliation');
   await state.complete(key,claim.ownerToken,record.id);
   return outcome;
 }
 async function submitLead(key,input,source){
   const fields=leadInput(input);
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
   if(method==='GET'&&['/','/index.html','/app.js','/app.css','/intake.js'].includes(pathname)){
     const file=pathname==='/app.js'?'app.js':pathname==='/app.css'?'app.css':pathname==='/intake.js'?'intake.js':'index.html';
     res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
     res.end(await readFile(path.join(root,file)));return;
   }
   let session=parseSession(req,config.secret);
   if(session){
     const isRevoked=state?await state.isRevoked(sharedKey('jti','',session.jti)):revoked.has(session.jti);
     if(isRevoked || (config.mode==='airtable'&&session.epoch!==processEpoch))session=null;
     else if(config.mode==='airtable'){
       const current=config.users.find(x=>x.email.toLowerCase()===session.email.toLowerCase()&&x.businessKey===session.businessKey&&x.role===session.role);
       if(!current||session.credentialVersion!==credentialVersion(current))session=null;
     }
   }
   if(revoked.size>5000)for(const [id,expiration] of revoked)if(expiration<Date.now())revoked.delete(id);
   if(pathname==='/api/login'&&method==='POST'){
     checkedOrigin(req,config);await checkedRate('login-ip',requestIP(req,config),12,15*60*1000);
     const data=await bodyJson(req);
     const accountKey=createHash('sha256').update(String(data.email||'').trim().toLowerCase()).digest('hex');
     await checkedRate('login-account',accountKey,20,15*60*1000);
     const user=findLoginUser(data.email,data.password,config.mode,config.users);
     if(!user)throw new HttpError(401,'Invalid login');
     if(!(await tenantAllowed(user.businessKey)))throw new HttpError(403,'Business tenant is not active or authorized for private access');
     const account=config.mode==='airtable'?config.users.find(x=>x.email.toLowerCase()===user.email.toLowerCase()):null;
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
     json(res,200,{name:'QuotePilot AI',mode:config.mode==='demo'?'local demo':'connected private pilot',publicIntake:config.publicIntake});return;
   }
   if(!pathname.startsWith('/api/'))throw new HttpError(404,'Not found');
   if(!session)throw new HttpError(401,'Authentication required');
   if(!(await tenantAllowed(session.businessKey)))throw new HttpError(403,'Business tenant is not active or authorized for private access');
   if(method!=='GET'){checkedOrigin(req,config);requireCsrf(req,session);}
   const key=session.businessKey;
   if(pathname==='/api/me'&&method==='GET'){
     json(res,200,{email:session.email,businessKey:key,role:session.role,csrf:session.csrf,dataMode:config.mode,gates:{outbound:false,checkout:false,automatedBookings:false}});return;
   }
   if(pathname==='/api/dashboard'&&method==='GET'){json(res,200,await dashboard(repo,key));return;}
   const routes={'/api/leads':'Leads','/api/rules':'Pricing Rules','/api/estimates':'Estimates','/api/followups':'Follow Ups','/api/bookings':'Bookings','/api/subscriptions':'Subscriptions'};
   if(method==='GET'&&routes[pathname]){json(res,200,{records:safeList(await repo.list(routes[pathname],key))});return;}
   if(method==='POST'&&pathname==='/api/rules'){
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const body=await bodyJson(req);const fields=pricingInput(body);
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
       const input=await bodyJson(req);const fields=pricingInput(input);
       if(fields.Service!==rule.fields.Service)throw new HttpError(409,'Service changes require a separate rule');
       const record=await repo.update('Pricing Rules',key,rule.id,{...fields,'Approved':false,'Version':Number(rule.fields.Version||0)+1,'Approval Notes':`Edited by ${session.email} on ${today()}; requires reapproval`});
       json(res,200,{record,approved:false});return;
      }
      if(Number(rule.fields['Base Price'])<0||rule.fields['Minimum Price']===undefined)throw new HttpError(409,'Pricing rule incomplete');
      const record=await repo.update('Pricing Rules',key,rule.id,{'Approved':true,'Approval Notes':`Internally approved by tenant owner ${session.email} on ${today()}. Customer sending remains disabled.`});
      json(res,200,{record,sendEnabled:false});return;
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
      return {status:201,data:{record,confirmed:false,sendEnabled:false}};
      });json(res,outcome.status,outcome.data);return;
   }
   const bookingConfirm=pathname.match(/^\/api\/bookings\/([^/]+)\/attest$/);
   if(method==='POST'&&bookingConfirm){
      if(session.role!=='owner')throw new HttpError(403,'Owner permission required');
      const data=await bodyJson(req);const reference=requiredString(data.reference,'External booking confirmation evidence reference',200);
      const booking=await repo.get('Bookings',key,bookingConfirm[1]);
      const record=await repo.update('Bookings',key,booking.id,{'Status':'Requested','Source Verified':false,'Notes':`OWNER-ATTESTED external booking reference: ${reference}. Recorded by ${session.email} on ${today()}. Not verified against external provider by this application.`});
      json(res,200,{record,ownerAttested:true,externalProviderVerified:false,confirmed:false,sendEnabled:false});return;
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
      if(prior)return {status:200,data:{record:prior,duplicate:true,sendEnabled:false}};
      const fields={'Estimate Key':'QP-EST-'+randomUUID().slice(0,12).toUpperCase(),'Lead Key':lead['Lead Key'],'Pricing Rule Key':rule.key,'Rule Version':rule.version,'Base':estimate.base,'Bedroom Charge':estimate.bedroomCharge,'Bathroom Charge':estimate.bathroomCharge,'Area Charge':estimate.areaCharge,'Addon Charge':estimate.addonCharge,'Multiplier':estimate.multiplier,'Minimum':estimate.minimum,'Estimated Total':estimate.total,'Status':'Awaiting Approval','Response Draft':`INTERNAL DRAFT ONLY: preliminary ${lead.Service} estimate $${estimate.total.toFixed(2)}, subject to verified tenant approval, scope and actual availability. NOT SENT.`, 'Assumptions':rule.approved?'Approved pricing rule snapshot; still requires operator acceptance':'FICTIONAL/UNAPPROVED PRICING RULE. Cannot issue externally.','Date':today()};
      const r=await repo.create('Estimates',key,fields);return {status:201,data:{record:r,duplicate:false,sendEnabled:false}};
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
       json(res,200,{record:stored,duplicate:true,sendEnabled:false});return;
      }
      if(!['Awaiting Approval','Draft'].includes(stored.fields.Status))throw new HttpError(409,'Estimate is not in the review queue');
      if(action==='reject'){
       const reason=requiredString(body.reason,'Rejection reason',500);
       if(reason.length<5)throw new HttpError(400,'Rejection reason must be at least 5 characters');
       const record=await repo.update('Estimates',key,stored.id,{
         'Status':'Rejected','Assumptions':`INTERNAL REJECTION by ${session.email} on ${today()}: ${reason}`
       });
       json(res,200,{record,sendEnabled:false});return;
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
      json(res,200,{record,approvedInternally:true,sendEnabled:false});return;
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
      if(existing)return {status:200,data:{record:existing,duplicate:true,sendEnabled:false}};
      const r=await repo.create('Follow Ups',key,{'Followup Key':'QP-FU-'+randomUUID().slice(0,12).toUpperCase(),'Lead Key':lead.fields['Lead Key'],'Estimate Key':estimate.fields['Estimate Key'],'Recipient Email':lead.fields['Customer Email'],'Status':'Needs Review','Template':'Quote Ready','Body':'DRAFT ONLY — verify booking availability and pricing before founder-authorized customer outreach.','Consent Verified':true});
      return {status:201,data:{record:r,sendEnabled:false}};
      });json(res,outcome.status,outcome.data);return;
   }
   throw new HttpError(404,'Not found');
  }catch(err){const code=err instanceof HttpError?err.status:500;if(code>=500)console.error('QuotePilot request error:',err?.message||'unknown');json(res,code,{error:code>=500?'Service temporarily unavailable':err.message});}
 };
 return {handler:app,config,repo};
}
const isDirect=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isDirect){try{const app=createApp();http.createServer(app.handler).listen(app.config.port,app.config.host,()=>{console.log(`QuotePilot ${app.config.mode} mode listening on http://${app.config.host}:${app.config.port}`);console.log('Customer sends, billing and automatic bookings: DISABLED');});}catch(err){console.error('QuotePilot startup blocked:',err.message);process.exit(1);}}
