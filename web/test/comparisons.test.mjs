import {test} from 'node:test';
import assert from 'node:assert/strict';
import seed from '../lib/seed.json' with {type:'json'};
import {notebookService} from '../lib/notebook-service.mjs';
const targets=[{provider:'openai',model:'gpt-4.1-mini'},{provider:'openai',model:'gpt-4.1'}];
const output=text=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:5,output_tokens:7}})});

async function reviewed(state){const service=notebookService(state),prompt=state.prompts[0];const c=await service.route('POST','/api/comparisons',{promptId:prompt.id,inputs:{source_notes:'review notes'},targets});await service.route('POST',`/api/comparisons/${c.id}/rate`,{runId:c.results[0].runId,rating:5});await service.route('POST',`/api/comparisons/${c.id}/winner`,{runId:c.results[0].runId});return {service,c,prompt};}

async function tested(state){const {service,c,prompt}=await reviewed(state);const suggestion=await service.route('POST',`/api/comparisons/${c.id}/suggest`,{});const candidate=await service.route('POST',`/api/improvements/${suggestion.id}/candidate`,{template:suggestion.template});const experiment=await service.route('POST','/api/experiments',{promptId:prompt.id,versionIds:[c.versionId,candidate.id],testIds:[candidate.comparisonSource.testId]});return {service,prompt,candidate,experiment:state.experiments.find(e=>e.id===experiment.id),original:c.versionId};}

test('workflow batch queues all missing checks, preserves progress, cancels and reuses fresh checks',async()=>{
 const state=structuredClone(seed),{service,prompt,candidate,experiment,original}=await tested(state);await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});const a=state.workflows[0],b=await service.route('POST','/api/workflows',{title:'Research to editor',promptIds:[prompt.id,state.prompts[2].id]});
 for(const w of [a,b])await service.route('POST',`/api/workflows/${w.id}/test-input`,{input:'Reusable notes'});
 let batch=await service.route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original});assert.equal(batch.items.length,2);assert.equal(batch.items[0].input,'Reusable notes');
 await assert.rejects(service.route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original}),/existing/);
 await assert.rejects(service.route('POST',`/api/workflow-batches/${batch.id}/next`,{expectedWorkflowId:'wrong'}),/progress/);assert.equal(state.workflowChecks.length,0);
 batch=await service.route('POST',`/api/workflow-batches/${batch.id}/next`,{expectedWorkflowId:a.id});assert.equal(batch.items[0].status,'complete');assert.equal(batch.items[1].status,'queued');assert.equal(prompt.activeVersionId,original);
 const reopened=notebookService(structuredClone(state));assert.equal((await reopened.route('GET','/api/state')).workflowBatches[0].items[0].status,'complete');
 await service.route('POST',`/api/workflow-batches/${batch.id}/cancel`,{});assert.equal(batch.status,'cancelled');assert.equal(batch.items[1].status,'cancelled');await assert.rejects(service.route('POST',`/api/workflow-batches/${batch.id}/next`,{expectedWorkflowId:b.id}),/no longer/);
 const next=await service.route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original});assert.deepEqual(next.items.map(i=>i.workflowId),[b.id]);
 state.prompts[0].activeVersionId=candidate.id;await service.route('POST',`/api/workflow-batches/${next.id}/next`,{expectedWorkflowId:b.id});assert.equal(next.status,'stale');assert.equal(state.workflowChecks.length,1);
});

