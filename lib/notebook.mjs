import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function requireValue(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function text(value, name, max = 60000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} must contain 1–${max} characters.`);
  return value.trim();
}
export const variables = prompt => [...new Set([...prompt.matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)].map(m => m[1]))];
export function fill(template, inputs) {
  requireValue(inputs && typeof inputs === 'object' && !Array.isArray(inputs), 'Inputs must be an object.');
  return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_, name) => {
    requireValue(Object.hasOwn(inputs, name) && typeof inputs[name] === 'string' && inputs[name].trim(), `Provide a value for ${name}.`);
    return inputs[name];
  });
}
export function evaluate(output, checks = {}) {
  const results = [];
  if (checks.contains?.trim()) for (const term of checks.contains.split('\n').map(s => s.trim()).filter(Boolean)) results.push({ name: `Contains: ${term}`, pass: output.toLowerCase().includes(term.toLowerCase()) });
  if (checks.excludes?.trim()) for (const term of checks.excludes.split('\n').map(s => s.trim()).filter(Boolean)) results.push({ name: `Excludes: ${term}`, pass: !output.toLowerCase().includes(term.toLowerCase()) });
  if (checks.maxWords) results.push({ name: `At most ${checks.maxWords} words`, pass: output.trim().split(/\s+/).length <= checks.maxWords });
  if (checks.json) { let pass = true; try { JSON.parse(output); } catch { pass = false; } results.push({ name: 'Valid JSON', pass }); }
  return { results, pass: results.length ? results.every(r => r.pass) : null };
}
export function cleanChecks(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Checks must be an object.');
  const maxWords = value.maxWords ? Number(value.maxWords) : null;
  requireValue(maxWords === null || (Number.isInteger(maxWords) && maxWords > 0 && maxWords <= 100000), 'Word limit must be a positive integer.');
  requireValue(!value.contains || typeof value.contains === 'string', 'Contains checks must be text.');
  requireValue(!value.excludes || typeof value.excludes === 'string', 'Excludes checks must be text.');
  return { contains: (value.contains || '').slice(0,5000), excludes: (value.excludes || '').slice(0,5000), maxWords, json: Boolean(value.json) };
}
export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notebook (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
  if (!db.prepare('SELECT body FROM notebook WHERE id=1').get()) {
    const state = { schemaVersion: 1, prompts: [], versions: [], runs: [], corrections: [], tests: [], experiments: [], workflows: [], workflowRuns: [] };
    for (const [title, template] of [
      ['Research brief', 'Write a concise research brief from these source notes. Separate measured findings from assumptions, state missing evidence, and recommend a next step. Keep it under 120 words.\n\n{{source_notes}}'],
      ['Decision memo', 'Using only the supplied brief, write a decision memo with a recommendation, uncertainty, and one next action. Do not add unsupported facts.\n\n{{brief}}'],
      ['Writing editor', 'Edit the following text for clarity and concision, retaining its meaning and factual qualifications. Return only the edited text.\n\n{{draft}}']
    ]) {
      const p = { id: id(), title, activeVersionId: null, createdAt: now() };
      const v = { id: id(), promptId: p.id, number: 1, template, note: 'First version', model: '', maxTokens: 1000, createdAt: now() };
      p.activeVersionId = v.id; state.prompts.push(p); state.versions.push(v);
    }
    state.workflows.push({ id:id(), title:'Research → decision', promptIds:state.prompts.slice(0,2).map(p=>p.id), createdAt:now() });
    db.prepare('INSERT INTO notebook(id,body) VALUES(1,?)').run(JSON.stringify(state));
  }
  const read = () => JSON.parse(db.prepare('SELECT body FROM notebook WHERE id=1').get().body);
  function mutate(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const state = read(); const result = fn(state); db.prepare('UPDATE notebook SET body=? WHERE id=1').run(JSON.stringify(state)); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { read, mutate, close: () => db.close() };
}
export function versionFor(state, promptId, versionId) {
  const p = state.prompts.find(p => p.id === promptId);
  requireValue(p, 'Prompt not found.', 404);
  const v = state.versions.find(v => v.id === (versionId || p.activeVersionId) && v.promptId === p.id);
  requireValue(v, 'Version not found.', 404);
  return v;
}
export function createVersion(state, promptId, body) {
  const p = state.prompts.find(p => p.id === promptId); requireValue(p, 'Prompt not found.', 404);
  const maxTokens = Number(body.maxTokens || 1000);
  requireValue(Number.isInteger(maxTokens) && maxTokens >= 64 && maxTokens <= 4096, 'Output token limit must be 64–4096.');
  const v = { id:id(), promptId, number:Math.max(0,...state.versions.filter(v=>v.promptId===promptId).map(v=>v.number))+1, template:text(body.template,'Prompt'), note:text(body.note || 'Saved candidate','Version note',1000), model:typeof body.model==='string'?body.model.trim().slice(0,200):'', maxTokens, createdAt:now(), correctionId:body.correctionId || null };
  if(v.correctionId) requireValue(state.corrections.some(c=>c.id===v.correctionId && c.promptId===promptId),'Correction does not belong to this prompt.');
  state.versions.push(v); return v;
}
export function workflowStatus(state, workflow) {
  const last = [...state.workflowRuns].reverse().find(r=>r.workflowId===workflow.id && r.status==='complete');
  if(!last) return {status:'Not run',changed:[]};
  const changed = workflow.promptIds.filter((p,i)=>state.prompts.find(x=>x.id===p)?.activeVersionId!==last.steps[i]?.versionId);
  const first = workflow.promptIds.findIndex(p=>changed.includes(p));
  return { status: changed.length ? 'Needs retest' : 'Current', changed, affected: first<0?[]:workflow.promptIds.slice(first), lastRunId:last.id };
}
