import { HttpError } from './validators.mjs';
export function cents(value,label='Amount') {
  if (typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000000)throw new HttpError(422,`${label} invalid`);
  return Math.round(value*100);
}
export function computeEstimate(rule, lead){
  if (!rule || !lead) throw new HttpError(422,'Pricing rule or lead missing');
  const inputs={bedrooms:Number(lead['Bedrooms']),bathrooms:Number(lead['Bathrooms']),sqft:Number(lead['Square Feet'])};
  if (!Number.isInteger(inputs.bedrooms)||inputs.bedrooms<0||inputs.bedrooms>30||!Number.isInteger(inputs.bathrooms)||inputs.bathrooms<0||inputs.bathrooms>30||!Number.isFinite(inputs.sqft)||inputs.sqft<100||inputs.sqft>20000)throw new HttpError(422,'Lead inputs outside approved bounds');
  const base=cents(rule['Base Price']||0,'Base');
  const bedrooms=cents(rule['Per Bedroom']||0,'Bedroom rate')*inputs.bedrooms;
  const bathrooms=cents(rule['Per Bathroom']||0,'Bathroom rate')*inputs.bathrooms;
  const area=Math.round(cents(rule['Per 1000 Sq Ft']||0,'Area rate')*inputs.sqft/1000);
  const addon=cents(rule['Flat Addon']||0,'Addon');
  const multiplier=rule.Multiplier===undefined?1:Number(rule.Multiplier);
  if(!Number.isFinite(multiplier)||multiplier<0.25||multiplier>5)throw new HttpError(422,'Multiplier outside safe bounds');
  const minimum=cents(rule['Minimum Price']||0,'Minimum');
  const subtotal=base+bedrooms+bathrooms+area+addon;
  const total=Math.max(minimum,Math.round(subtotal*multiplier));
  if(total>200000000) throw new HttpError(422,'Estimate outside allowed upper bound');
  const cash=n=>n/100;
  return {base:cash(base),bedroomCharge:cash(bedrooms),bathroomCharge:cash(bathrooms),areaCharge:cash(area),addonCharge:cash(addon),multiplier,minimum:cash(minimum),subtotal:cash(subtotal),total:cash(total),ruleVersion:Number(rule.Version||1),ruleApproved:rule.Approved===true,canSend:false};
}
