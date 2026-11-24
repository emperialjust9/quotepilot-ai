// Shared-state HTTP contract. Caller supplies a protected, persistent coordinator endpoint.
// There is no automatically provisioned provider and no production connection in this patch.
import {HttpError} from '../lib/validators.mjs';
export class SharedStateHttpClient {
 constructor({url,token,fetchImpl=fetch}){
  if(!url||!token||token.length<32)throw new Error('Shared-state URL and strong token required');
  this.base=url.replace(/\/$/,'');this.token=token;this.fetch=fetchImpl;
 }
 async action(path,data){
  let response;
  try{response=await this.fetch(this.base+path,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});}
  catch{throw new HttpError(503,'Shared security service unavailable');}
  if(!response.ok)throw new HttpError(503,'Shared security service unavailable');
  let result;try{result=await response.json();}catch{throw new HttpError(503,'Invalid shared security response');}
  if(!result||typeof result!=='object')throw new HttpError(503,'Invalid shared security response');return result;
 }
 async checkRateLimit(key,max,periodMs){
  const r=await this.action('/v1/rates/check',{key,max,periodMs});
  if(typeof r.allowed!=='boolean')throw new HttpError(503,'Invalid shared rate limit response');
  return {allowed:r.allowed};
 }
 async isRevoked(hash){const r=await this.action('/v1/revocations/check',{key:hash});if(typeof r.revoked!=='boolean')throw new HttpError(503,'Invalid shared security response');return r.revoked;}
 async revoke(hash,expires){const r=await this.action('/v1/revocations/add',{key:hash,expires});if(r.ok!==true)throw new HttpError(503,'Invalid shared security response');}
 async claim(hash){const r=await this.action('/v1/intents/claim',{key:hash});if(r.state==='claimed'&&/^[a-f0-9]{48}$/.test(r.ownerToken))return r;if(r.state==='done'&&typeof r.recordId==='string')return r;if(r.state==='pending')return r;throw new HttpError(503,'Invalid shared security response');}
 async complete(hash,token,recordId){const r=await this.action('/v1/intents/complete',{key:hash,ownerToken:token,recordId});if(r.ok!==true)throw new HttpError(503,'Invalid shared security response');}
}
