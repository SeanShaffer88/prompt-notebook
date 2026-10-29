import {test} from 'node:test';
import assert from 'node:assert/strict';
import seed from '../lib/seed.json' with {type:'json'};
import {notebookService} from '../lib/notebook-service.mjs';
const targets=[{provider:'openai',model:'gpt-4.1-mini'},{provider:'openai',model:'gpt-4.1'}];
const output=text=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:5,output_tokens:7}})});

async function reviewed(state){const service=notebookService(state),prompt=state.prompts[0];const c=await service.route('POST','/api/comparisons',{promptId:prompt.id,inputs:{source_notes:'review notes'},targets});await service.route('POST',`/api/comparisons/${c.id}/rate`,{runId:c.results[0].runId,rating:5});await service.route('POST',`/api/comparisons/${c.id}/winner`,{runId:c.results[0].runId});return {service,c,prompt};}

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
