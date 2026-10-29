import { requireValue } from './notebook-core.mjs';

export const PROVIDERS=Object.freeze([
  Object.freeze({id:'anthropic',name:'Anthropic',defaultModel:'claude-haiku-4-5',host:'api.anthropic.com'}),
  Object.freeze({id:'openai',name:'OpenAI',defaultModel:'gpt-4.1-mini',host:'api.openai.com'}),
  Object.freeze({id:'gemini',name:'Gemini',defaultModel:'gemini-3.8-flash',host:'generativelanguage.googleapis.com'}),
]);
export function providerInfo(id='anthropic'){
  const provider=PROVIDERS.find(p=>p.id===id);
  requireValue(provider,'Choose Anthropic, OpenAI, or Gemini.');return provider;
}
export function normalizeKeys(input){
  requireValue(input && typeof input==='object' && !Array.isArray(input),'Invalid provider keys.');
  const keys=Object.create(null);
  for(const [id,key] of Object.entries(input)){
    providerInfo(id);requireValue(typeof key==='string' && key.length<=1000,'Invalid provider key.');
    if(key.trim())keys[id]=key.trim();
  }
  return keys;
}
export async function callModel(prompt, options, config, fetcher=fetch){
  const provider=providerInfo(config.provider),model=options.model || config.model || provider.defaultModel;
  requireValue(config.key,`Connect a ${provider.name} key in Settings before running this version.`,422);
  requireValue(typeof model==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(model),'Use a model ID, not a URL or path.');
  const limit=Math.min(options.maxTokens || 1000,4096);
  let url,body,headers={'content-type':'application/json'};
  if(provider.id==='anthropic'){
    url='https://api.anthropic.com/v1/messages';headers['x-api-key']=config.key;headers['anthropic-version']='2023-06-01';
    body={model,max_tokens:limit,messages:[{role:'user',content:prompt}]};
  }else if(provider.id==='openai'){
    url='https://api.openai.com/v1/responses';headers.Authorization=`Bearer ${config.key}`;
    body={model,input:prompt,max_output_tokens:limit,store:false};
  }else{
    url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers['x-goog-api-key']=config.key;
    body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:limit}};
  }
  const start=Date.now();let response;
  try{response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),headers,body:JSON.stringify(body)});}
  catch(error){throw Object.assign(new Error(error.name==='TimeoutError'?`${provider.name} request timed out. Try a faster model or fewer examples.`:`Could not connect to ${provider.name}.`),{status:502});}
  const data=await response.json().catch(()=>({}));
  requireValue(response.ok,`${provider.name} request failed (HTTP ${response.status}). Check this provider's key, model access, or quota.`,502);
  requireValue(!data.error && data.status!=='failed',`${provider.name} could not complete the response.`,502);
  let output,usage,stopReason,actualModel;
  if(provider.id==='anthropic'){
    output=(data.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');usage=data.usage || {};stopReason=data.stop_reason;actualModel=data.model;
  }else if(provider.id==='openai'){
    output=(data.output || []).filter(item=>item.type==='message').flatMap(item=>item.content || []).filter(part=>part.type==='output_text').map(part=>part.text).join('\n');
    usage=data.usage || {};stopReason=data.incomplete_details?.reason==='max_output_tokens'?'max_tokens':data.status;actualModel=data.model;
  }else{
    const candidate=data.candidates?.[0];output=(candidate?.content?.parts || []).filter(part=>typeof part.text==='string' && !part.thought).map(part=>part.text).join('\n');
    const u=data.usageMetadata || {};usage={input_tokens:u.promptTokenCount || 0,output_tokens:(u.candidatesTokenCount || 0)+(u.thoughtsTokenCount || 0)};
    stopReason=candidate?.finishReason==='MAX_TOKENS'?'max_tokens':candidate?.finishReason;actualModel=data.modelVersion;
  }
  requireValue(typeof output==='string' && output.trim(),`${provider.name} returned no text. The response may have been blocked, refused, or exhausted its output budget.`,502);
  return {output,provider:provider.id,model:actualModel || model,usage,latencyMs:Date.now()-start,stopReason:stopReason || null};
}
