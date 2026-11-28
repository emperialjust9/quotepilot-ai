let user=null,csrf='',current='overview';
const state={leads:[],rules:[],estimates:[],followups:[],bookings:[]};
const $=s=>document.querySelector(s);
const text=(el,str)=>{el.textContent=String(str??'')};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n||0));
function notify(msg,ok=true){const el=$('#message');el.hidden=false;el.textContent=msg;el.style.borderColor=ok?'#81dcc3':'#f0a67e';}
async function api(path,{method='GET',body=null}={}){
  const res=await fetch(path,{method,credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  let data;try{data=await res.json()}catch{throw new Error('Unable to read server response')}
  if(!res.ok)throw new Error(data.error||`Request failed (${res.status})`);return data;
}
function renderTable(sel,rows,cols){const tb=$(sel);if(!rows.length){tb.innerHTML=`<tr><td colspan="${cols.length}" class="empty">No records found</td></tr>`;return;}tb.innerHTML=rows.map(x=>'<tr>'+cols.map(fn=>`<td>${esc(fn(x))}</td>`).join('')+'</tr>').join('');}
function nav(view){current=view;document.querySelectorAll('.view').forEach(x=>x.hidden=x.id!==view);document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===view));const info={overview:['Your business, in focus','Inquiries, estimates, and next steps—beautifully organized.'],leads:['Customer inquiries','Thoughtfully manage each inquiry before any customer outreach.'],estimates:['Estimates & pricing','Prepare accurate estimates using your approved pricing standards.'],bookings:['Booking requests','Track preferred dates while availability remains unconfirmed.'],followups:['Follow-up drafts','Prepare thoughtful replies for private review. Sending remains disabled.'],rules:['Pricing standards','Your business controls every price and its approval.']};text($('#pageTitle'),info[view][0]);text($('#pageDesc'),info[view][1]);text($('#breadcrumbCurrent'),view.toUpperCase());document.querySelectorAll('.nav').forEach(x=>x.setAttribute('aria-current',x.dataset.view===view?'page':'false'));$('#message').hidden=true;}
function render(){
  const metric=[
    ['Inquiries',state.leads.length,'i-users','Customer requests to review'],
    ['Estimate drafts',state.estimates.length,'i-file','Prepared for private review'],
    ['Booking requests',state.bookings.length,'i-calendar','Availability not confirmed'],
    ['Follow-up drafts',state.followups.length,'i-mail','Prepared, never sent']
  ];
  $('#metricCards').innerHTML=metric.map(([label,val,icon,sub],i)=>`<div class="metric metric-${i+1}"><div class="metric-head"><small>${esc(label)}</small><span class="metric-glyph"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg></span></div><div class="metric-number"><strong>${val}</strong><span class="metric-dot" aria-hidden="true"></span></div><div class="metric-tail"><span class="metric-rule"></span><span>${esc(sub)}</span></div></div>`).join('');
  $('#recentLeads').innerHTML=state.leads.slice(-5).reverse().map(x=>`<div class="gate"><b>${esc(x.fields['Customer Name'])}</b><span class="status">${esc(x.fields.Stage||'Review')}</span></div>`).join('')||'<p class="empty">No incoming leads</p>';
  renderTable('#leadsTable',state.leads,[x=>x.fields['Customer Name'],x=>x.fields.Service,x=>x.fields['Postal Code'],x=>x.fields['Requested Date']||'—',x=>x.fields.Stage,x=>x.fields['Consent To Follow Up']?'Yes':'No']);
  renderTable('#estTable',state.estimates,[x=>x.fields['Estimate Key'],x=>x.fields['Lead Key'],x=>money(x.fields['Estimated Total']),x=>x.fields['Rule Version'],x=>x.fields.Status,x=>x.fields['Response Draft']||'—']);
  renderTable('#bookingTable',state.bookings,[x=>x.fields['Booking Key'],x=>x.fields['Lead Key'],x=>x.fields['Booked Date'],x=>money(x.fields.Amount),x=>x.fields.Status,x=>x.fields['Source Verified']?'Provider record check required':(String(x.fields.Notes||'').startsWith('OWNER-ATTESTED')?'Owner note only':'No'),x=>'Provider availability NOT verified']);
  renderTable('#fuTable',state.followups,[x=>x.fields['Followup Key'],x=>x.fields['Lead Key'],x=>x.fields['Recipient Email'],x=>x.fields.Status,x=>x.fields['Consent Verified']?'Yes':'No']);
  renderTable('#ruleTable',state.rules,[x=>x.fields.Service,x=>money(x.fields['Base Price']),x=>money(x.fields['Per Bedroom']),x=>money(x.fields['Per Bathroom']),x=>money(x.fields['Per 1000 Sq Ft']),x=>money(x.fields['Minimum Price']),x=>x.fields.Approved?'Approved':'Review hold']);
  const lead=$('#estimateLead');lead.innerHTML=state.leads.map(x=>`<option value="${esc(x.id)}">${esc(x.fields['Customer Name'])} — ${esc(x.fields.Service)}</option>`).join('');
  updateRulesForSelectedLead();
  const review=$('#reviewEstimate');
  const keepReview=review.value;
  review.innerHTML=state.estimates.filter(x=>['Draft','Awaiting Approval'].includes(x.fields.Status)).map(x=>`<option value="${esc(x.id)}">${esc(x.fields['Estimate Key'])} · ${money(x.fields['Estimated Total'])} · ${esc(x.fields.Status)}</option>`).join('');
  if(state.estimates.some(x=>x.id===keepReview&&['Draft','Awaiting Approval'].includes(x.fields.Status)))review.value=keepReview;
  for(const id of ['bookingEstimate','followupEstimate']){$('#'+id).innerHTML=state.estimates.map(x=>`<option value="${esc(x.id)}">${esc(x.fields['Estimate Key'])} · ${money(x.fields['Estimated Total'])}</option>`).join('');}
  const previous=$('#editRuleSelect').value;
  $('#editRuleSelect').innerHTML='<option value="">New rule</option>'+state.rules.map(x=>`<option value="${esc(x.id)}">${esc(x.fields.Service)} · v${esc(x.fields.Version||1)} · ${x.fields.Approved?'approved':'review hold'}</option>`).join('');
  if(previous && state.rules.some(x=>x.id===previous))$('#editRuleSelect').value=previous;
  fillRuleEditor();
}
function updateRulesForSelectedLead(){const lead=state.leads.find(x=>x.id===$('#estimateLead').value);const sel=$('#estimateRule');sel.innerHTML=(lead?state.rules.filter(x=>x.fields.Service===lead.fields.Service):[]).map(x=>`<option value="${esc(x.id)}">${esc(x.fields['Rule Key'])} · ${esc(x.fields.Approved?'Approved':'Approval needed')}</option>`).join('');}
async function refresh(){const endpoints=[['leads','/api/leads'],['rules','/api/rules'],['estimates','/api/estimates'],['followups','/api/followups'],['bookings','/api/bookings']];const data=await Promise.all(endpoints.map(async([key,path])=>[key,(await api(path)).records]));for(const [key,rows]of data)state[key]=rows;render();}
async function restore(){
 let r;
 try { r=await api('/api/me'); }
 catch(err){user=null;csrf='';$('#login').hidden=false;$('#shell').hidden=true;text($('#loginErr'),err.message==='Authentication required'?'':(err.message||'Unable to restore your session'));return false;}
 user=r;csrf=r.csrf;
 const gates=r.gates||{};
 const setGate=(id,on)=>{const el=document.getElementById(id);if(el){el.textContent=on?'ENABLED':'DISABLED';el.classList.toggle('hold',!on);}};
 setGate('gateMessaging',gates.outbound);setGate('gateCheckout',gates.checkout);setGate('gateBooking',gates.automatedBookings);
 try{const svc=await api('/api/services');document.querySelectorAll('select.service-select').forEach(sel=>{const cur=sel.value;sel.innerHTML=svc.services.map(s=>`<option>${esc(s)}</option>`).join('');if(svc.services.includes(cur))sel.value=cur;});}catch{/* keep the built-in defaults */}
 $('#login').hidden=true;$('#shell').hidden=false;
 text($('#loginErr'),'');text($('#tenantName'),`${user.businessKey} · ${user.role}`);
 nav('overview');
 try{await refresh();}catch(err){notify(`Signed in successfully, but dashboard records could not load: ${err.message||'Unknown error'}`,false);}
 return true;
}
$('#loginForm').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const data=await api('/api/login',{method:'POST',body:{email:f.get('email'),password:f.get('password')}});csrf=data.csrf;await restore();}catch(err){text($('#loginErr'),err.message)}});
$('#logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'})}finally{csrf='';user=null;$('#shell').hidden=true;$('#login').hidden=false;$('#loginForm').reset()}});
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.view)));
$('#estimateLead').addEventListener('change',updateRulesForSelectedLead);
let leadSavePending=false;
$('#leadForm').addEventListener('submit',async(e)=>{
  e.preventDefault();
  if(leadSavePending)return;
  // DOM events clear currentTarget once this listener yields to an async request.
  const form=e.currentTarget;
  const submitButton=form.querySelector('button');
  leadSavePending=true;
  if(submitButton)submitButton.disabled=true;
  try{
    const f=new FormData(form),obj=Object.fromEntries(f.entries());
    obj.consent=f.has('consent');
    const result=await api('/api/leads',{method:'POST',body:obj});
    // Successful persistence must never be reported as a failed save.
    form.reset();
    try{await refresh();}
    catch(err){notify('Inquiry saved, but the dashboard did not refresh. Reload the page to see the saved inquiry.',false);return;}
    notify(result.duplicate?'Existing matching inquiry retained; no additional lead created.':'Inquiry saved for internal review; no customer message sent.');
  }catch(err){notify(err.message,false);}
  finally{leadSavePending=false;if(submitButton)submitButton.disabled=false;}
});
$('#estimateForm').addEventListener('submit',async(e)=>{e.preventDefault();try{const f=new FormData(e.currentTarget),r=await api('/api/estimate-preview',{method:'POST',body:Object.fromEntries(f.entries())});const est=r.estimate;$('#priceResult').innerHTML=`<div class="notice"><b>Internal price preview: ${money(est.total)}</b><p>Base ${money(est.base)} + bedrooms ${money(est.bedroomCharge)} + bathrooms ${money(est.bathroomCharge)} + area ${money(est.areaCharge)}; floor ${money(est.minimum)}; multiplier ${est.multiplier}. Rule approved: ${est.ruleApproved?'Yes':'NO'}.</p><small>This amount is not a customer quote or booking.</small></div>`;}catch(err){notify(err.message,false)}});
$('#saveEstimate').addEventListener('click',async()=>{try{const f=new FormData($('#estimateForm')),r=await api('/api/estimates',{method:'POST',body:Object.fromEntries(f.entries())});await refresh();notify(r.duplicate?'Existing estimate draft retained.':'Internal estimate draft created; no customer communication.');}catch(err){notify(err.message,false)}});
api('/api/public-info').then(info=>{$('#demoCredentials').hidden=info.mode!=='local demo'}).catch(()=>{});

