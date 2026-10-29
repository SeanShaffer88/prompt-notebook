import {test} from 'node:test';
import assert from 'node:assert/strict';
import seed from '../lib/seed.json' with {type:'json'};
import {notebookService} from '../lib/notebook-service.mjs';
const targets=[{provider:'openai',model:'gpt-4.1-mini'},{provider:'openai',model:'gpt-4.1'}];
const output=text=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:5,output_tokens:7}})});
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
