import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, fill, evaluate } from '../lib/notebook.mjs';
import { createNotebookServer } from '../server.mjs';
import { callModel } from '../lib/provider.mjs';

test('template substitution does not recursively interpret user input; missing input fails',()=>{
  assert.equal(fill('Text: {{input}}',{input:'{{another}}'}),'Text: {{another}}');
  assert.throws(()=>fill('{{missing}}',{}),/Provide a value/);
  assert.throws(()=>fill('{{toString}}',{}),/Provide a value/);
});
test('rule checks report failures and unscored examples distinctly',()=>{
  assert.equal(evaluate('Evidence uncertain',{contains:'evidence',excludes:'proven',maxWords:3}).pass,true);
  assert.equal(evaluate('It is proven',{excludes:'proven'}).pass,false);
  assert.equal(evaluate('anything',{}).pass,null);
  assert.equal(evaluate('{"a":1}',{json:true}).pass,true);
  assert.equal(evaluate('not json',{json:true}).pass,false);
});
test('SQLite writes persist after reopen and failed mutations roll back',()=>{
  const dir=mkdtempSync(join(tmpdir(),'notebook-test-'));const file=join(dir,'db.sqlite');let store=openStore(file);
  const before=store.read().prompts.length;assert.throws(()=>store.mutate(s=>{s.prompts.push({id:'bad'});throw Error('rollback');}));assert.equal(store.read().prompts.length,before);
  store.mutate(s=>s.prompts[0].title='Persistent title');store.close();store=openStore(file);assert.equal(store.read().prompts[0].title,'Persistent title');store.close();rmSync(dir,{recursive:true});
});
test('provider sends credentials only as headers, parses text and handles failures',async()=>{
  let request;const result=await callModel('hello',{model:'test',maxTokens:100},{key:'secret',base:'https://example.test/v1',model:'default'},async(url,options)=>{request={url,...options};return {ok:true,json:async()=>({content:[{type:'text',text:'real text'}],model:'test',usage:{input_tokens:1,output_tokens:2}})};});
  assert.equal(request.url,'https://example.test/v1/messages');assert.equal(request.headers['x-api-key'],'secret');assert.equal(JSON.parse(request.body).max_tokens,100);assert.equal(result.output,'real text');assert.ok(!request.body.includes('secret'));
  await assert.rejects(callModel('x',{}, {key:'',base:'https://example.test'}),/No provider key/);
  await assert.rejects(callModel('x',{}, {key:'secret',base:'https://example.test'},async()=>({ok:false,status:401,json:async()=>({error:{message:'secret'}})})),/HTTP 401/);
});
test('HTTP end-to-end: versions, correction, suggested candidate, tests, experiments, workflow staleness, export',async(t)=>{
  let calls=0;const server=createNotebookServer({dataFile:':memory:',config:{key:'test-secret',base:'https://example.test',model:'test-model'},modelCall:async(prompt)=>{calls++;return {output:prompt.startsWith('You improve')?'Use measured evidence only.\n\n{{source_notes}}':'Evidence is limited. Test further.',model:'test-model',usage:{input_tokens:10,output_tokens:7},latencyMs:2};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
  async function api(path,body){const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-notebook-request':'1'},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;}
  let s=await api('/api/state');assert.equal(s.prompts.length,3);const p=s.prompts[0],original=s.versions.find(v=>v.id===p.activeVersionId);assert.ok(!JSON.stringify(s).includes('test-secret'));
  const run=await api(`/api/prompts/${p.id}/run`,{inputs:{source_notes:'8/12 prefer; productivity not measured.'}});assert.equal(run.status,'complete');
  const c=await api('/api/corrections',{runId:run.id,corrected:'Preference only; productivity unknown.',reason:'Do not infer unmeasured outcomes.'});
  const suggest=await api(`/api/corrections/${c.id}/suggest`,{});const candidate=await api(`/api/prompts/${p.id}/versions`,{template:suggest.template,note:'From correction',correctionId:c.id});
  const testCase=await api(`/api/prompts/${p.id}/tests`,{title:'Evidence test',inputs:{source_notes:'pilot'},expected:'Limited evidence',checks:{contains:'evidence',excludes:'proven'}});
  const exp=await api('/api/experiments',{promptId:p.id,versionIds:[original.id,candidate.id],testIds:[testCase.id]});assert.equal(exp.results.length,2);assert.ok(exp.results.every(r=>r.pass));
  const w=s.workflows[0];await api(`/api/workflows/${w.id}/run`,{input:'Pilot notes'});s=await api('/api/state');assert.equal(s.workflows[0].status,'Current');
  await api(`/api/prompts/${p.id}/activate`,{versionId:candidate.id});s=await api('/api/state');assert.equal(s.workflows[0].status,'Needs retest');assert.equal(s.workflows[0].affected.length,2);assert.equal(s.versions.find(v=>v.id===original.id).template,original.template);
  await api(`/api/workflows/${w.id}/run`,{input:'Pilot notes'});s=await api('/api/export');assert.equal(s.workflowRuns.length,2);assert.ok(!JSON.stringify(s).includes('test-secret'));assert.equal(calls,8);
  const blocked=await fetch(base+'/api/settings',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test','x-notebook-request':'1'},body:'{}'});assert.equal(blocked.status,403);
  const noHeader=await fetch(base+'/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(noHeader.status,403);
});
test('failed workflow retains successful prefix and failed run; no misleading completion',async(t)=>{
  let calls=0;const server=createNotebookServer({dataFile:':memory:',modelCall:async()=>{if(++calls===2)throw Object.assign(Error('provider unavailable'),{status:502});return {output:'First step result',model:'test'};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
  const s=await (await fetch(base+'/api/state')).json();const response=await fetch(base+`/api/workflows/${s.workflows[0].id}/run`,{method:'POST',headers:{'content-type':'application/json','x-notebook-request':'1'},body:JSON.stringify({input:'notes'})});assert.equal(response.status,502);
  const after=await(await fetch(base+'/api/state')).json();assert.equal(after.workflowRuns[0].status,'failed');assert.equal(after.workflowRuns[0].steps.length,1);assert.equal(after.runs[1].status,'failed');assert.equal(after.workflows[0].status,'Not run');
});