function fillRuleEditor(){const r=state.rules.find(x=>x.id===$('#editRuleSelect').value);if(!r)return;const fields=r.fields;const form=$('#ruleForm');const map={service:'Service',base:'Base Price',perBedroom:'Per Bedroom',perBathroom:'Per Bathroom',per1000:'Per 1000 Sq Ft',minimum:'Minimum Price',flatAddon:'Flat Addon',multiplier:'Multiplier'};for(const [key,field] of Object.entries(map))form.elements.namedItem(key).value=fields[field]??(key==='multiplier'?1:0);}
$('#editRuleSelect').addEventListener('change',fillRuleEditor);
$('#ruleForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const body=Object.fromEntries(new FormData(form));const id=body.ruleId;delete body.ruleId;try{
 const result=await api(id?'/api/rules/'+encodeURIComponent(id)+'/update':'/api/rules',{method:'POST',body});await refresh();notify('Price rule saved. Owner approval is required before customer draft preparation.');}
 catch(err){notify(err.message,false)} });
$('#approveRule').addEventListener('click',async()=>{const id=$('#editRuleSelect').value;if(!id){notify('Select an existing rule to approve.',false);return;}if(!confirm('Approve this rule internally for this cleaning business? No customer messages are enabled.'))return;try{await api('/api/rules/'+encodeURIComponent(id)+'/approve',{method:'POST',body:{}});await refresh();notify('Tenant owner approved the rule internally. Quote sending remains disabled.');}catch(err){notify(err.message,false)}});
$('#bookingForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/bookings',{method:'POST',body:Object.fromEntries(new FormData(e.currentTarget))});await refresh();notify('Requested booking recorded. No availability or customer confirmation claimed.');}catch(err){notify(err.message,false)}});
$('#followupForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/followup-draft',{method:'POST',body:Object.fromEntries(new FormData(e.currentTarget))});await refresh();notify('Internal follow-up draft queued; nothing sent.');}catch(err){notify(err.message,false)}});

restore();

// Independent internal approval gate; never transmits customer content.
$('#approveEstimate').addEventListener('click',async()=>{
 const id=$('#reviewEstimate').value;
 if(!id){notify('No estimate currently awaiting review.',false);return}
 if(!confirm('Approve this estimate for INTERNAL review only? No customer message or booking will be issued.'))return;
 try{await api('/api/estimates/'+encodeURIComponent(id)+'/approve',{method:'POST',body:{}});await refresh();notify('Estimate approved internally. Customer messaging remains disabled.');}
 catch(err){notify(err.message,false)}
});
$('#rejectEstimate').addEventListener('click',async()=>{
 const id=$('#reviewEstimate').value;
 if(!id){notify('No estimate currently awaiting review.',false);return}
 const reason=prompt('Enter the internal rejection reason (5–500 characters):');
 if(reason===null)return;
 if(reason.trim().length<5||reason.trim().length>500){notify('A rejection reason of 5–500 characters is required.',false);return}
 try{await api('/api/estimates/'+encodeURIComponent(id)+'/reject',{method:'POST',body:{reason:reason.trim()}});await refresh();notify('Estimate rejected and retained in the audit register; nothing sent.');}
 catch(err){notify(err.message,false)}
});
