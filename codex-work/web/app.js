const $=selector=>document.querySelector(selector),form=$('#query-form'),question=$('#question'),result=$('#result'),pipeline=$('#pipeline');
const state={step:0};
document.documentElement.dataset.theme=localStorage.getItem('theme')||'dark';
$('#theme').onclick=()=>{const next=document.documentElement.dataset.theme==='light'?'dark':'light';document.documentElement.dataset.theme=next;localStorage.setItem('theme',next)};
document.querySelectorAll('[data-q]').forEach(button=>button.onclick=()=>{question.value=button.dataset.q;form.requestSubmit()});

function addStep(title,detail=''){
  state.step+=1;document.querySelectorAll('.pipeline-item.active').forEach(node=>{node.classList.remove('active');node.classList.add('done')});
  const row=document.createElement('div');row.className='pipeline-item active';
  const icon=document.createElement('span');icon.className='step-icon';icon.textContent=state.step;
  const copy=document.createElement('div'),heading=document.createElement('strong'),body=document.createElement('small');
  heading.textContent=title;body.textContent=detail;copy.append(heading,body);row.append(icon,copy);pipeline.append(row);row.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function finish(data){
  document.querySelectorAll('.pipeline-item.active').forEach(node=>{node.classList.remove('active');node.classList.add('done')});
  $('#answer-card').hidden=false;$('#status').className=data.sufficient?'supported':'abstained';$('#status').innerHTML=`<i></i> ${data.sufficient?'Verified answer':'Evidence insufficient'}`;$('#date').textContent=data.as_of?`Evidence as of ${data.as_of}`:'';$('#answer').textContent=data.answer;$('#reasoning').textContent=data.reasoning;$('#usage').textContent=JSON.stringify(data.usage,null,2);$('#sources').innerHTML='';
  data.sources.forEach(source=>{const li=document.createElement('li'),a=document.createElement('a'),meta=document.createElement('span');a.href=source.url;a.target='_blank';a.rel='noopener';a.textContent=source.title;meta.textContent=`${source.provenance.replaceAll('_',' ')} · ${source.date} · ${source.content_sha256.slice(0,10)}`;li.append(a,meta);$('#sources').append(li)});
  $('#source-count').textContent=`${data.sources.length} source${data.sources.length===1?'':'s'}`;
  if(data.audit){$('#audit').hidden=false;$('#audit').href=data.audit.verify_url;$('#audit-hash').textContent=`${data.audit.record_hash.slice(0,20)}…`;}
  $('#submit').disabled=false;$('#submit span').textContent='Run evidence agent';
}
function onEvent(type,data){
  if(type==='thinking')addStep('Planning',data.message);
  if(type==='tool_call')addStep(`Calling ${data.tool}`,Object.entries(data.arguments||{}).map(([key,value])=>`${key}: ${typeof value==='object'?JSON.stringify(value):value}`).join(' · '));
  if(type==='tool_result'){const count=(data.evidence||[]).length;addStep(`${data.tool} returned`,data.error||`${count} evidence item${count===1?'':'s'} captured and hashed`);}
  if(type==='verification')addStep('Verification',data.message);
  if(type==='answer')finish(data);
  if(type==='error')throw new Error(data.error||'Request failed');
}
form.onsubmit=async event=>{
  event.preventDefault();state.step=0;result.hidden=false;pipeline.innerHTML='';$('#answer-card').hidden=true;$('#audit').hidden=true;$('#status').className='working';$('#status').innerHTML='<i></i> Agent running';$('#date').textContent='';$('#submit').disabled=true;$('#submit span').textContent='Working…';result.scrollIntoView({block:'start',behavior:'smooth'});
  try{
    const response=await fetch('/api/query/stream',{method:'POST',headers:{'content-type':'application/json','accept':'text/event-stream'},body:JSON.stringify({question:question.value,mode:$('#mode').value})});
    if(!response.ok)throw new Error(`Request failed (${response.status})`);
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const type=(block.match(/^event: (.+)$/m)||[])[1];const raw=(block.match(/^data: (.+)$/m)||[])[1];if(type&&raw)onEvent(type,JSON.parse(raw));}}
  }catch(error){addStep('Request failed',error.message);$('#status').className='error';$('#status').innerHTML='<i></i> Error';$('#answer-card').hidden=false;$('#answer').textContent='The agent could not complete this request. Please try again.';$('#submit').disabled=false;$('#submit span').textContent='Try again';}
};
