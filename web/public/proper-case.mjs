const names=new Map(Object.entries({am:'AM',pm:'PM',utc:'UTC',ai:'AI',api:'API',apis:'APIs',json:'JSON',ui:'UI',usd:'USD',id:'ID',ids:'IDs',llm:'LLM',llms:'LLMs',url:'URL',urls:'URLs',html:'HTML',css:'CSS',sql:'SQL',pdf:'PDF',http:'HTTP',https:'HTTPS',byok:'BYOK',openai:'OpenAI',openrouter:'OpenRouter',deepseek:'DeepSeek',xai:'xAI',sambanova:'SambaNova',nvidia:'NVIDIA',nim:'NIM',sqlite:'SQLite',github:'GitHub',javascript:'JavaScript',typescript:'TypeScript'}));
export function properCaseLabel(value,identifiers=new Set()){
 return String(value).replace(/\{\{[^}]*\}\}|https?:\/\/\S+|[A-Za-z][A-Za-z0-9_./:+’'-]*/g,token=>{
  if(token.startsWith('{{')||/^https?:/.test(token)||identifiers.has(token)||/[0-9_]/.test(token))return token;
  return token.replace(/[A-Za-z]+(?:['’][A-Za-z]+)?/g,word=>names.get(word.toLowerCase()) || word[0].toUpperCase()+word.slice(1).toLowerCase());
 });
}
if(typeof document!=='undefined'){
 const targets='h1,h2,h3,h4,h5,h6,button,.button,summary,title,th,legend,[role="heading"],header > a,header > span,.brand,.shelf-title,[role="tab"]';let scheduled=false;
 function apply(){scheduled=false;const identifiers=new Set();try{if(data){for(const v of data.versions || [])if(v.model)identifiers.add(v.model);for(const r of data.runs || []){if(r.model)identifiers.add(r.model);if(r.requestedModel)identifiers.add(r.requestedModel);}for(const c of data.comparisons || [])for(const r of c.results)identifiers.add(r.model);for(const rule of data.routingRules || [])for(const t of rule.targets)identifiers.add(t.model);for(const p of data.providers || [])identifiers.add(p.defaultModel);}}catch{}
  for(const el of document.querySelectorAll(targets)){const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.parentElement?.closest('code,pre,textarea,script,style'))continue;const next=properCaseLabel(node.nodeValue,identifiers);if(next!==node.nodeValue)node.nodeValue=next;}for(const key of ['aria-label','title'])if(el.hasAttribute(key)){const before=el.getAttribute(key),after=properCaseLabel(before,identifiers);if(before!==after)el.setAttribute(key,after);}}
 }
 apply();new MutationObserver(()=>{if(!scheduled){scheduled=true;queueMicrotask(apply);}}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title']});
}
