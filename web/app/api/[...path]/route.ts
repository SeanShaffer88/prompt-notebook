import { env } from 'cloudflare:workers';
import seed from '../../../lib/seed.json';
import { notebookService } from '../../../lib/notebook-service.mjs';
const cookieName='pn_workspace';
const json=(data:unknown,status=200,cookie?:string)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(cookie?{'Set-Cookie':cookie}:{})}});
const fail=(message:string,status=400)=>Object.assign(new Error(message),{status});
async function sha(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function handle(request:Request){
  let workspaceId:string|undefined,lease:string|undefined,state:any,cookie:string|undefined;
  const db=env.DB;
  try{
    if(!db)throw fail('Notebook storage is not available yet.',503);
    const url=new URL(request.url),origin=request.headers.get('origin');
    if(origin && origin!==url.origin)throw fail('Cross-origin access denied.',403);
    if(request.headers.get('sec-fetch-site')==='cross-site')throw fail('Cross-site API requests are not allowed.',403);
    if(!['GET','POST'].includes(request.method))throw fail('Method not allowed.',405);
    const token=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const freshToken=token&&/^[a-f0-9]{64}$/.test(token)?token:Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
    workspaceId=await sha(freshToken);
    let row:any=await db.prepare('SELECT * FROM notebook_workspaces WHERE id=?').bind(workspaceId).first();
    if(!row){
      const count:any=await db.prepare('SELECT COUNT(*) AS total FROM notebook_workspaces').first();
      if(count.total>=1000)throw fail('The public demo has reached its workspace limit. Please use the open-source local app.',503);
      const fresh=structuredClone(seed);const stamp=Date.now();
      await db.prepare('INSERT OR IGNORE INTO notebook_workspaces(id,body,created_at,updated_at,write_day) VALUES(?,?,?,?,?)').bind(workspaceId,JSON.stringify(fresh),stamp,stamp,new Date().toISOString().slice(0,10)).run();
      row=await db.prepare('SELECT * FROM notebook_workspaces WHERE id=?').bind(workspaceId).first();
    }
    cookie=`${cookieName}=${freshToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000${url.protocol==='https:'?'; Secure':''}`;
    state=JSON.parse(row.body);
    if(request.method==='GET'){
      if(!['/api/state','/api/export'].includes(url.pathname))throw fail('Route not found.',404);
      const result=await notebookService(state).route('GET',url.pathname,{});
      const response=json(result,200,cookie);if(url.pathname==='/api/export')response.headers.set('Content-Disposition','attachment; filename="prompt-notebook-backup.json"');return response;
    }
    if(!request.headers.get('content-type')?.startsWith('application/json'))throw fail('JSON required.',415);
    if(request.headers.get('x-notebook-request')!=='1')throw fail('Notebook request header required.',403);
    const reader=request.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();
    if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>128000){await reader.cancel();throw fail('Request too large.',413);}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}
    let body;try{body=JSON.parse(raw);}catch{throw fail('Invalid JSON.');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw fail('JSON object required.');
    const day=new Date().toISOString().slice(0,10);
    if(row.write_day===day&&row.writes>=120)throw fail('This workspace reached its daily limit of 120 operations. Export your work or return tomorrow.',429);
    if(JSON.stringify(state).length>400000)throw fail('This workspace is full. Export your notebook and use the local app for larger projects.',413);
    lease=crypto.randomUUID();
    const acquired=await db.prepare('UPDATE notebook_workspaces SET lease=?,lease_until=? WHERE id=? AND lease_until<?').bind(lease,Date.now()+180000,workspaceId,Date.now()).run();
    if(!acquired.meta.changes)throw fail('Another operation is running in this workspace. Wait for it to finish.',409);
    const locked:any=await db.prepare('SELECT * FROM notebook_workspaces WHERE id=?').bind(workspaceId).first();state=JSON.parse(locked.body);
    const key=request.headers.get('x-provider-key')||'';
    if(key.length>1000)throw fail('Invalid provider key.');
    let result;
    try{result=await notebookService(state,key).route('POST',url.pathname,body);}
    catch(error){await save(state,locked);throw error;}
    await save(state,locked);return json(result,200,cookie);
    async function save(value:any,previous:any){
      const serialized=JSON.stringify(value);if(serialized.length>750000)throw fail('Notebook storage limit reached. Export and use the local app.',413);
      await db!.prepare('UPDATE notebook_workspaces SET body=?,updated_at=?,lease=NULL,lease_until=0,write_day=?,writes=? WHERE id=? AND lease=?').bind(serialized,Date.now(),day,previous.write_day===day?previous.writes+1:1,workspaceId,lease).run();
      lease=undefined;
    }
  }catch(error:any){
    if(lease&&workspaceId&&db)await db.prepare('UPDATE notebook_workspaces SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(workspaceId,lease).run().catch(()=>{});
    return json({error:error.status?error.message:'The operation could not complete. Please retry.'},error.status||500,cookie);
  }
}
export const GET=handle;
export const POST=handle;
