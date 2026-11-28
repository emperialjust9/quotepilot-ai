// QuotePilot account pages: signup, email verification, password reset.
const statusEl=document.querySelector('#status');
function show(msg){if(statusEl){statusEl.hidden=false;statusEl.textContent=msg;}}
async function post(path,body){
  const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let data={};try{data=await res.json();}catch{/* non-JSON error */}
  if(!res.ok)throw new Error(data.error||`Request failed (${res.status})`);
  return data;
}
const params=new URLSearchParams(location.search);
const signupForm=document.querySelector('#signupForm');
if(signupForm){
  signupForm.addEventListener('submit',async(e)=>{
    e.preventDefault();
    const f=new FormData(signupForm);
    try{
      await post('/api/signup',{companyName:f.get('companyName'),email:f.get('email'),password:f.get('password'),serviceZips:f.get('serviceZips')||''});
      show('Workspace created. Check your email for the verification link — you can sign in as soon as it is confirmed.');
      signupForm.reset();
    }catch(err){show(err.message);}
  });
}
if(location.pathname==='/verify-email'){
  const token=params.get('token')||'';
  if(!token){show('This verification link is incomplete.');}
  else{
    post('/api/verify-email',{token})
      .then(()=>show('Email verified. You can now sign in to your workspace.'))
      .catch((err)=>show(err.message));
  }
}
const resetForm=document.querySelector('#resetForm');
if(resetForm){
  resetForm.addEventListener('submit',async(e)=>{
    e.preventDefault();
    const token=params.get('token')||'';
    if(!token){show('This reset link is incomplete.');return;}
    const f=new FormData(resetForm);
    try{
      await post('/api/password-reset/confirm',{token,newPassword:f.get('newPassword')});
      show('Password updated. Sign in with your new password.');
      resetForm.reset();
    }catch(err){show(err.message);}
  });
}