test('batch preflights inputs and keys before calls; expiry reruns stale checks; review acceptance never clears regressions',async()=>{
 const state=structuredClone(seed),{service,candidate,experiment,original}=await tested(state);await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});const w=state.workflows[0];
 await assert.rejects(service.route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original}),/Input/);assert.equal(state.workflowBatches.length,0);
 await service.route('POST',`/api/workflows/${w.id}/test-input`,{input:'notes'});await assert.rejects(notebookService(state,{openai:'test'}).route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original}),/key/);assert.equal(state.workflowBatches.length,0);
 for(const v of state.versions){v.provider='openai';v.model='gpt-4.1-mini';}await service.route('POST',`/api/workflows/${w.id}/check-age`,{maxAgeHours:1});
 const previous=globalThis.fetch;globalThis.fetch=async()=>output('GOOD');try{const live=notebookService(state,{openai:'test'});const batch=await live.route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original});await live.route('POST',`/api/workflow-batches/${batch.id}/next`,{expectedWorkflowId:w.id});const check=state.workflowChecks[0];assert.equal((await live.route('GET','/api/state')).activationGates[candidate.id].blocked,false);
 check.flags.push({kind:'review',message:'Output changed'});assert.equal((await live.route('GET','/api/state')).activationGates[candidate.id].checks[0].problem,'human-review');await live.route('POST',`/api/workflow-checks/${check.id}/review`,{decision:'accept',notes:'Changed wording preserves the contract.'});assert.equal((await live.route('GET','/api/state')).activationGates[candidate.id].blocked,false);
 check.flags.push({kind:'regression',message:'Required field lost'});assert.equal((await live.route('GET','/api/state')).activationGates[candidate.id].checks[0].problem,'regression');check.flags=[];check.finishedAt=new Date(Date.now()-7200000).toISOString();const stale=await live.route('GET','/api/state');assert.equal(stale.workflowChecks[0].expired,true);assert.equal(stale.activationGates[candidate.id].checks[0].problem,'stale');const retry=await live.route('POST',`/api/experiments/${experiment.id}/workflow-batch`,{baselineVersionId:original});assert.equal(retry.items.length,1);
 }finally{globalThis.fetch=previous;}
});

test('activation gate rejects missing and sample checks on all activation routes; override saves immutable blockers and reason',async()=>{
 const state=structuredClone(seed),{service,prompt,candidate,experiment,original}=await tested(state),body={winnerVersionId:candidate.id,expectedActiveVersionId:original};await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});
 await assert.rejects(service.route('POST',`/api/experiments/${experiment.id}/activate`,body),/missing/);
 await assert.rejects(service.route('POST',`/api/prompts/${prompt.id}/activate`,{versionId:candidate.id}),/missing/);
 for(const overrideReason of ['', '   ', 'x'.repeat(3001)])await assert.rejects(service.route('POST',`/api/experiments/${experiment.id}/activate`,{...body,override:true,overrideReason}),/Override reason/);
 assert.equal(state.activationHistory.length,0);assert.equal(prompt.activeVersionId,original);
 await service.route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:state.workflows[0].id,baselineVersionId:original,input:'notes'});
 await assert.rejects(service.route('POST',`/api/experiments/${experiment.id}/activate`,body),/unverified/);
 const activation=await service.route('POST',`/api/experiments/${experiment.id}/activate`,{...body,override:true,overrideReason:'Accept the sample check for this demonstration.'});assert.equal(activation.override.reason,'Accept the sample check for this demonstration.');assert.equal(activation.workflowGate.checks[0].problem,'unverified');assert.equal(state.activationHistory[0].id,activation.id);
 const reopened=await notebookService(structuredClone(state)).route('GET','/api/state');assert.equal(reopened.activationHistory[0].override.reason,activation.override.reason);
 await service.route('POST',`/api/experiments/${experiment.id}/rollback`,{activationId:activation.id,expectedActiveVersionId:candidate.id});assert.ok(state.activationHistory[0].rolledBackAt);assert.equal(prompt.activeVersionId,original);
 const bundle=await service.route('POST','/api/bundle/export',{});const imported=await service.route('POST','/api/bundle/import',{bundle});assert.equal(imported.counts.activationHistory,1);assert.equal(state.activationHistory[1].override.reason,activation.override.reason);
});

