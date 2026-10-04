const modal=document.getElementById('requestModal');
const form=document.getElementById('visitorForm');
const message=document.getElementById('requestMessage');
document.getElementById('startRequest').addEventListener('click',()=>{if(!document.getElementById('requestSuccess').hidden){form.reset();form.hidden=false;document.querySelector('.privacy-note').hidden=false;document.getElementById('requestSuccess').hidden=true;}modal.hidden=false;document.getElementById('visitorName').focus();});
function closeModal(){modal.hidden=true;}
document.getElementById('closeRequest').addEventListener('click',closeModal);
document.getElementById('doneRequest').addEventListener('click',closeModal);
modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!modal.hidden)closeModal();});
form.addEventListener('submit',async e=>{
  e.preventDefault();message.textContent='Sending your request…';
  const data=Object.fromEntries(new FormData(form));
  try{
    const response=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not send your request.');
    document.getElementById('requestReference').textContent=result.reference;
    form.hidden=true;document.querySelector('.privacy-note').hidden=true;document.getElementById('requestSuccess').hidden=false;message.textContent='';
  }catch(err){message.textContent=err.message==='Failed to fetch'?'The visitor service is unavailable. Please try again later.':err.message;}
});
