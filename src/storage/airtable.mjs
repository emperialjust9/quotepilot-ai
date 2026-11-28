import {HttpError} from '../lib/validators.mjs';
export const PRODUCTION_TABLES={Businesses:'tblriCRqDFuYVFb4Y','Pricing Rules':'tblNYHL28rDRJhRnV',Leads:'tblPlYhHpjQVDYlRw',Estimates:'tbl5uhrNYhVST9clw','Follow Ups':'tblJyp1cIAjj0JmM6',Bookings:'tblLlHYYkrIi7ds9n',Subscriptions:'tblg8JpSQaEkyRmCT','Operations & QA':'tbl6eoMpfRK4D75Hp'};
const TABLE_NAMES = Object.keys(PRODUCTION_TABLES);
export const STAGING_BASE_ID = 'app5p1U9s53xlLs76';
export function stagingTableMapFromEnv(env=process.env){
 const raw=env.QP_AIRTABLE_STAGING_TABLE_IDS_JSON;
 if(!raw) {
  if(env.QP_AIRTABLE_STAGING==='1')throw new Error('Staging requires an explicit table ID map');
  return null;
 }
 if(env.QP_AIRTABLE_STAGING!=='1')throw new Error('Staging table map requires staging mode');
 if(env.QP_AIRTABLE_STAGING_BASE_ID!==STAGING_BASE_ID)throw new Error('Staging table map requires exact isolated base');
 let obj;try{obj=JSON.parse(raw)}catch{throw new Error('Invalid staging table map JSON')}
 if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).length!==TABLE_NAMES.length || TABLE_NAMES.some(name=>!Object.hasOwn(obj,name)||!/^tbl[A-Za-z0-9]{14}$/.test(obj[name])))throw new Error('Staging table map must contain eight valid table IDs');
 if(new Set(Object.values(obj)).size!==TABLE_NAMES.length)throw new Error('Staging table IDs must be unique');
 if(Object.values(obj).some(id=>Object.values(PRODUCTION_TABLES).includes(id)))throw new Error('Production table ID cannot be used in staging');
 return Object.freeze({...obj});
}
// Tables added by the 2026-11-27 build. They are NOT part of the original
// eight-table production map: a deployment creates them in its Airtable base
// and supplies their IDs via QP_AIRTABLE_EXTRA_TABLES_JSON. Until then the
// features that need them (self-serve accounts, upload metadata) stay off.
export const OPTIONAL_TABLES=['Accounts','Uploads'];
export function extraTableMapFromEnv(env=process.env){
 const raw=env.QP_AIRTABLE_EXTRA_TABLES_JSON;
 if(!raw)return null;
 let obj;try{obj=JSON.parse(raw)}catch{throw new Error('Invalid extra table map JSON')}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error('Invalid extra table map');
 for(const [name,id] of Object.entries(obj)){
  if(!OPTIONAL_TABLES.includes(name))throw new Error(`Unknown extra table: ${name}`);
  if(!/^tbl[A-Za-z0-9]{14}$/.test(id))throw new Error(`Invalid table ID for ${name}`);
  if(Object.values(PRODUCTION_TABLES).includes(id))throw new Error('Extra table ID cannot reuse a production table ID');
 }
 return Object.freeze({...obj});
}
function formulaLiteral(s){return JSON.stringify(String(s));}
export function scopedFormula(businessKey){return `{Business Key}=${formulaLiteral(businessKey)}`;}
export class AirtableRepo {
 constructor({token,baseId='appWNg4MRrQ2TViqi',tables=PRODUCTION_TABLES,fetchImpl=fetch}){if(!token)throw new Error('AIRTABLE_TOKEN required');if(!/^app[A-Za-z0-9]{14}$/.test(baseId))throw new Error('Invalid Airtable base ID');if(!tables||TABLE_NAMES.some(name=>!/^tbl[A-Za-z0-9]{14}$/.test(tables[name]||'')))throw new Error('Invalid Airtable table map');this.token=token;this.baseId=baseId;this.tables=tables;this.fetch=fetchImpl;}
 async request(table,method='GET',path='',params={},payload){const id=this.tables[table];if(!id)throw new HttpError(400,'Table not allowed');const url=new URL(`https://api.airtable.com/v0/${this.baseId}/${id}${path}`);for(const [k,v] of Object.entries(params))if(v!==undefined)url.searchParams.set(k,v);
  const init={method,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(12000)};
  if(payload)init.body=JSON.stringify(payload);
  let response;try{response=await this.fetch(url,init)}catch{throw new HttpError(503,'Database temporarily unavailable')}
  if(!response.ok){if(response.status===429)throw new HttpError(503,'Database rate limit reached');if(response.status===404)throw new HttpError(404,'Record not found');throw new HttpError(503,'Database request failed')}
  return response.json();
 }
 async list(table,businessKey){let cursor;const records=[];do{const res=await this.request(table,'GET','',{pageSize:'100',filterByFormula:scopedFormula(businessKey),...(cursor?{offset:cursor}:{})});for(const r of res.records||[])if(r.fields?.['Business Key']===businessKey)records.push(r);cursor=res.offset;if(records.length>1000)throw new HttpError(422,'Too many records for bounded pilot query')}while(cursor);return records;}
 async get(table,businessKey,id){if(!/^rec[A-Za-z0-9]{14}$/.test(id))throw new HttpError(404,'Record not found');const r=await this.request(table,'GET','/'+encodeURIComponent(id));if(r.fields?.['Business Key']!==businessKey)throw new HttpError(404,'Record not found');return r;}
 async create(table,businessKey,fields){const result=await this.request(table,'POST','',{}, {records:[{fields:{...fields,'Business Key':businessKey}}],typecast:false});if(!result.records?.[0])throw new HttpError(503,'Database did not confirm save');return result.records[0];}
 async update(table,businessKey,id,fields){await this.get(table,businessKey,id);const result=await this.request(table,'PATCH','',{}, {records:[{id,fields:{...fields,'Business Key':businessKey}}],typecast:false});if(!result.records?.[0])throw new HttpError(503,'Database did not confirm update');return result.records[0];}
 // Auth-directory lookup across the base (email / one-time tokens are global
 // login identifiers). Returns null when the Accounts table is not configured
 // in this deployment — the account features then stay off, fail-closed.
 async findAccount(field,value){if(!this.tables.Accounts)return null;if(!['Email','Verify Token Hash','Reset Token Hash'].includes(field))throw new HttpError(400,'Account lookup field not allowed');const res=await this.request('Accounts','GET','',{pageSize:'1',filterByFormula:`{${field}}=${formulaLiteral(value)}`});const r=(res.records||[])[0];return r&&r.fields?.[field]===value?r:null;}
}