test('fresh passing checks allow activation; changed contracts, new workflows and regressions block it',async()=>{
 const state=structuredClone(seed),{service,prompt,candidate,experiment,original}=await tested(state);await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});for(const v of state.versions){v.provider='openai';v.model='gpt-4.1-mini';}
 const previous=globalThis.fetch;globalThis.fetch=async()=>output('GOOD');
 try{const live=notebookService(state,{openai:'test-key'}),w=state.workflows[0],body={winnerVersionId:candidate.id,expectedActiveVersionId:original},check=await live.route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:w.id,baselineVersionId:original,input:'notes'});
 assert.equal((await live.route('GET','/api/state')).activationGates[candidate.id].blocked,false);
 const second={...structuredClone(w),id:'new-connected-workflow',title:'New dependency'};state.workflows.push(second);await assert.rejects(live.route('POST',`/api/experiments/${experiment.id}/activate`,body),/missing/);state.workflows.pop();
 w.quality={contracts:w.promptIds.map(()=>({checks:{contains:'GOOD'},requiredFields:[],inputPerMillion:null,outputPerMillion:null})),maxCostUsd:null,maxLatencyMs:null};await assert.rejects(live.route('POST',`/api/experiments/${experiment.id}/activate`,body),/stale/);delete w.quality;
 check.flags.push({kind:'regression',message:'Required field lost'});check.status='regression';await assert.rejects(live.route('POST',`/api/experiments/${experiment.id}/activate`,body),/regression/);check.flags=[];check.status='no-automatic-regressions';
 const activation=await live.route('POST',`/api/experiments/${experiment.id}/activate`,body);assert.equal(activation.override,null);assert.equal(activation.workflowGate.blocked,false);assert.equal(prompt.activeVersionId,candidate.id);
 }finally{globalThis.fetch=previous;}
});

test('portable bundles preserve evaluation graphs with new IDs and reject invalid imports atomically',async()=>{
 const state=structuredClone(seed),{service,experiment,candidate,prompt,original}=await tested(state);await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});await service.route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:state.workflows[0].id,baselineVersionId:original,input:'notes'});
 const bundle=await service.route('POST','/api/bundle/export',{});assert.ok(!bundle.data.settings);const preview=await service.route('POST','/api/bundle/preview',{bundle});assert.equal(preview.counts.prompts,3);assert.equal(state.prompts.length,3);
 const imported=await service.route('POST','/api/bundle/import',{bundle});assert.equal(state.prompts.length,6);assert.ok(!imported.promptIds.includes(prompt.id));const newPrompt=state.prompts.find(p=>p.id===imported.promptIds[0]);assert.equal(state.versions.find(v=>v.id===newPrompt.activeVersionId).promptId,newPrompt.id);assert.equal(prompt.activeVersionId,original);
 const reopened=await notebookService(state).route('GET','/api/state');assert.equal(reopened.workflowChecks[1].stale,true);
 const before=JSON.stringify(state);for(const mutate of [b=>b.data.versions[0].promptId='missing',b=>b.data.prompts.push(b.data.prompts[0]),b=>b.data.experiments[0].repeats=1000000,b=>b.data.prompts[0].credentials='secret',b=>b.schemaVersion=99]){const bad=structuredClone(bundle);mutate(bad);await assert.rejects(service.route('POST','/api/bundle/import',{bundle:bad}));assert.equal(JSON.stringify(state),before);}
});

test('rubric reviews persist, feed improvement evidence and blind identities must be revealed for activation',async()=>{
 const state=structuredClone(seed),{service,c,prompt}=await reviewed(state),runId=c.results[0].runId;
 const scores={accuracy:5,clarity:4,completeness:null,tone:3};await service.route('POST','/api/run-reviews',{runId,scores,notes:'Clear but terse'});await service.route('POST','/api/run-reviews',{runId,scores,notes:'Updated'});assert.equal(state.runReviews.length,1);
 const suggestion=await service.route('POST',`/api/comparisons/${c.id}/suggest`,{});assert.equal(suggestion.evidence[0].rubric.scores.clarity,4);
 await service.route('POST',`/api/comparisons/${c.id}/blind`,{enabled:true});const order=[...c.blind.order];await service.route('POST',`/api/comparisons/${c.id}/blind`,{enabled:false});await service.route('POST',`/api/comparisons/${c.id}/blind`,{enabled:true});assert.deepEqual(c.blind.order,order);
 await assert.rejects(service.route('POST','/api/run-reviews',{runId,scores:{...scores,accuracy:6}}));
 const candidate=await service.route('POST',`/api/improvements/${suggestion.id}/candidate`,{template:suggestion.template}),e=await service.route('POST','/api/experiments',{promptId:prompt.id,versionIds:[prompt.activeVersionId,candidate.id],testIds:[candidate.comparisonSource.testId]});
 await service.route('POST',`/api/experiments/${e.id}/winner`,{versionId:candidate.id});await service.route('POST',`/api/experiments/${e.id}/blind`,{enabled:true});await assert.rejects(service.route('POST',`/api/experiments/${e.id}/activate`,{winnerVersionId:candidate.id,expectedActiveVersionId:prompt.activeVersionId}),/Reveal/);
});

