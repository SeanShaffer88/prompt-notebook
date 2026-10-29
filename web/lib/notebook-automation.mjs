import {id,now,text,requireValue,variables,versionFor,cleanChecks} from './notebook-core.mjs';
import {workflowPlan} from './notebook-enhancements.mjs';
export function automationService(state,{enhancements,preflight,defaultModel}){
 state.autoSettings ||= {enabled:false,paused:false,debounceSeconds:10,maxPerHour:2};
 for(const name of ['changeEvents','autoJobs','regressionAlerts','workflowMutes','monitorChecks','workflowBaselines'])state[name] ||= [];
 const config=()=>JSON.stringify({prompts:state.prompts.map(p=>[p.id,p.activeVersionId]),versions:state.versions,workflows:state.workflows,models:state.settings,experiments:state.experiments.map(e=>[e.id,e.winnerVersionId])});
 function observe(before,path){if(config()===before.signature)return;
  const old=JSON.parse(before.signature),changedPrompts=state.prompts.filter(p=>!old.prompts.some(([pid,vid])=>pid===p.id&&vid===p.activeVersionId)).map(p=>p.id),newVersions=state.versions.filter(v=>!old.versions.some(o=>o.id===v.id));
  for(const v of newVersions)if(!changedPrompts.includes(v.promptId))changedPrompts.push(v.promptId);
  const changedWorkflows=state.workflows.filter(w=>JSON.stringify(old.workflows.find(o=>o.id===w.id))!==JSON.stringify(w)).map(w=>w.id),modelsChanged=JSON.stringify(old.models)!==JSON.stringify(state.settings);
  const winnerChanged=state.experiments.filter(e=>!old.experiments.some(([eid,vid])=>eid===e.id&&vid===e.winnerVersionId)&&e.winnerVersionId);
  for(const e of winnerChanged)if(!changedPrompts.includes(e.promptId))changedPrompts.push(e.promptId);
  const affected=state.workflows.filter(w=>modelsChanged||changedWorkflows.includes(w.id)||w.promptIds.some(pid=>changedPrompts.includes(pid)));
  state.changeEvents.push({id:id(),path,createdAt:now(),promptIds:changedPrompts,workflowIds:affected.map(w=>w.id),kind:modelsChanged?'model-settings':newVersions.length?'prompt-version':changedWorkflows.length?'workflow':'active-version-or-winner'});
  if(state.changeEvents.length>200)state.changeEvents.shift();
  if(!state.autoSettings.enabled||path==='/api/bundle/import'||path.startsWith('/api/repairs/')&&!path.endsWith('/activate')&&!path.endsWith('/rollback'))return;
  for(const w of affected){
   const added=newVersions.slice().reverse().find(v=>w.promptIds.includes(v.promptId)&&state.prompts.find(p=>p.id===v.promptId)?.activeVersionId!==v.id),winner=winnerChanged.slice().reverse().find(e=>w.promptIds.includes(e.promptId));
   let target=added?{promptId:added.promptId,versionId:added.id}:winner?{promptId:winner.promptId,versionId:winner.winnerVersionId}:null;
   let job=state.autoJobs.find(j=>j.workflowId===w.id&&['queued','blocked'].includes(j.status));
   if(!target&&job?.target&&state.prompts.find(p=>p.id===job.target.promptId)?.activeVersionId!==job.target.versionId)target=job.target;
   if(target&&state.prompts.find(p=>p.id===target.promptId)?.activeVersionId===target.versionId)target=null;
   if(!job){job={id:id(),workflowId:w.id,status:'queued',createdAt:now(),changeCount:0};state.autoJobs.push(job);}
   Object.assign(job,{target,status:'queued',dueAt:new Date(Date.now()+state.autoSettings.debounceSeconds*1000).toISOString(),updatedAt:now(),changeCount:job.changeCount+1,lastChange:path,error:null});
  }
 }
 const begin=()=>({signature:config()});
 function alertFor(job,check){const bad=check.flags.filter(f=>['regression','failure','inconclusive'].includes(f.kind));if(!bad.length)return;state.regressionAlerts.push({id:id(),workflowId:job.workflowId,jobId:job.id,checkId:check.id,monitor:Boolean(check.monitor),kind:bad.some(f=>f.kind==='regression')?'regression':'check-failed',messages:bad.map(f=>f.message),createdAt:now(),readAt:null,acknowledgedAt:null});}
 function currentPlan(w){return {workflow:structuredClone(w),versions:w.promptIds.map(pid=>{const v=versionFor(state,pid);return {...v,provider:v.provider || 'anthropic',model:v.model || defaultModel(v.provider || 'anthropic')};})};}
 function prepare(w,target){const input=text(w.testInput || state.workflowChecks.slice().reverse().find(c=>c.workflowId===w.id)?.input || state.monitorChecks.slice().reverse().find(c=>c.workflowId===w.id)?.input || state.workflowRuns.slice().reverse().find(r=>r.workflowId===w.id)?.input,'Reusable input for '+w.title,30000);
  if(target){const plan=workflowPlan(state,{promptId:target.promptId,winnerVersionId:target.versionId},w,defaultModel),candidate=plan.versions.map(v=>v.promptId===target.promptId?plan.winner:v);return {input,plan,baseline:plan.versions,candidate};}
  const plan=currentPlan(w),baselineRef=state.workflowBaselines.find(b=>b.workflowId===w.id),baselineCheck=state.monitorChecks.find(c=>c.id===baselineRef?.monitorCheckId);return {input,plan,baseline:baselineCheck?.versionSnapshots || plan.versions,candidate:plan.versions,baselineCheck};
 }
 function preflightPlan(prepared){[...prepared.baseline,...prepared.candidate].forEach(v=>requireValue(variables(v.template).length===1,'Automatic workflow steps need one input variable.'));preflight([...prepared.baseline,...prepared.candidate]);const estimate=JSON.stringify(state).length+JSON.stringify(prepared.plan).length+[...prepared.baseline,...prepared.candidate].reduce((n,v)=>n+v.maxTokens*48+prepared.input.length+6000,0);requireValue(estimate<=700000,'Automatic check would exceed workspace storage. Export your notebook.',413);}
 async function run(w,target,prepared){
  const check={id:id(),experimentId:null,promptId:target?.promptId || w.promptIds[0],workflowId:w.id,winnerVersionId:target?.versionId || prepared.candidate[0].id,baselineVersionId:prepared.baseline.find(v=>v.promptId===(target?.promptId || w.promptIds[0])).id,input:prepared.input,plan:prepared.plan,signature:JSON.stringify(prepared.plan),createdAt:now(),status:'running',branches:{baseline:{steps:[],status:'running'},candidate:{steps:[],status:'running'}},flags:[],autoTarget:Boolean(target),monitor:!target};
  (target?state.workflowChecks:state.monitorChecks).push(check);
  await enhancements.compareWorkflow(check,prepared.baseline,prepared.candidate);
  if(!target){check.versionSnapshots=structuredClone(prepared.candidate);check.baselineCheckId=prepared.baselineCheck?.id || null;
   if(!prepared.baselineCheck){check.flags=check.flags.filter(f=>f.kind!=='review');check.flags.push({kind:'no-baseline',message:'No accepted passing snapshot exists yet. Review this check before establishing a baseline.'});if(check.status==='no-automatic-regressions')check.status='needs-review';}
   else if(check.status==='no-automatic-regressions'){let ref=state.workflowBaselines.find(b=>b.workflowId===w.id);Object.assign(ref,{monitorCheckId:check.id,updatedAt:now()});}
  }return check;
 }
 async function route(method,path,body){
  if(method==='GET'&&path==='/api/auto/status'){const attempts=(state.repairCases || []).flatMap(r=>r.attempts);return {settings:state.autoSettings,jobs:state.autoJobs.filter(j=>['queued','blocked'].includes(j.status)).map(j=>({id:j.id,status:j.status,dueAt:j.dueAt})),recentStarts:state.autoJobs.filter(j=>j.startedAt&&Date.now()-Date.parse(j.startedAt)<3600000).map(j=>j.startedAt),repairs:{settings:state.repairSettings,pendingSuggestions:(state.repairCases || []).filter(r=>r.status==='queued-suggestion').length,pendingTests:(state.repairCases || []).filter(r=>r.status==='queued-tests').length,recentSuggestions:attempts.filter(a=>a.type==='suggest'&&Date.now()-Date.parse(a.startedAt)<3600000).map(a=>a.startedAt),recentTests:attempts.filter(a=>a.type==='test'&&Date.now()-Date.parse(a.startedAt)<3600000).map(a=>a.startedAt)},revision:[state.changeEvents.at(-1)?.id,state.autoJobs.at(-1)?.updatedAt,state.regressionAlerts.at(-1)?.id].join(':')};}
  if(method==='POST'&&path==='/api/auto/settings'){
   const next={...state.autoSettings,...body};for(const key of ['enabled','paused'])requireValue(typeof next[key]==='boolean','Invalid automatic check setting.');requireValue(Number.isInteger(next.debounceSeconds)&&next.debounceSeconds>=0&&next.debounceSeconds<=300,'Debounce must be 0–300 seconds.');requireValue(Number.isInteger(next.maxPerHour)&&next.maxPerHour>=1&&next.maxPerHour<=20,'Hourly cap must be 1–20 checks.');state.autoSettings={enabled:next.enabled,paused:next.paused,debounceSeconds:next.debounceSeconds,maxPerHour:next.maxPerHour};return state.autoSettings;
  }
  const mute=path.match(/^\/api\/auto\/workflows\/([^/]+)\/mute$/);
  if(method==='POST'&&mute){requireValue(state.workflows.some(w=>w.id===mute[1]),'Workflow not found.',404);requireValue(body.hours===null||Number.isInteger(body.hours)&&body.hours>=1&&body.hours<=168,'Mute for 1–168 hours or clear with null.');let entry=state.workflowMutes.find(m=>m.workflowId===mute[1]);if(!entry){entry={id:id(),workflowId:mute[1]};state.workflowMutes.push(entry);}entry.until=body.hours===null?null:new Date(Date.now()+body.hours*3600000).toISOString();return entry;}
  const alert=path.match(/^\/api\/auto\/alerts\/([^/]+)\/(read|acknowledge)$/);
  if(method==='POST'&&alert){const a=state.regressionAlerts.find(a=>a.id===alert[1]);requireValue(a,'Alert not found.',404);a.readAt=now();if(alert[2]==='acknowledge'){a.acknowledgedAt=now();a.acknowledgment=body.notes?text(body.notes,'Acknowledgment',3000):'';}return a;}
  if(method==='POST'&&path==='/api/auto/retry-blocked'){for(const j of state.autoJobs)if(j.status==='blocked'){j.status='queued';j.dueAt=now();}return {ok:true};}
  const compare=path.match(/^\/api\/auto\/workflows\/([^/]+)\/compare-good$/);
  if(method==='POST'&&compare){const w=state.workflows.find(w=>w.id===compare[1]);requireValue(w,'Workflow not found.',404);const plan=prepare(w,null);preflightPlan(plan);return run(w,null,plan);}
  const accept=path.match(/^\/api\/auto\/monitor\/([^/]+)\/accept-baseline$/);
  if(method==='POST'&&accept){const c=state.monitorChecks.find(c=>c.id===accept[1]);requireValue(c&&c.branches.baseline.status==='complete'&&c.branches.candidate.status==='complete','Completed monitor check not found.',404);requireValue(!c.flags.some(f=>['regression','failure','inconclusive','sample'].includes(f.kind)),'Failing or simulated checks cannot become passing baselines.',422);const reason=text(body.reason,'Baseline review reason',3000);c.baselineAccepted={reason,createdAt:now()};let ref=state.workflowBaselines.find(b=>b.workflowId===c.workflowId);if(!ref){ref={id:id(),workflowId:c.workflowId};state.workflowBaselines.push(ref);}ref.monitorCheckId=c.id;ref.updatedAt=now();return c;}
  if(method==='POST'&&path==='/api/auto/run-next'){
   if(!state.autoSettings.enabled||state.autoSettings.paused)return {ran:false,reason:'paused'};
   const recent=state.autoJobs.filter(j=>j.startedAt&&Date.now()-Date.parse(j.startedAt)<3600000);
   if(recent.length>=state.autoSettings.maxPerHour)return {ran:false,reason:'hourly-cap',nextEligibleAt:new Date(Math.min(...recent.map(j=>Date.parse(j.startedAt)))+3600000).toISOString()};
   const job=state.autoJobs.find(j=>j.status==='queued'&&Date.parse(j.dueAt)<=Date.now());if(!job)return {ran:false,reason:'not-due'};
   const w=state.workflows.find(w=>w.id===job.workflowId);if(!w){job.status='cancelled';return {ran:false,job};}
   let target=job.target;if(target&&state.prompts.find(p=>p.id===target.promptId)?.activeVersionId===target.versionId)target=null;
   let prepared;try{prepared=prepare(w,target);preflightPlan(prepared);}catch(error){job.status='blocked';job.error=error.message;return {ran:false,reason:'blocked',job};}
   job.status='running';job.startedAt=now();try{const check=await run(w,target,prepared);job.status='complete';job.checkId=check.id;job.monitor=check.monitor;job.result=check.status;alertFor(job,check);}catch(error){job.status='failed';job.error=error.message;state.regressionAlerts.push({id:id(),workflowId:w.id,jobId:job.id,kind:'check-failed',messages:[error.message],createdAt:now(),readAt:null,acknowledgedAt:null});}job.finishedAt=now();return {ran:true,job};
  }
 }
 return {route,observe,begin};
}

