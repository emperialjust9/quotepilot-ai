// QuotePilot-only database provider — server runtime, not browser code.
// Refuse incorrect database, role, host, or transport to prevent cross-product access.
import {PostgresSharedState} from './postgres.mjs';
export function validateNeonConnectionString(value){
 if(typeof value!=='string'||!value)throw new Error('QuotePilot security database connection required');
 let u;try{u=new URL(value)}catch{throw new Error('Invalid QuotePilot security database connection')}
 if(!['postgresql:','postgres:'].includes(u.protocol) || !u.username || !u.password || !u.hostname.endsWith('.neon.tech') ||
    u.hostname=== '.neon.tech' || decodeURIComponent(u.username)!=='quotepilot_security_app' ||
    decodeURIComponent(u.pathname)!=='/quotepilot_security' || u.searchParams.get('sslmode')!=='require'){
  throw new Error('QuotePilot security database target/role/TLS mismatch');
 }
 return value;
}
export async function createNeonSharedState({connectionString,driverLoader=()=>import('@neondatabase/serverless')}={}){
 const safeUrl=validateNeonConnectionString(connectionString);
 const mod=await driverLoader();if(typeof mod?.neon!=='function')throw new Error('Neon SQL driver unavailable');
 const sql=mod.neon(safeUrl);
 if(typeof sql?.query!=='function')throw new Error('Neon SQL query API unavailable');
 const state=new PostgresSharedState({query: (text,params)=>sql.query(text,params)});
 // Self-test must use an opaque nonexistent key, no mutation; a failed check blocks sign-in.
 await state.isRevoked('0'.repeat(64));
 return state;
}