test('datasets snapshot examples and repeated trials preserve every output and rule result',async()=>{
 const state=structuredClone(seed),{service,prompt,candidate,original}=await tested(state);const example=state.tests[0];const dataset=await service.route('POST','/api/datasets',{promptId:prompt.id,title:'Reusable evidence cases',testIds:[example.id]});example.inputs.source_notes='Changed later';assert.notEqual(dataset.examples[0].inputs.source_notes,example.inputs.source_notes);
 const e=await service.route('POST','/api/experiments',{promptId:prompt.id,versionIds:[original,candidate.id],datasetId:dataset.id,repeats:3});assert.equal(e.results.length,6);assert.deepEqual([...new Set(e.results.map(r=>r.trial))],[0,1,2]);assert.equal(e.testSnapshots[0].inputs.source_notes,dataset.examples[0].inputs.source_notes);
 await service.route('POST',`/api/experiments/${e.id}/winner`,{versionId:candidate.id});
 await assert.rejects(service.route('POST','/api/experiments',{promptId:prompt.id,versionIds:[original,candidate.id],datasetId:dataset.id,repeats:4}),/trials/);
 const run=state.runs[0];run.status='failed';const test=await service.route('POST',`/api/prompts/${prompt.id}/tests`,{sourceRunId:run.id,title:'Captured failure',inputs:run.inputs,expected:'Correct expected response',checks:{contains:'Correct'}});assert.equal(test.sourceRunId,run.id);
 await assert.rejects(service.route('POST',`/api/prompts/${state.prompts[1].id}/tests`,{sourceRunId:run.id,title:'Wrong prompt',inputs:{source_notes:'x'}}),/Source/);
});

test('workflow checks isolate winner substitution, propagate branch outputs and flag regressions',async()=>{
 const state=structuredClone(seed),{service,candidate,experiment,prompt,original}=await tested(state),w=state.workflows[0];
 await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});
 for(const v of state.versions){v.provider='openai';v.model='gpt-4.1-mini';}
 candidate.template='CANDIDATE {{source_notes}}';
 await service.route('POST',`/api/workflows/${w.id}/quality`,{contracts:w.promptIds.map(()=>({checks:{contains:'GOOD'},requiredFields:[],inputPerMillion:1,outputPerMillion:2})),maxLatencyMs:10000,maxCostUsd:1});
 const previous=globalThis.fetch,requests=[];globalThis.fetch=async(url,init)=>{const request=JSON.parse(init.body);requests.push(request);return output(request.input.includes('CANDIDATE')||request.input.includes('BAD')?'BAD':'GOOD');};
 try{const result=await notebookService(state,{openai:'test-key'}).route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:w.id,baselineVersionId:original,input:'notes'});assert.equal(result.status,'regression');assert.ok(result.flags.some(f=>f.kind==='regression'&&f.index===1));assert.equal(result.branches.candidate.steps[0].versionId,candidate.id);assert.equal(result.branches.baseline.steps[0].versionId,original);assert.ok(requests.some(r=>r.input.includes('BAD')&&!r.input.includes('CANDIDATE')));assert.equal(prompt.activeVersionId,original);assert.ok(result.branches.candidate.costUsd>0);
 const fresh=await notebookService(state).route('GET','/api/state');assert.equal(fresh.workflowChecks[0].stale,false);state.prompts[1].activeVersionId='missing';assert.equal((await notebookService(state).route('GET','/api/state')).workflowChecks[0].stale,true);
 }finally{globalThis.fetch=previous;}
});

