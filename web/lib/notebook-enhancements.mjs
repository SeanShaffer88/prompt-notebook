import {id,now,requireValue,text,variables,versionFor,cleanChecks,evaluate} from './notebook-core.mjs';

const numeric=(value,name,max=1e9)=>{if(value===null || value===undefined || value==='')return null;requireValue(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max,`Invalid ${name}.`);return value;};
export function workflowPlan(state,experiment,workflow,defaultModel){
 const versions=workflow.promptIds.map(pid=>{const v=versionFor(state,pid);return {...v,provider:v.provider || 'anthropic',model:v.model || defaultModel(v.provider || 'anthropic')};});
 const winner=versionFor(state,experiment.promptId,experiment.winnerVersionId);
 return {workflow:structuredClone(workflow),versions,winner:{...winner,provider:winner.provider || 'anthropic',model:winner.model || defaultModel(winner.provider || 'anthropic')}};
}
export function enhancementState(state,defaultModel){return (state.workflowChecks || []).map(check=>{
 try{const e=state.experiments.find(e=>e.id===check.experimentId),w=state.workflows.find(w=>w.id===check.workflowId);return {...check,stale:JSON.stringify(workflowPlan(state,e,w,defaultModel))!==check.signature};}catch{return {...check,stale:true};}
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
  return {workflowId:w.id,title:w.title,checkId:check?.id || null,problem};
 });return {blocked:items.some(c=>c.problem),checks:items};
}
export function enhancementService(state,{execute,preflight,defaultModel}){
 state.workflowChecks ||= [];
 state.datasets ||= [];
 state.runReviews ||= [];
 async function route(method,path,body){
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
   w.quality={contracts,maxLatencyMs:numeric(body.maxLatencyMs,'latency budget'),maxCostUsd:numeric(body.maxCostUsd,'cost budget')};return w;
  }
  const trial=path.match(/^\/api\/experiments\/([^/]+)\/workflow-check$/);
  if(method==='POST'&&trial){
   const e=state.experiments.find(e=>e.id===trial[1]);requireValue(e?.status==='complete'&&e.versionIds.includes(e.winnerVersionId),'Select a winner from a completed experiment first.',422);
   const w=state.workflows.find(w=>w.id===body.workflowId);requireValue(w&&w.promptIds.includes(e.promptId),'Choose a workflow containing this prompt.');
   const active=versionFor(state,e.promptId);requireValue(body.baselineVersionId===active.id,'Active version changed. Refresh before testing.',409);requireValue(active.id!==e.winnerVersionId,'Winner is already active.');
   const plan=workflowPlan(state,e,w,defaultModel),candidateVersions=plan.versions.map(v=>v.promptId===e.promptId?plan.winner:v);
   [...plan.versions,...candidateVersions].forEach(v=>requireValue(variables(v.template).length===1,'Each tested workflow step must have one input variable.'));
   preflight([...plan.versions,...candidateVersions]);const input=text(body.input,'Workflow input',30000);
   const estimate=JSON.stringify(state).length+JSON.stringify(plan).length+2*plan.versions.reduce((n,v)=>n+v.maxTokens*48+input.length+6000,0);
   requireValue(estimate<=700000,'This workflow check may exceed workspace storage. Use shorter outputs or export to the local app.',413);
   const check={id:id(),experimentId:e.id,promptId:e.promptId,workflowId:w.id,winnerVersionId:e.winnerVersionId,baselineVersionId:active.id,input,plan,signature:JSON.stringify(plan),createdAt:now(),status:'running',branches:{baseline:{steps:[],status:'running'},candidate:{steps:[],status:'running'}},flags:[]};state.workflowChecks.push(check);
   await Promise.allSettled(Object.entries(check.branches).map(async([name,branch])=>{
    const versions=name==='baseline'?plan.versions:candidateVersions;let value=input;
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
 }
 return {route};
}
