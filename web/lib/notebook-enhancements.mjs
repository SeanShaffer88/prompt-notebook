import {id,now,requireValue,text,variables,versionFor,cleanChecks,evaluate} from './notebook-core.mjs';

const numeric=(value,name,max=1e9)=>{if(value===null || value===undefined || value==='')return null;requireValue(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max,`Invalid ${name}.`);return value;};
export function workflowPlan(state,experiment,workflow,defaultModel){
 const versions=workflow.promptIds.map(pid=>{const v=versionFor(state,pid);return {...v,provider:v.provider || 'anthropic',model:v.model || defaultModel(v.provider || 'anthropic')};});
 const winner=versionFor(state,experiment.promptId,experiment.winnerVersionId);
 return {workflow:structuredClone(workflow),versions,winner:{...winner,provider:winner.provider || 'anthropic',model:winner.model || defaultModel(winner.provider || 'anthropic')}};
}
export function enhancementState(state,defaultModel){return (state.workflowChecks || []).map(check=>{
 try{const e=check.autoTarget?{promptId:check.promptId,winnerVersionId:check.winnerVersionId}:state.experiments.find(e=>e.id===check.experimentId),w=state.workflows.find(w=>w.id===check.workflowId);const expired=w.quality?.maxAgeHours!=null&&Date.now()-Date.parse(check.finishedAt || check.createdAt)>w.quality.maxAgeHours*3600000;return {...check,expired:Boolean(expired),stale:Boolean(expired)||JSON.stringify(workflowPlan(state,e,w,defaultModel))!==check.signature};}catch{return {...check,stale:true};}
});}
export function activationGate(state,promptId,versionId,defaultModel){
 const prompt=state.prompts.find(p=>p.id===promptId);if(prompt?.activeVersionId===versionId)return {blocked:false,checks:[]};
 const checks=enhancementState(state,defaultModel),affected=state.workflows.filter(w=>w.promptIds.includes(promptId));
 const items=affected.map(w=>{
  const check=checks.slice().reverse().find(c=>c.workflowId===w.id&&c.promptId===promptId&&c.winnerVersionId===versionId);
  let problem=null;
  if(!check)problem='missing';
  else if(check.stale||check.baselineVersionId!==prompt.activeVersionId)problem='stale';
  else if(check.status==='regression'||check.flags.some(f=>f.kind==='regression'||f.kind==='failure'))problem='regression';
  else if(check.status==='running'||check.branches.baseline.status!=='complete'||check.branches.candidate.status!=='complete')problem='incomplete';
  else if(check.flags.some(f=>f.kind==='sample'||f.kind==='inconclusive')||check.branches.baseline.simulated||check.branches.candidate.simulated)problem='unverified';
  else if(check.review?.decision==='reject'||check.flags.some(f=>f.kind==='review')&&check.review?.decision!=='accept')problem='human-review';
  return {workflowId:w.id,title:w.title,checkId:check?.id || null,problem};
 });return {blocked:items.some(c=>c.problem),checks:items};
}
export function enhancementService(state,{execute,preflight,defaultModel}){
 state.workflowChecks ||= [];
 state.datasets ||= [];
 state.runReviews ||= [];
 state.workflowBatches ||= [];
 async function compareWorkflow(check,baselineVersions,candidateVersions){const plan=check.plan,input=check.input;
   await Promise.allSettled(Object.entries(check.branches).map(async([name,branch])=>{
    const versions=name==='baseline'?baselineVersions:candidateVersions;let value=input;
    try{for(let index=0;index<versions.length;index++){
     const v=versions[index],contract=plan.workflow.quality?.contracts[index] || {},inputs={[variables(v.template)[0]]:value};
     try{const run=await execute(v.promptId,v.id,inputs,{workflowCheckId:check.id,workflowBranch:name,workflowStep:index},v);
      const rule=evaluate(run.output,contract.checks);let fieldsPass=null;
      if(contract.requiredFields?.length){try{const obj=JSON.parse(run.output);fieldsPass=Boolean(obj&&typeof obj==='object'&&!Array.isArray(obj)&&contract.requiredFields.every(k=>Object.hasOwn(obj,k)));}catch{fieldsPass=false;}}
      branch.steps.push({index,promptId:v.promptId,versionId:v.id,runId:run.id,rule,fieldsPass});value=run.output;
     }catch(error){branch.steps.push({index,promptId:v.promptId,versionId:v.id,error:error.message});throw error;}
    }branch.status='complete';}catch(error){branch.status='failed';branch.error=error.message;}
    const runs=branch.steps.map(s=>state.runs.find(r=>r.id===s.runId)).filter(Boolean);branch.latencyMs=runs.reduce((n,r)=>n+(r.latencyMs || 0),0);branch.simulated=runs.some(r=>r.simulated);
    branch.costUsd=branch.status==='complete'&&branch.steps.every(s=>{const c=plan.workflow.quality?.contracts[s.index];return c?.inputPerMillion!=null&&c?.outputPerMillion!=null;})?runs.reduce((n,r,i)=>{const c=plan.workflow.quality.contracts[i];return n+((r.usage?.input_tokens || 0)*c.inputPerMillion+(r.usage?.output_tokens || 0)*c.outputPerMillion)/1e6;},0):null;
   }));
   const a=check.branches.baseline,b=check.branches.candidate,flag=(kind,message,index)=>check.flags.push({kind,message,...(index===undefined?{}:{index})});
   if(a.status==='failed')flag('inconclusive','Current workflow failed; improvement cannot be established.');
   if(b.status==='failed')flag(a.status==='complete'?'regression':'inconclusive','Candidate workflow failed: '+b.error);
   for(const step of b.steps){const before=a.steps.find(s=>s.index===step.index);if(!before?.runId||!step.runId)continue;
    if(before.rule.pass===true&&step.rule.pass===false)flag('regression','Previously passing rule checks now fail.',step.index);
    if(before.fieldsPass===true&&step.fieldsPass===false)flag('regression','Required JSON fields were lost.',step.index);
    if(step.rule.pass===false||step.fieldsPass===false)flag('failure','Candidate violates a configured step contract.',step.index);
    const old=state.runs.find(r=>r.id===before.runId),next=state.runs.find(r=>r.id===step.runId);if(old.output!==next.output)flag('review','Output changed; review for quality or downstream impact.',step.index);
   }
   for(const [metric,limit,label] of [['latencyMs',plan.workflow.quality?.maxLatencyMs,'Latency'],['costUsd',plan.workflow.quality?.maxCostUsd,'Estimated cost']])if(limit!=null){if(b[metric]==null)flag('inconclusive',label+' cannot be checked: provide prices for every step.');else if(b[metric]>limit)flag(a[metric]!=null&&a[metric]<=limit?'regression':'failure',label+' exceeds the configured budget.');}
   if(a.simulated||b.simulated)flag('sample','Simulated outputs and zero usage do not establish quality, cost or speed.');
   check.status=check.flags.some(f=>f.kind==='regression')?'regression':check.flags.some(f=>['failure','inconclusive'].includes(f.kind))?'needs-review':a.simulated||b.simulated?'sample':check.flags.some(f=>f.kind==='review')?'needs-review':'no-automatic-regressions';check.finishedAt=now();return check;
 }
 async function route(method,path,body){
  const freshness=path.match(/^\/api\/workflows\/([^/]+)\/check-age$/);
  if(method==='POST'&&freshness){const w=state.workflows.find(w=>w.id===freshness[1]);requireValue(w,'Workflow not found.',404);const maxAgeHours=numeric(body.maxAgeHours,'maximum check age',720);requireValue(maxAgeHours===null||maxAgeHours>0,'Check age must be positive.');w.quality ||= {contracts:w.promptIds.map(()=>({checks:cleanChecks(),requiredFields:[],inputPerMillion:null,outputPerMillion:null})),maxCostUsd:null,maxLatencyMs:null};w.quality.maxAgeHours=maxAgeHours;return w;}
  const savedInput=path.match(/^\/api\/workflows\/([^/]+)\/test-input$/);
  if(method==='POST'&&savedInput){const w=state.workflows.find(w=>w.id===savedInput[1]);requireValue(w,'Workflow not found.',404);w.testInput=text(body.input,'Reusable workflow input',30000);return w;}
  const reviewCheck=path.match(/^\/api\/workflow-checks\/([^/]+)\/review$/);
  if(method==='POST'&&reviewCheck){const c=state.workflowChecks.find(c=>c.id===reviewCheck[1]);requireValue(c&&c.status!=='running','Finished workflow check not found.',404);requireValue(['accept','reject','note'].includes(body.decision),'Choose a review decision.');const review={decision:body.decision,notes:text(body.notes,'Review note',3000),createdAt:now()};c.reviewHistory ||= [];c.reviewHistory.push(review);c.review=review;return c;}
  const start=path.match(/^\/api\/experiments\/([^/]+)\/workflow-batch$/);
  if(method==='POST'&&start){
   const e=state.experiments.find(e=>e.id===start[1]);requireValue(e?.status==='complete'&&e.versionIds.includes(e.winnerVersionId),'Choose a winner from a completed experiment.',422);
   requireValue(!state.workflowBatches.some(b=>b.experimentId===e.id&&b.status==='running'),'Resume or cancel the existing workflow batch before starting another.',409);
   const p=state.prompts.find(p=>p.id===e.promptId);requireValue(body.baselineVersionId===p.activeVersionId,'Active version changed. Refresh before starting.',409);requireValue(e.winnerVersionId!==p.activeVersionId,'Winner is already active.');
   const mode=body.mode || 'missing-stale';requireValue(['missing-stale','retry','all'].includes(mode),'Invalid batch mode.');
   const gate=activationGate(state,e.promptId,e.winnerVersionId,defaultModel),selected=gate.checks.filter(c=>mode==='all'||(mode==='retry'?['regression','incomplete','unverified','human-review'].includes(c.problem):['missing','stale'].includes(c.problem)));
   const items=selected.map(c=>{const w=state.workflows.find(w=>w.id===c.workflowId),latest=state.workflowChecks.slice().reverse().find(check=>check.workflowId===w.id&&check.winnerVersionId===e.winnerVersionId);const input=text(body.inputs?.[w.id] || w.testInput || latest?.input || state.workflowRuns.slice().reverse().find(r=>r.workflowId===w.id)?.input,'Input for '+w.title,30000);const plan=workflowPlan(state,e,w,defaultModel);const versions=[...plan.versions,plan.winner];versions.forEach(v=>requireValue(variables(v.template).length===1,'Every workflow step needs one input variable.'));preflight(versions);return {workflowId:w.id,title:w.title,input,signature:JSON.stringify(plan),status:'queued'};});
   requireValue(JSON.stringify(state).length+JSON.stringify(items).length+5000<=700000,'Batch plan exceeds workspace storage.',413);
   const batch={id:id(),experimentId:e.id,promptId:e.promptId,winnerVersionId:e.winnerVersionId,baselineVersionId:p.activeVersionId,mode,items,status:items.length?'running':'complete',createdAt:now()};state.workflowBatches.push(batch);return batch;
  }
  const batchAction=path.match(/^\/api\/workflow-batches\/([^/]+)\/(next|cancel)$/);
  if(method==='POST'&&batchAction){const batch=state.workflowBatches.find(b=>b.id===batchAction[1]);requireValue(batch,'Batch not found.',404);
   if(batchAction[2]==='cancel'){if(batch.status==='running'){batch.status='cancelled';batch.finishedAt=now();for(const item of batch.items)if(item.status==='queued')item.status='cancelled';}return batch;}
   requireValue(batch.status==='running','This batch is no longer running.',409);const item=batch.items.find(i=>i.status==='queued');if(!item){batch.status='complete';batch.finishedAt=now();return batch;}
   requireValue(body.expectedWorkflowId===item.workflowId,'Batch progress changed. Refresh before continuing.',409);
   const e=state.experiments.find(e=>e.id===batch.experimentId),w=state.workflows.find(w=>w.id===item.workflowId);
   if(!e||e.winnerVersionId!==batch.winnerVersionId||state.prompts.find(p=>p.id===batch.promptId)?.activeVersionId!==batch.baselineVersionId||!w||JSON.stringify(workflowPlan(state,e,w,defaultModel))!==item.signature){batch.status='stale';batch.finishedAt=now();item.status='stale';item.error='Workflow settings, winner or active version changed. Start a new batch.';return batch;}
   item.status='running';try{const check=await route('POST',`/api/experiments/${e.id}/workflow-check`,{workflowId:w.id,baselineVersionId:batch.baselineVersionId,input:item.input});item.checkId=check.id;item.status='complete';item.result=check.status;}catch(error){item.status='failed';item.error=error.message;}
   if(!batch.items.some(i=>i.status==='queued')){batch.status='complete';batch.finishedAt=now();}return batch;
  }
  if(method==='POST'&&path==='/api/run-reviews'){
   const run=state.runs.find(r=>r.id===body.runId&&r.status==='complete');requireValue(run,'Completed response not found.',404);
   const scores={};for(const key of ['accuracy','clarity','completeness','tone']){const score=body.scores?.[key];requireValue(score===null || Number.isInteger(score)&&score>=1&&score<=5,'Rubric scores must be 1–5 or null.');scores[key]=score;}
   const notes=body.notes?text(body.notes,'Review notes',3000):'';let review=state.runReviews.find(r=>r.runId===run.id);if(!review){review={id:id(),runId:run.id,promptId:run.promptId};state.runReviews.push(review);}Object.assign(review,{scores,notes,updatedAt:now()});return review;
  }
  const blind=path.match(/^\/api\/(comparisons|experiments)\/([^/]+)\/blind$/);
  if(method==='POST'&&blind){const c=state[blind[1]].find(c=>c.id===blind[2]);requireValue(c,'Comparison not found.',404);requireValue(typeof body.enabled==='boolean','Choose whether identities should be hidden.');
   if(body.enabled){if(!c.blind){const order=blind[1]==='experiments'?[...c.versionIds]:c.results.map(r=>r.runId);for(let i=order.length-1;i>0;i--){const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[order[i],order[j]]=[order[j],order[i]];}c.blind={order,createdAt:now()};}c.blind.hidden=true;}else if(c.blind){c.blind.hidden=false;c.blind.revealedAt=now();}return c;
  }
  if(method==='POST'&&path==='/api/datasets'){
   versionFor(state,body.promptId);requireValue(Array.isArray(body.testIds)&&body.testIds.length>0&&body.testIds.length<=3,'Select 1–3 examples for a reusable dataset.');
   const examples=[...new Set(body.testIds)].map(tid=>{const t=state.tests.find(t=>t.id===tid&&t.promptId===body.promptId);requireValue(t,'Dataset example does not belong to this prompt.');return {...structuredClone(t),id:id()};});
   const dataset={id:id(),promptId:body.promptId,title:text(body.title,'Dataset title',160),examples,createdAt:now()};state.datasets.push(dataset);return dataset;
  }
  const quality=path.match(/^\/api\/workflows\/([^/]+)\/quality$/);
  if(method==='POST'&&quality){
   const w=state.workflows.find(w=>w.id===quality[1]);requireValue(w,'Workflow not found.',404);
   requireValue(Array.isArray(body.contracts)&&body.contracts.length===w.promptIds.length,'Provide one contract per workflow step.');
   const contracts=body.contracts.map(c=>{requireValue(c&&typeof c==='object','Invalid contract.');const requiredFields=c.requiredFields || [];requireValue(Array.isArray(requiredFields)&&requiredFields.length<=30&&requiredFields.every(k=>typeof k==='string'&&k.length>0&&k.length<=100),'Required fields must be top-level JSON field names.');return {checks:cleanChecks(c.checks),requiredFields,inputPerMillion:numeric(c.inputPerMillion,'input price'),outputPerMillion:numeric(c.outputPerMillion,'output price')};});
   const maxAgeHours=numeric(body.maxAgeHours,'check age',720);requireValue(maxAgeHours===null||maxAgeHours>0,'Check age must be positive.');w.quality={contracts,maxLatencyMs:numeric(body.maxLatencyMs,'latency budget'),maxCostUsd:numeric(body.maxCostUsd,'cost budget'),maxAgeHours};return w;
  }
  const trial=path.match(/^\/api\/experiments\/([^/]+)\/workflow-check$/);
  if(method==='POST'&&trial){
   const e=state.experiments.find(e=>e.id===trial[1]);requireValue(e?.status==='complete'&&e.versionIds.includes(e.winnerVersionId),'Select a winner from a completed experiment first.',422);
   const w=state.workflows.find(w=>w.id===body.workflowId);requireValue(w&&w.promptIds.includes(e.promptId),'Choose a workflow containing this prompt.');
   const active=versionFor(state,e.promptId);requireValue(body.baselineVersionId===active.id,'Active version changed. Refresh before testing.',409);requireValue(active.id!==e.winnerVersionId,'Winner is already active.');
   const plan=workflowPlan(state,e,w,defaultModel),candidateVersions=plan.versions.map(v=>v.promptId===e.promptId?plan.winner:v);
   [...plan.versions,...candidateVersions].forEach(v=>requireValue(variables(v.template).length===1,'Each tested workflow step must have one input variable.'));
   preflight([...plan.versions,...candidateVersions]);const input=text(body.input,'Workflow input',30000);
   const estimate=JSON.stringify(state).length+JSON.stringify(plan).length+[...plan.versions,...candidateVersions].reduce((n,v)=>n+v.maxTokens*48+input.length+6000,0);
   requireValue(estimate<=700000,'This workflow check may exceed workspace storage. Use shorter outputs or export to the local app.',413);
   const check={id:id(),experimentId:e.id,promptId:e.promptId,workflowId:w.id,winnerVersionId:e.winnerVersionId,baselineVersionId:active.id,input,plan,signature:JSON.stringify(plan),createdAt:now(),status:'running',branches:{baseline:{steps:[],status:'running'},candidate:{steps:[],status:'running'}},flags:[]};state.workflowChecks.push(check);
   return compareWorkflow(check,plan.versions,candidateVersions);
  }
 }
 return {route,compareWorkflow};
}