test('workflow key preflight happens before calls and sample checks never claim a quality pass',async()=>{
 const state=structuredClone(seed),{service,candidate,experiment,original}=await tested(state),w=state.workflows[0];await service.route('POST',`/api/experiments/${experiment.id}/winner`,{versionId:candidate.id});
 await assert.rejects(notebookService(state,{openai:'test-key'}).route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:w.id,baselineVersionId:original,input:'notes'}),/key/);assert.equal(state.workflowChecks.length,0);
 const result=await service.route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:w.id,baselineVersionId:original,input:'notes'});assert.equal(result.status,'sample');assert.equal(result.branches.baseline.steps.length,2);assert.ok(result.flags.some(f=>f.kind==='sample'));
 await assert.rejects(service.route('POST',`/api/experiments/${experiment.id}/workflow-check`,{workflowId:w.id,baselineVersionId:'stale',input:'notes'}),/changed/);
});

test('experiment winner activation and rollback persist without modifying saved versions or runs',async()=>{
 const state=structuredClone(seed),{service,prompt,candidate,experiment,original}=await tested(state),versions=structuredClone(state.versions),runs=structuredClone(state.runs);
 const route=(action,body)=>service.route('POST',`/api/experiments/${experiment.id}/${action}`,body);
 await route('winner',{versionId:candidate.id});assert.equal(prompt.activeVersionId,original);
 const activation=await route('activate',{winnerVersionId:candidate.id,expectedActiveVersionId:original,override:true,overrideReason:'Exercise sample activation and rollback.'});assert.equal(prompt.activeVersionId,candidate.id);assert.equal(activation.fromVersionId,original);
 assert.equal((await route('activate',{winnerVersionId:candidate.id,expectedActiveVersionId:candidate.id})).alreadyActive,true);assert.equal(experiment.activations.length,1);
 await route('winner',{versionId:original});assert.equal(prompt.activeVersionId,candidate.id);
 await route('rollback',{activationId:activation.id,expectedActiveVersionId:candidate.id});assert.equal(prompt.activeVersionId,original);assert.ok(activation.rolledBackAt);
 const reopened=await notebookService(structuredClone(state)).route('GET','/api/state');assert.equal(reopened.experiments[0].winnerVersionId,original);assert.ok(reopened.experiments[0].activations[0].rolledBackAt);assert.deepEqual(state.versions,versions);assert.deepEqual(state.runs,runs);
 await route('winner',{versionId:null});assert.equal(experiment.winnerVersionId,null);
});

test('experiment decisions reject foreign versions, incomplete runs and stale activation or rollback',async()=>{
 const state=structuredClone(seed),{service,prompt,candidate,experiment,original}=await tested(state),route=(action,body)=>service.route('POST',`/api/experiments/${experiment.id}/${action}`,body);
 await assert.rejects(route('winner',{versionId:state.prompts[1].activeVersionId}));await assert.rejects(route('activate',{winnerVersionId:candidate.id,expectedActiveVersionId:original}));
 await route('winner',{versionId:candidate.id});await assert.rejects(route('activate',{winnerVersionId:original,expectedActiveVersionId:original}));await assert.rejects(route('activate',{winnerVersionId:candidate.id,expectedActiveVersionId:'stale'}),/changed/);
 const activation=await route('activate',{winnerVersionId:candidate.id,expectedActiveVersionId:original,override:true,overrideReason:'Exercise stale rollback validation.'});prompt.activeVersionId=original;
 await assert.rejects(route('rollback',{activationId:activation.id,expectedActiveVersionId:candidate.id}),/changed/);await assert.rejects(route('rollback',{activationId:activation.id,expectedActiveVersionId:original}),/no longer/);
 experiment.status='failed';await assert.rejects(route('winner',{versionId:original}),/Complete/);experiment.status='complete';state.runs.find(r=>r.id===experiment.results[0].runId).status='failed';await assert.rejects(route('winner',{versionId:original}),/Complete/);assert.equal(prompt.activeVersionId,original);
});

