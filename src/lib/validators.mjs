export class HttpError extends Error { constructor(status, message) {super(message); this.status=status;} }
export function requiredString(input, field, max=120) {
  if (typeof input !== 'string') throw new HttpError(400, `${field} must be text`);
  const s=input.trim(); if (!s || s.length>max) throw new HttpError(400, `${field} must have 1-${max} characters`);
  return s;
}
export function optionalString(input, field, max=500) {
  if (input===undefined || input===null || input==='') return '';
  if (typeof input!=='string' || input.length>max) throw new HttpError(400, `${field} is invalid`);
  return input.trim();
}
export function optionalEmail(input) {
  if (!input) return '';
  const email=requiredString(input,'Email',254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400,'Email is invalid');
  return email;
}
export function quantity(v,name,min,max) {
  const n=Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n<min || n>max) throw new HttpError(400,`${name} must be an integer ${min}-${max}`);
  return n;
}
export function area(v){return quantity(v,'Square Feet',100,20000);}
export function postal(v){const s=requiredString(v,'ZIP',10);if(!/^\d{5}(?:-\d{4})?$/.test(s))throw new HttpError(400,'ZIP must be a valid US ZIP code');return s;}
export function isoDate(v){const s=requiredString(v,'Date',10);if (!/^\d{4}-\d{2}-\d{2}$/.test(s)||Number.isNaN(Date.parse(s+'T12:00:00Z')) || new Date(s+'T12:00:00Z').toISOString().slice(0,10)!==s)throw new HttpError(400,'Date must be YYYY-MM-DD');return s;}
export function bool(v){return v===true;}
export function leadInput(input) {
  const obj=input&&typeof input==='object'?input:{};
  const name=requiredString(obj.name,'Customer name',120);
  const email=optionalEmail(obj.email);
  const phone=optionalString(obj.phone,'Phone',35);
  if (!email&&!phone) throw new HttpError(400,'Provide email or phone');
  const service=requiredString(obj.service,'Service',80);
  if (!['Standard Clean','Deep Clean','Move-In/Out'].includes(service)) throw new HttpError(400,'Unsupported service');
  return {
    'Customer Name':name,'Customer Email':email,'Customer Phone':phone,'Service':service,
    'Bedrooms':quantity(obj.bedrooms,'Bedrooms',0,30),'Bathrooms':quantity(obj.bathrooms,'Bathrooms',0,30),
    'Square Feet':area(obj.squareFeet),'Postal Code':postal(obj.postal),
    'Frequency':['Once','Weekly','Biweekly','Monthly'].includes(obj.frequency)?obj.frequency:'Once',
    'Requested Date':obj.requestedDate?isoDate(obj.requestedDate):undefined,
    'Notes':optionalString(obj.notes,'Notes',1000),'Consent To Follow Up':bool(obj.consent),
    'Opted Out':false,'Stage':'Needs Review','Lead Source':'Website'
  };
}

export function safeCurrency(v,field,max=10000){const n=Number(v);if(typeof v==='boolean'||!Number.isFinite(n)||n<0||n>max||!/^\d+(?:\.\d{1,2})?$/.test(String(v)))throw new HttpError(400,`${field} must be a nonnegative monetary amount (max ${max})`);return n;}
export function pricingInput(input){const obj=input&&typeof input==='object'?input:{};const service=requiredString(obj.service,'Service',80);if(!['Standard Clean','Deep Clean','Move-In/Out'].includes(service))throw new HttpError(400,'Unsupported pricing service');const multiplier=Number(obj.multiplier||1);if(!Number.isFinite(multiplier)||multiplier<0.25||multiplier>5)throw new HttpError(400,'Multiplier must be 0.25-5');return {'Service':service,'Base Price':safeCurrency(obj.base,'Base'),'Per Bedroom':safeCurrency(obj.perBedroom,'Bedroom rate'),'Per Bathroom':safeCurrency(obj.perBathroom,'Bathroom rate'),'Per 1000 Sq Ft':safeCurrency(obj.per1000,'Area rate'),'Minimum Price':safeCurrency(obj.minimum,'Minimum'),'Flat Addon':safeCurrency(obj.flatAddon??0,'Addon'),'Multiplier':multiplier};}
