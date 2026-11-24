const token=location.pathname.split('/').pop();
const form=document.querySelector('#intakeForm');const status=document.querySelector('#status');
form.addEventListener('submit',async e=>{
 e.preventDefault();const data=Object.fromEntries(new FormData(form));data.consent=new FormData(form).has('consent');
 try{const res=await fetch('/api/intake/'+encodeURIComponent(token),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});let json=await res.json();if(!res.ok)throw new Error(json.error||'Submission unavailable');status.textContent='Your request was received for internal review. A booking or final price has NOT been confirmed.';status.hidden=false;form.reset();}
 catch(err){status.textContent=err.message;status.hidden=false;}
});
