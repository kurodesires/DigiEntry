const form=document.getElementById('createAccountForm');
const message=document.getElementById('createAccountMessage');
form.addEventListener('submit',async event=>{
  event.preventDefault();message.textContent='Creating account…';
  const response=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
  const result=await response.json().catch(()=>({error:'The account service is unavailable.'}));
  if(!response.ok){message.textContent=result.error||'Could not create account.';return;}
  form.hidden=true;document.querySelector('.create-account-prompt').hidden=true;document.querySelector('.back-link').hidden=true;document.getElementById('createAccountSuccess').hidden=false;message.textContent='';
});

