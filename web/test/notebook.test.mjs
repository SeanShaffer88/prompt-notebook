import {test} from 'node:test';
import assert from 'node:assert/strict';
import seed from '../lib/seed.json' with {type:'json'};
import {notebookService} from '../lib/notebook-service.mjs';
test('sample mode completes correction, comparison and workflow without external calls',async()=>{
 const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Unexpected network call');};
 try{
 const state=structuredClone(seed),api=notebookService(state).route,p=state.prompts[0];
 const run=await api('POST',`/api/prompts/${p.id}/run`,{inputs:{source_notes:'pilot'}});assert.equal(run.simulated,true);
 const correction=await api('POST','/api/corrections',{runId:run.id,corrected:'Preference is not productivity.',reason:'No unsupported inference.'});
 const suggestion=await api('POST',`/api/corrections/${correction.id}/suggest`,{});
 const candidate=await api('POST',`/api/prompts/${p.id}/versions`,{template:suggestion.template,correctionId:correction.id});
 const example=await api('POST',`/api/prompts/${p.id}/tests`,{title:'Evidence',inputs:{source_notes:'pilot'},checks:{contains:'productivity'}});
 const exp=await api('POST','/api/experiments',{promptId:p.id,versionIds:[p.activeVersionId,candidate.id],testIds:[example.id]});assert.equal(exp.status,'complete');assert.equal(exp.results.length,2);
 await api('POST',`/api/workflows/${state.workflows[0].id}/run`,{input:'pilot'});
 await api('POST',`/api/prompts/${p.id}/activate`,{versionId:candidate.id});assert.equal((await api('GET','/api/state',{})).workflows[0].status,'Needs retest');
 }finally{globalThis.fetch=originalFetch;}
});
test('live requests use only Anthropic and do not persist keys; failures do not become sample answers',async()=>{
 const originalFetch=globalThis.fetch,secret='test-only-provider-key';let request;
 globalThis.fetch=async(url,init)=>{request={url,...init};return {ok:true,json:async()=>({content:[{type:'text',text:'Live result'}],model:'test-model',usage:{input_tokens:4,output_tokens:2}})};};
 try{const state=structuredClone(seed),api=notebookService(state,secret).route;
 const run=await api('POST',`/api/prompts/${state.prompts[0].id}/run`,{inputs:{source_notes:'pilot'}});
 assert.equal(run.output,'Live result');assert.equal(request.url,'https://api.anthropic.com/v1/messages');assert.equal(request.headers['x-api-key'],secret);assert.ok(!JSON.stringify(state).includes(secret));
 globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({})});
 await assert.rejects(api('POST',`/api/prompts/${state.prompts[0].id}/run`,{inputs:{source_notes:'pilot'}}),/HTTP 401/);assert.equal(state.runs.at(-1).status,'failed');
 }finally{globalThis.fetch=originalFetch;}
});
test('each visitor state is independent and settings cannot select a custom proxy',async()=>{
 const a=structuredClone(seed),b=structuredClone(seed);const api=notebookService(a).route;
 await api('POST','/api/prompts',{title:'Only visitor A'});assert.equal(a.prompts.length,b.prompts.length+1);
 await api('POST','/api/settings',{model:'test-model',base:'http://localhost:11434',apiKey:'never-store-this'});
 assert.deepEqual(a.settings,{model:'test-model'});assert.ok(!JSON.stringify(a).includes('never-store-this'));assert.ok(!a.settings.base);
});