test('review improvement preserves evidence, creates a candidate and tests the exact original',async()=>{
 const state=structuredClone(seed),{service,c,prompt}=await reviewed(state),base=state.versions.find(v=>v.id===c.versionId);
 const improvement=await service.route('POST',`/api/comparisons/${c.id}/suggest`,{feedback:'Prefer explicit uncertainty'});
 assert.equal(improvement.evidence[0].rating,5);assert.equal(improvement.evidence[0].winner,true);assert.equal(improvement.simulated,true);assert.equal(state.versions.length,seed.versions.length);
 await service.route('POST',`/api/comparisons/${c.id}/rate`,{runId:c.results[0].runId,rating:1});assert.equal(improvement.evidence[0].rating,5);
 const candidate=await service.route('POST',`/api/improvements/${improvement.id}/candidate`,{template:improvement.template});assert.equal(candidate.comparisonSource.versionId,base.id);assert.equal(candidate.provider,base.provider);assert.equal(candidate.maxTokens,base.maxTokens);
 assert.equal((await service.route('POST',`/api/improvements/${improvement.id}/candidate`,{template:improvement.template})).id,candidate.id);assert.equal(state.tests.length,seed.tests.length+1);
 const experiment=await service.route('POST','/api/experiments',{promptId:prompt.id,versionIds:[base.id,candidate.id],testIds:[candidate.comparisonSource.testId]});assert.equal(experiment.status,'complete');assert.equal(experiment.results.length,2);assert.ok(experiment.results.every(r=>r.pass===null));
 const runs=experiment.results.map(r=>state.runs.find(run=>run.id===r.runId));assert.deepEqual(runs[0].inputs,runs[1].inputs);assert.equal(runs[0].provider,runs[1].provider);assert.equal(runs[0].requestedModel,runs[1].requestedModel);assert.equal(runs[0].maxTokens,runs[1].maxTokens);assert.notEqual(runs[0].rendered,runs[1].rendered);assert.equal(prompt.activeVersionId,base.id);
 const reopened=await notebookService(structuredClone(state)).route('GET','/api/state');assert.equal(reopened.promptImprovements[0].id,improvement.id);
});

test('live suggestion includes winner and all ratings and validates placeholders before saving',async()=>{
 const state=structuredClone(seed),{c}=await reviewed(state),base=state.versions.find(v=>v.id===c.versionId);base.provider='openai';base.model='gpt-4.1-mini';
 const previous=globalThis.fetch,requests=[];globalThis.fetch=async(url,init)=>{requests.push(JSON.parse(init.body));return output(base.template+'\nPrefer concise, qualified claims.');};
 try{const service=notebookService(state,{openai:'test-key'}),suggestion=await service.route('POST',`/api/comparisons/${c.id}/suggest`,{feedback:'Keep caveats'});const evidence=JSON.parse(requests[0].input.split('\n\n').slice(1).join('\n\n'));assert.equal(evidence.responses[0].rating,5);assert.equal(evidence.responses[0].winner,true);assert.equal(evidence.responses.length,2);assert.equal(evidence.feedback,'Keep caveats');assert.ok(!JSON.stringify(state).includes('test-key'));
 const candidate=await service.route('POST',`/api/improvements/${suggestion.id}/candidate`,{template:suggestion.template});state.settings={provider:'gemini',models:{openai:'different-default'}};
 await service.route('POST','/api/experiments',{promptId:c.promptId,versionIds:[base.id,candidate.id],testIds:[candidate.comparisonSource.testId]});assert.equal(requests[1].model,requests[2].model);assert.equal(requests[1].max_output_tokens,requests[2].max_output_tokens);
 globalThis.fetch=async()=>output('No variables left');await assert.rejects(service.route('POST',`/api/comparisons/${c.id}/suggest`,{}),/variables/);assert.equal(state.promptImprovements.length,1);
 await assert.rejects(service.route('POST',`/api/improvements/${suggestion.id}/candidate`,{template:'Changed {{wrong}}'}),/variables/);
 }finally{globalThis.fetch=previous;}
});

