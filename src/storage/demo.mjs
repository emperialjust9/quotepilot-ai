import { randomUUID } from 'node:crypto';
import {HttpError} from '../lib/validators.mjs';
export const DEMO_DATA = {
  Businesses:[
    {'Business Key':'DEMO-001','Company Name':'Evergreen Cleaning (FICTIONAL DEMO)','Plan':'Trial','Status':'Demo','Service ZIPs':'11214,11223','Time Zone':'America/New_York'},
    {'Business Key':'DEMO-002','Company Name':'Brooklyn Sample Co (FICTIONAL)','Plan':'Trial','Status':'Demo','Service ZIPs':'11211','Time Zone':'America/New_York'}
  ],
  'Pricing Rules':[
    {'Business Key':'DEMO-001','Rule Key':'DEMO-STD-v1','Service':'Standard Clean','Base Price':110,'Per Bedroom':20,'Per Bathroom':25,'Per 1000 Sq Ft':10,'Minimum Price':130,'Flat Addon':0,Multiplier:1,Version:1,Approved:false},
    {'Business Key':'DEMO-001','Rule Key':'DEMO-DEEP-v1','Service':'Deep Clean','Base Price':180,'Per Bedroom':25,'Per Bathroom':35,'Per 1000 Sq Ft':15,'Minimum Price':220,'Flat Addon':0,Multiplier:1,Version:1,Approved:false},
    {'Business Key':'DEMO-002','Rule Key':'SECOND-STD','Service':'Standard Clean','Base Price':140,'Per Bedroom':25,'Per Bathroom':35,'Per 1000 Sq Ft':12,'Minimum Price':175,'Flat Addon':0,Multiplier:1,Version:1,Approved:false}
  ],
  Leads:[{'Business Key':'DEMO-001','Lead Key':'DEMO-LEAD-001','Customer Name':'Demo Client A','Customer Email':'fake-a@example.invalid','Service':'Deep Clean','Bedrooms':3,'Bathrooms':2,'Square Feet':1600,'Postal Code':'11214','Frequency':'Once','Stage':'Needs Review','Consent To Follow Up':false,'Opted Out':false,'Lead Source':'Website','Dedup Key':'demolead'}],
  Estimates:[{'Business Key':'DEMO-001','Estimate Key':'DEMO-EST-001','Lead Key':'DEMO-LEAD-001','Pricing Rule Key':'DEMO-DEEP-v1','Rule Version':1,'Base':180,'Bedroom Charge':75,'Bathroom Charge':70,'Area Charge':24,'Addon Charge':0,'Multiplier':1,'Minimum':220,'Estimated Total':349,'Status':'Awaiting Approval','Response Draft':'SAMPLE ONLY, NOT SENT','Assumptions':'Fictional, unapproved price rules'}],
  'Follow Ups':[],Bookings:[],Subscriptions:[{'Business Key':'DEMO-001','Subscription Key':'DEMO-SUB-001','Plan':'Growth','Amount Monthly':119,'State':'Not Connected'}],
  'Operations & QA':[],
  // Self-serve account directory + upload metadata (added 2026-11-27 build).
  Accounts:[],Uploads:[]
};
export class DemoRepo {
  constructor(seed=DEMO_DATA){this.tables={}; for(const [name,arr] of Object.entries(seed))this.tables[name]=arr.map((fields,i)=>({id:`demo_${name.replace(/\W/g,'')}_${i}`,fields:{...fields}}));}
  async list(table,businessKey){return (this.tables[table]||[]).filter(r=>r.fields['Business Key']===businessKey).map(r=>structuredClone(r));}
  async get(table,businessKey,id){const r=(this.tables[table]||[]).find(r=>r.id===id && r.fields['Business Key']===businessKey);if(!r)throw new HttpError(404,'Record not found');return structuredClone(r);}
  async create(table,businessKey,fields){if(!this.tables[table])throw new HttpError(400,'Table not allowed');const r={id:'demo_'+randomUUID(),fields:{...fields,'Business Key':businessKey}};this.tables[table].push(r);return structuredClone(r);}
  async update(table,businessKey,id,fields){const r=(this.tables[table]||[]).find(r=>r.id===id&&r.fields['Business Key']===businessKey);if(!r)throw new HttpError(404,'Record not found');Object.assign(r.fields,fields);r.fields['Business Key']=businessKey;return structuredClone(r);}
  // Auth-directory lookup: email and one-time tokens are global login
  // identifiers (like the configured user list), so this search is
  // deliberately NOT tenant-scoped. Field names are whitelisted by the caller.
  async findAccount(field,value){const r=(this.tables.Accounts||[]).find(r=>r.fields[field]===value);return r?structuredClone(r):null;}
}
