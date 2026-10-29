import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PROVIDERS,callModel} from '../lib/providers.mjs';
import {normalizeRouterModels,modelCatalog} from '../lib/model-catalog.mjs';

for(const provider of PROVIDERS.filter(p=>p.protocol==='chat'))test(`${provider.name}: fixed destination, isolated bearer key, model IDs and normalized text`,async()=>{
 let request;const key='test-key-for-'+provider.id;
 const result=await callModel('Test',{maxTokens:256},{provider:provider.id,key,model:provider.defaultModel},async(url,init)=>{request={url,...init};return {ok:true,json:async()=>({model:provider.defaultModel,choices:[{finish_reason:'length',message:{content:'Answer',reasoning_content:'Not for output'}}],usage:{prompt_tokens:7,completion_tokens:9}})};});
 assert.equal(request.url,provider.endpoint);assert.equal(request.headers.Authorization,'Bearer '+key);assert.equal(request.redirect,'error');assert.deepEqual(JSON.parse(request.body),{model:provider.defaultModel,messages:[{role:'user',content:'Test'}],max_tokens:256,stream:false});assert.equal(result.output,'Answer');assert.equal(result.provider,provider.id);assert.equal(result.usage.input_tokens,7);assert.equal(result.usage.output_tokens,9);assert.equal(result.stopReason,'max_tokens');assert.ok(!JSON.stringify(result).includes(key));
});
test('xAI uses its own Responses endpoint and key',async()=>{
 let request;const run=await callModel('Test',{}, {provider:'xai',key:'test-xai'},async(url,init)=>{request={url,...init};return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Grok answer'}]}]})};});
 assert.equal(request.url,'https://api.x.ai/v1/responses');assert.equal(request.headers.Authorization,'Bearer test-xai');assert.equal(JSON.parse(request.body).store,false);assert.equal(run.provider,'xai');
});
test('catalog excludes batch-only, non-text, duplicate and malformed IDs',()=>{
 const valid={id:'maker/model',name:'Useful model',context_length:128000,architecture:{input_modalities:['text'],output_modalities:['text']}};
 const models=normalizeRouterModels([valid,valid,{...valid,id:'maker/model:batch'},{...valid,id:'image/model',architecture:{input_modalities:['text'],output_modalities:['image']}},{...valid,id:'https://evil.test/model'},{...valid,id:'../private'}]);
 assert.equal(models.length,1);assert.equal(models[0].provider,'openrouter');assert.equal(models[0].contextLength,128000);
});
test('public catalog is keyless and labels direct-provider starters separately',async()=>{
 let request;const result=await modelCatalog(async(url,init)=>{request={url,...init};return {ok:true,json:async()=>({data:[{id:'test/model',name:'Test',architecture:{input_modalities:['text'],output_modalities:['text']}}]})};});
 assert.equal(request.url,'https://openrouter.ai/api/v1/models');assert.ok(!request.headers.Authorization);assert.equal(result.source,'live');assert.equal(result.providers.length,13);assert.equal(result.models.length,13);assert.ok(result.models.some(m=>m.provider==='openrouter'&&m.id==='test/model'));
});
test('catalog outage retains a dated, usable snapshot',async()=>{
 const result=await modelCatalog(async()=>{throw Error('offline');});assert.equal(result.source,'snapshot');assert.ok(result.models.length>100);assert.ok(result.updatedAt);assert.ok(result.models.every(m=>m.provider && m.id));
});
test('batch-only IDs and arbitrary URL models are rejected before a network call',async()=>{
 const noFetch=()=>{throw Error('Unexpected fetch');};
 await assert.rejects(callModel('x',{model:'openai/gpt:batch'},{provider:'openrouter',key:'test'},noFetch),/interactive model ID/);
 await assert.rejects(callModel('x',{model:'https://evil.test'},{provider:'openrouter',key:'test'},noFetch),/interactive model ID/);
});
