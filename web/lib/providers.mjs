import { requireValue } from './notebook-core.mjs';

export const PROVIDERS=Object.freeze([
  Object.freeze({id:'anthropic',name:'Anthropic',defaultModel:'claude-haiku-4-5',host:'api.anthropic.com',protocol:'anthropic',endpoint:'https://api.anthropic.com/v1/messages'}),
  Object.freeze({id:'openai',name:'OpenAI',defaultModel:'gpt-4.1-mini',host:'api.openai.com',protocol:'responses',endpoint:'https://api.openai.com/v1/responses'}),
  Object.freeze({id:'gemini',name:'Gemini',defaultModel:'gemini-3.8-flash',host:'generativelanguage.googleapis.com',protocol:'gemini'}),
  Object.freeze({id:'openrouter',name:'OpenRouter',defaultModel:'openai/gpt-4.1-mini',host:'openrouter.ai',protocol:'chat',endpoint:'https://openrouter.ai/api/v1/chat/completions'}),
  Object.freeze({id:'groq',name:'Groq',defaultModel:'llama-3.3-70b-versatile',host:'api.groq.com',protocol:'chat',endpoint:'https://api.groq.com/openai/v1/chat/completions'}),
  Object.freeze({id:'mistral',name:'Mistral',defaultModel:'mistral-small-latest',host:'api.mistral.ai',protocol:'chat',endpoint:'https://api.mistral.ai/v1/chat/completions'}),
  Object.freeze({id:'deepseek',name:'DeepSeek',defaultModel:'deepseek-flash',host:'api.deepseek.com',protocol:'chat',endpoint:'https://api.deepseek.com/chat/completions'}),
  Object.freeze({id:'xai',name:'xAI / Grok',defaultModel:'grok-4.7',host:'api.x.ai',protocol:'responses',endpoint:'https://api.x.ai/v1/responses'}),
  Object.freeze({id:'together',name:'Together AI',defaultModel:'Qwen/Qwen3.5-9B',host:'api.together.ai',protocol:'chat',endpoint:'https://api.together.ai/v1/chat/completions'}),
  Object.freeze({id:'fireworks',name:'Fireworks AI',defaultModel:'accounts/fireworks/models/kimi-k2-instruct-0905',host:'api.fireworks.ai',protocol:'chat',endpoint:'https://api.fireworks.ai/inference/v1/chat/completions'}),
  Object.freeze({id:'cerebras',name:'Cerebras',defaultModel:'gpt-oss-120b',host:'api.cerebras.ai',protocol:'chat',endpoint:'https://api.cerebras.ai/v1/chat/completions'}),
  Object.freeze({id:'sambanova',name:'SambaNova',defaultModel:'Meta-Llama-3.3-70B-Instruct',host:'api.sambanova.ai',protocol:'chat',endpoint:'https://api.sambanova.ai/v1/chat/completions'}),
  Object.freeze({id:'nvidia',name:'NVIDIA NIM',defaultModel:'meta/llama-3.3-70b-instruct',host:'integrate.api.nvidia.com',protocol:'chat',endpoint:'https://integrate.api.nvidia.com/v1/chat/completions'}),
]);
export function providerInfo(id='anthropic'){
  const provider=PROVIDERS.find(p=>p.id===id);
  requireValue(provider,'Choose a supported provider from Settings.');return provider;
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
export function validateModelId(model){
  requireValue(typeof model==='string' && /^[a-zA-Z0-9~][a-zA-Z0-9._:/~-]{0,199}$/.test(model) && !model.includes('://') && !model.includes('..') && !model.endsWith(':batch'),'Use an interactive model ID, not a URL or batch-only model.');
  return model;
}
export async function callModel(prompt, options, config, fetcher=fetch){
  const provider=providerInfo(config.provider),model=options.model || config.model || provider.defaultModel;
  requireValue(config.key,`Connect a ${provider.name} key in Settings before running this version.`,422);
  validateModelId(model);
  const limit=Math.min(options.maxTokens || 1000,4096);
  let url,body,headers={'content-type':'application/json'};
  if(provider.protocol==='anthropic'){
    url=provider.endpoint;headers['x-api-key']=config.key;headers['anthropic-version']='2023-06-01';
    body={model,max_tokens:limit,messages:[{role:'user',content:prompt}]};
  }else if(provider.protocol==='responses'){
    url=provider.endpoint;headers.Authorization=`Bearer ${config.key}`;
    body={model,input:prompt,max_output_tokens:limit,store:false};
  }else if(provider.protocol==='gemini'){
    url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers['x-goog-api-key']=config.key;
    body={contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:limit}};
  }else{
    url=provider.endpoint;headers.Authorization=`Bearer ${config.key}`;
    body={model,messages:[{role:'user',content:prompt}],max_tokens:limit,stream:false};
  }
  const start=Date.now();let response;
  // Workers supports manual/follow, not redirect:error. Manual keeps credentials
  // on the selected origin; any 3xx response is rejected by the HTTP check below.
  try{response=await fetcher(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(45000),headers,body:JSON.stringify(body)});}
  catch(error){throw Object.assign(new Error(error.name==='TimeoutError'?`${provider.name} request timed out. Try a faster model or fewer examples.`:`Could not connect to ${provider.name}.`),{status:502,retryable:true});}
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(`${provider.name} request failed (HTTP ${response.status}). Check this provider's key, model access, or quota.`),{status:502,upstreamStatus:response.status,retryable:response.status===429||response.status>=500});
  requireValue(!data.error && data.status!=='failed',`${provider.name} could not complete the response.`,502);
  let output,usage,stopReason,actualModel;
  if(provider.protocol==='anthropic'){
    output=(data.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');usage=data.usage || {};stopReason=data.stop_reason;actualModel=data.model;
  }else if(provider.protocol==='responses'){
    output=(data.output || []).filter(item=>item.type==='message').flatMap(item=>item.content || []).filter(part=>part.type==='output_text').map(part=>part.text).join('\n');
    usage=data.usage || {};stopReason=data.incomplete_details?.reason==='max_output_tokens'?'max_tokens':data.status;actualModel=data.model;
  }else if(provider.protocol==='gemini'){
    const candidate=data.candidates?.[0];output=(candidate?.content?.parts || []).filter(part=>typeof part.text==='string' && !part.thought).map(part=>part.text).join('\n');
    const u=data.usageMetadata || {};usage={input_tokens:u.promptTokenCount || 0,output_tokens:(u.candidatesTokenCount || 0)+(u.thoughtsTokenCount || 0)};
    stopReason=candidate?.finishReason==='MAX_TOKENS'?'max_tokens':candidate?.finishReason;actualModel=data.modelVersion;
  }else{
    const choice=data.choices?.[0],content=choice?.message?.content;
    output=typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';
    usage={...(data.usage || {}),input_tokens:data.usage?.prompt_tokens || 0,output_tokens:data.usage?.completion_tokens || 0};
    stopReason=choice?.finish_reason==='length'?'max_tokens':choice?.finish_reason;actualModel=data.model;
  }
  requireValue(typeof output==='string' && output.trim(),`${provider.name} returned no text. The response may have been blocked, refused, or exhausted its output budget.`,502);
  return {output,provider:provider.id,model:actualModel || model,usage,latencyMs:Date.now()-start,stopReason:stopReason || null};
}
