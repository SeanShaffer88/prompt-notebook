import {test} from 'node:test';
import assert from 'node:assert/strict';
import seed from '../lib/seed.json' with {type:'json'};
import {callModel,normalizeKeys} from '../lib/providers.mjs';
import {notebookService} from '../lib/notebook-service.mjs';

test('OpenAI uses Responses API with header-only key, store:false, normalized output and usage',async()=>{
 let req;const run=await callModel('Hello',{maxTokens:512},{provider:'openai',key:'test-openai',model:'gpt-4.1-mini'},async(url,init)=>{req={url,...init};return {ok:true,json:async()=>({status:'completed',model:'gpt-4.1-mini',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'One'},{type:'output_text',text:'Two'}]}],usage:{input_tokens:7,output_tokens:3}})};});
 assert.equal(req.url,'https://api.openai.com/v1/responses');assert.equal(req.headers.Authorization,'Bearer test-openai');assert.ok(!req.headers['x-api-key']);assert.deepEqual(JSON.parse(req.body),{model:'gpt-4.1-mini',input:'Hello',max_output_tokens:512,store:false});assert.equal(run.output,'One\nTwo');assert.equal(run.provider,'openai');assert.equal(run.usage.input_tokens,7);assert.ok(!req.url.includes('test-openai'));
});
test('Gemini uses its fixed endpoint and key header, excludes thought text and normalizes tokens',async()=>{
 let req;const run=await callModel('Hi',{maxTokens:256},{provider:'gemini',key:'test-gemini',model:'gemini-3.8-flash'},async(url,init)=>{req={url,...init};return {ok:true,json:async()=>({modelVersion:'gemini-3.8-flash',candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'Private reasoning',thought:true},{text:'Visible response'}]}}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:4,thoughtsTokenCount:2}})};});
 assert.equal(req.url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');assert.equal(req.headers['x-goog-api-key'],'test-gemini');assert.ok(!req.url.includes('test-gemini'));assert.equal(JSON.parse(req.body).generationConfig.maxOutputTokens,256);assert.equal(run.output,'Visible response');assert.equal(run.usage.output_tokens,6);assert.equal(run.stopReason,'max_tokens');
});
test('invalid providers/models, redirects, refusals and provider errors never leak secrets or become samples',async()=>{
 await assert.rejects(callModel('x',{}, {provider:'evil',key:'secret'}),/Choose Anthropic/);
 await assert.rejects(callModel('x',{model:'https://evil.test'}, {provider:'gemini',key:'secret'}),/model ID/);
 const fake=async()=>({ok:false,status:429,json:async()=>({error:{message:'secret'}})});
 await assert.rejects(callModel('x',{}, {provider:'openai',key:'secret'},fake),e=>e.message.includes('HTTP 429')&&!e.message.includes('secret'));
 await assert.rejects(callModel('x',{}, {provider:'gemini',key:'secret'},async()=>({ok:true,json:async()=>({candidates:[{finishReason:'SAFETY'}]})})),/no text/);
 await assert.rejects(callModel('x',{}, {provider:'openai',key:'secret'},async()=>({ok:true,json:async()=>({output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]})})),/no text/);
 assert.throws(()=>normalizeKeys({evil:'secret'}));assert.throws(()=>normalizeKeys([]));
});
test('version provider pins survive preference changes; missing workflow keys fail before any call',async()=>{
 const state=structuredClone(seed),api=notebookService(state).route,p=state.prompts[0];
 await api('POST','/api/settings',{provider:'openai',model:'gpt-4.1-mini'});
 const a=await api('POST',`/api/prompts/${p.id}/versions`,{template:'Summarize {{source_notes}}',note:'OpenAI version'});
 assert.equal(a.provider,'openai');assert.equal(a.model,'gpt-4.1-mini');
 await api('POST','/api/settings',{provider:'gemini',model:'gemini-3.8-flash'});
 assert.equal(state.versions.find(v=>v.id===p.activeVersionId).provider,'anthropic');assert.equal(a.provider,'openai');
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Should not call');};
 try{await assert.rejects(notebookService(state,{openai:'test-key'}).route('POST',`/api/workflows/${state.workflows[0].id}/run`,{input:'notes'}),/Anthropic key/);assert.equal(calls,0);}finally{globalThis.fetch=original;}
 assert.ok(!JSON.stringify(state).includes('test-key'));
});
test('mixed-provider workflow forwards only the corresponding key and records each provider',async()=>{
 const state=structuredClone(seed),api=notebookService(state).route,w=state.workflows[0];
 const a=await api('POST',`/api/prompts/${w.promptIds[0]}/versions`,{provider:'openai',model:'gpt-4.1-mini',template:'Summarize {{notes}}'});
 const b=await api('POST',`/api/prompts/${w.promptIds[1]}/versions`,{provider:'gemini',model:'gemini-3.8-flash',template:'Memo {{brief}}'});
 await api('POST',`/api/prompts/${a.promptId}/activate`,{versionId:a.id});await api('POST',`/api/prompts/${b.promptId}/activate`,{versionId:b.id});
 const old=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,init)=>{requests.push({url,...init});return {ok:true,json:async()=>url.includes('openai.com')?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Brief result'}]}]}:{candidates:[{content:{parts:[{text:'Memo result'}]},finishReason:'STOP'}]}};};
 try{const result=await notebookService(state,{openai:'openai-secret',gemini:'gemini-secret'}).route('POST',`/api/workflows/${w.id}/run`,{input:'notes'});assert.equal(result.status,'complete');assert.equal(requests[0].headers.Authorization,'Bearer openai-secret');assert.equal(requests[1].headers['x-goog-api-key'],'gemini-secret');assert.ok(!JSON.stringify(requests[0]).includes('gemini-secret'));assert.ok(!JSON.stringify(requests[1]).includes('openai-secret'));assert.deepEqual(state.runs.map(r=>r.provider),['openai','gemini']);assert.ok(!JSON.stringify(state).includes('secret'));}finally{globalThis.fetch=old;}
});
