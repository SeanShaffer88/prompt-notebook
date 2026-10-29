import {PROVIDERS} from './providers.mjs';
import snapshot from './model-snapshot.json' with {type:'json'};
export function normalizeRouterModels(rows){
  const unique=new Map();
  for(const model of Array.isArray(rows)?rows:[]){
    if(typeof model.id!=='string' || model.id.length>200 || model.id.endsWith(':batch') || !/^[a-zA-Z0-9~][a-zA-Z0-9._:/~-]*$/.test(model.id) || model.id.includes('..') || model.id.includes('://'))continue;
    if(!model.architecture?.input_modalities?.includes('text') || !model.architecture?.output_modalities?.includes('text'))continue;
    unique.set(model.id,{id:model.id,name:String(model.name || model.id).slice(0,160),provider:'openrouter',contextLength:Number.isFinite(model.context_length)?model.context_length:null});
    if(unique.size>=1500)break;
  }
  return [...unique.values()];
}
let cached,pending;
const publicFetch=(url,options)=>globalThis.fetch(url,options);
export async function modelCatalog(fetcher=publicFetch){
  if(fetcher===publicFetch && cached && Date.now()-cached.at<600000)return cached.value;
  if(pending)return pending;
  pending=(async()=>{
    let models=snapshot.models,source='snapshot',updatedAt=snapshot.updatedAt;
    try{
      const response=await fetcher('https://openrouter.ai/api/v1/models',{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
      if(!response.ok)throw Error('Catalog unavailable');const data=await response.json();const live=normalizeRouterModels(data.data);
      if(!live.length)throw Error('Empty catalog');models=live;source='live';updatedAt=new Date().toISOString();
    }catch(error){console.warn('Public model catalog refresh failed:',error instanceof Error?error.message:'unknown error');}
    const defaults=PROVIDERS.filter(p=>p.id!=='openrouter').map(p=>({id:p.defaultModel,name:p.defaultModel,provider:p.id,contextLength:null}));
    const value={models:[...defaults,...models],providers:PROVIDERS.map(p=>({id:p.id,name:p.name})),source,updatedAt,note:'OpenRouter catalog plus direct-provider starter models. Availability and billing depend on your account. Batch-only and non-text models are excluded.'};
    if(fetcher===publicFetch)cached={at:Date.now(),value};return value;
  })();
  try{return await pending;}finally{pending=undefined;}
}