test('suggestions require a winner, ratings and the source provider key before billable calls',async()=>{
 const state=structuredClone(seed),{service,c}=await reviewed(state),previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected');};
 try{await assert.rejects(notebookService(state,{openai:'test-key'}).route('POST',`/api/comparisons/${c.id}/suggest`,{}),/key/);c.results[0].rating=null;await assert.rejects(service.route('POST',`/api/comparisons/${c.id}/suggest`,{}),/Rate/);c.winnerRunId=null;await assert.rejects(service.route('POST',`/api/comparisons/${c.id}/suggest`,{}),/winner/);assert.equal(calls,0);assert.equal(state.promptImprovements.length,0);}finally{globalThis.fetch=previous;}
});

test('ratings, winner and saved response persist independently with immutable source snapshots',async()=>{
 const state=structuredClone(seed),service=notebookService(state),prompt=state.prompts[0];
 const c=await service.route('POST','/api/comparisons',{promptId:prompt.id,inputs:{source_notes:'review notes'},targets});
 const [a,b]=c.results.map(r=>r.runId),route=(action,body)=>service.route('POST',`/api/comparisons/${c.id}/${action}`,body);
 await route('rate',{runId:a,rating:5});await route('rate',{runId:b,rating:3});await route('winner',{runId:a});
 const saved=await route('save',{});assert.equal(saved.output,state.runs.find(r=>r.id===a).output);assert.equal(saved.rating,5);assert.equal(saved.model,targets[0].model);assert.equal(saved.simulated,true);assert.deepEqual(saved.inputs,{source_notes:'review notes'});
 assert.equal((await route('save',{})).id,saved.id);assert.equal(state.savedResponses.length,1);
 await route('rate',{runId:a,rating:1});await route('winner',{runId:b});assert.equal(saved.rating,5);assert.equal(saved.sourceRunId,a);
 const second=await route('save',{});assert.equal(second.sourceRunId,b);assert.equal(state.savedResponses.length,2);
 await route('rate',{runId:a,rating:null});await route('winner',{runId:null});assert.equal(c.results[0].rating,null);assert.equal(c.winnerRunId,null);
 const reopened=await notebookService(structuredClone(state)).route('GET','/api/state');assert.equal(reopened.savedResponses.length,2);assert.equal(reopened.comparisons[0].results[1].rating,3);
 assert.equal(prompt.activeVersionId,seed.prompts[0].activeVersionId);assert.equal(state.versions.length,seed.versions.length);
});

