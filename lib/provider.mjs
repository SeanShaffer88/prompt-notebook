import { requireValue } from './notebook.mjs';
export function providerConfig(env = process.env) {
  return { key:env.ANTHROPIC_API_KEY || '', base:env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', model:env.ANTHROPIC_MODEL || 'claude-haiku-4-5' };
}
export async function callModel(prompt, options, config, fetcher = fetch) {
  const localOllama = ['127.0.0.1','localhost'].includes(new URL(config.base).hostname) && new URL(config.base).port === '11434';
  requireValue(config.key || localOllama, 'No provider key configured. Open Settings to connect a provider, or set ANTHROPIC_API_KEY in .env.', 422);
  const base = config.base.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  const start = Date.now();
  let response;
  try { response = await fetcher(url, { method:'POST', signal:AbortSignal.timeout(120000), headers:{'content-type':'application/json','x-api-key':config.key || 'ollama','anthropic-version':'2023-06-01'}, body:JSON.stringify({model:options.model || config.model,max_tokens:options.maxTokens || 1000,...(localOllama?{thinking:{type:'disabled'}}:{}),messages:[{role:'user',content:prompt}]}) }); }
  catch(e) { throw Object.assign(new Error(e.name==='TimeoutError'?'Model request timed out after two minutes.':'Could not connect to the configured model provider.'),{status:502}); }
  const data = await response.json().catch(()=>({}));
  requireValue(response.ok, `Provider request failed (HTTP ${response.status}). Check your key, model, endpoint, or quota.`,502);
  const output = (data.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  requireValue(output.trim(), 'Provider returned no text.',502);
  return {output, model:data.model || options.model || config.model, usage:data.usage || {}, latencyMs:Date.now()-start, stopReason:data.stop_reason || null};
}