test('reviews reject invalid ratings, foreign runs, failed runs and saving without a winner',async()=>{
 const state=structuredClone(seed),service=notebookService(state),body={promptId:state.prompts[0].id,inputs:{source_notes:'notes'},targets};
 const c=await service.route('POST','/api/comparisons',body),other=await service.route('POST','/api/comparisons',body);
 const route=(action,body)=>service.route('POST',`/api/comparisons/${c.id}/${action}`,body),a=c.results[0].runId;
 for(const rating of [0,6,1.5,'5',undefined])await assert.rejects(route('rate',{runId:a,rating}));
 await assert.rejects(route('save',{}));await assert.rejects(route('winner',{runId:other.results[0].runId}));
 state.runs.find(r=>r.id===a).status='failed';await assert.rejects(route('winner',{runId:a}));await assert.rejects(route('rate',{runId:a,rating:5}));
 await assert.rejects(service.route('POST','/api/comparisons/missing/winner',{runId:a}));assert.equal(state.savedResponses.length,0);
});
test('same prompt fans out concurrently and records immutable, ordered model results',{timeout:2000},async()=>{
 const state=structuredClone(seed),p=state.prompts[0],source=structuredClone(state.versions[0]),originalFetch=globalThis.fetch,requests=[],waiting=[];
 globalThis.fetch=(url,init)=>new Promise(resolve=>{requests.push({url,...init});waiting.push(resolve);if(waiting.length===2){waiting[1](output('Second model'));waiting[0](output('First model'));}});
 try{
 const result=await notebookService(state,{openai:'test-openai-key'}).route('POST','/api/comparisons',{promptId:p.id,versionId:p.activeVersionId,inputs:{source_notes:'Identical notes'},targets});
 assert.equal(requests.length,2);assert.equal(JSON.parse(requests[0].body).input,JSON.parse(requests[1].body).input);assert.equal(JSON.parse(requests[0].body).max_output_tokens,source.maxTokens);
 assert.equal(result.status,'complete');assert.deepEqual(result.results.map(r=>state.runs.find(run=>run.id===r.runId).output),['First model','Second model']);assert.equal(state.versions.length,seed.versions.length);assert.equal(state.versions[0].template,source.template);assert.equal(p.activeVersionId,source.id);
 assert.equal(result.versionSnapshot.template,source.template);assert.equal(state.comparisons.length,1);assert.ok(!JSON.stringify(state).includes('test-openai-key'));
 }finally{globalThis.fetch=originalFetch;}
});
test('one failed model preserves successful responses and marks the batch partial',async()=>{
 const state=structuredClone(seed),p=state.prompts[0],previous=globalThis.fetch;
 globalThis.fetch=async(url,init)=>JSON.parse(init.body).model==='gpt-4.1'?{ok:false,status:429,json:async()=>({})}:output('Keep this answer');
 try{const result=await notebookService(state,{openai:'test-key'}).route('POST','/api/comparisons',{promptId:p.id,inputs:{source_notes:'notes'},targets});assert.equal(result.status,'partial');assert.equal(result.results[0].status,'complete');assert.equal(result.results[1].status,'failed');assert.match(result.results[1].error,/429/);assert.equal(state.runs.find(r=>r.id===result.results[0].runId).output,'Keep this answer');assert.equal(state.runs.find(r=>r.id===result.results[1].runId).status,'failed');}finally{globalThis.fetch=previous;}
});
test('all failures are saved as failed rather than treated as sample answers',async()=>{
 const state=structuredClone(seed),p=state.prompts[0],previous=globalThis.fetch;globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({})});
 try{const result=await notebookService(state,{openai:'test-key'}).route('POST','/api/comparisons',{promptId:p.id,inputs:{source_notes:'notes'},targets});assert.equal(result.status,'failed');assert.ok(result.results.every(r=>r.status==='failed'));assert.ok(state.runs.every(r=>r.status==='failed'&&!r.simulated));}finally{globalThis.fetch=previous;}
});
test('invalid targets, duplicate models, missing variables and missing keys fail before calls',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Unexpected request');};
 try{for(const change of [{targets:[targets[0]]},{targets:Array(5).fill(targets[0])},{targets:[targets[0],targets[0]]},{targets:[targets[0],{provider:'openai',model:'https://evil.test'}]},{inputs:{}},{targets:[targets[0],{provider:'gemini',model:'gemini-3.8-flash'}]}]){
 const state=structuredClone(seed);await assert.rejects(notebookService(state,{openai:'test-key'}).route('POST','/api/comparisons',{promptId:state.prompts[0].id,inputs:{source_notes:'notes'},targets,...change}));assert.equal(state.comparisons.length,0);
 }assert.equal(calls,0);}finally{globalThis.fetch=previous;}
});
test('old workspaces gain comparisons lazily; sample comparisons remain explicitly simulated',async()=>{
 const state=structuredClone(seed);assert.ok(!state.comparisons);const result=await notebookService(state).route('POST','/api/comparisons',{promptId:state.prompts[0].id,inputs:{source_notes:'notes'},targets});assert.equal(result.status,'complete');assert.equal(state.comparisons.length,1);assert.ok(state.runs.every(r=>r.simulated));assert.ok(state.runs.every(r=>r.comparisonId===result.id));
});
test('large comparisons are rejected before spending provider calls',async()=>{
 const state=structuredClone(seed);state.existingHistoryPadding='x'.repeat(350000);
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=()=>{calls++;throw Error('Should not call');};
 try{await assert.rejects(notebookService(state,{openai:'test-key'}).route('POST','/api/comparisons',{promptId:state.prompts[0].id,inputs:{source_notes:'x'.repeat(100000)},targets}),/workspace storage/);assert.equal(calls,0);assert.equal(state.comparisons.length,0);}finally{globalThis.fetch=previous;}
});

