// Create a disposable benchmark journal: node test/usage-reporting-seed.bench.mjs /tmp/new-usage-benchmark
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {workspaceKey}=require('../src/workspace-review-store.js');
const stateDir=process.argv[2]; if (!stateDir) throw new Error('Provide a new disposable state directory');
const key=workspaceKey('/benchmark'); const root=path.join(stateDir,'usage',key); await fs.mkdir(root,{recursive:true,mode:0o700});
if ((await fs.readdir(root)).length) throw new Error('Benchmark directory is not empty; choose a new directory');
try { await fs.writeFile(path.join(root,'.benchmark-seed'),'seeded\n',{flag:'wx',mode:0o600}); } catch { throw new Error('Benchmark directory already seeded; choose a new directory'); }
let sequence=0; let month=''; let lines=[];
async function flush() { if(lines.length) { await fs.appendFile(path.join(root,`${month}.jsonl`),lines.join(''),{mode:0o600}); lines=[]; } }
async function event(type,timestamp,data,id) { const m=timestamp.slice(0,7); if(m!==month){await flush();month=m;} const seq=++sequence; lines.push(JSON.stringify({schemaVersion:1,eventId:`event-${seq}`,sequence:seq,timestamp,type,writerPid:2,writerId:'benchmark',...(id?{id}:{}),data})+'\n'); if(lines.length>=1000) await flush(); }
const beginning='2025-01-01T00:00:00.000Z'; await event('tracking',beginning,{});
for(let i=0;i<100;i++) await event('operation_start',beginning,{schemaVersion:1,operationId:`op${i}`,workspaceKey:key,projectId:`p${i}`,activity:'chat',trigger:'user',startedAt:beginning,status:'completed'});
for(let i=0;i<100000;i++) { const timestamp=new Date(Date.UTC(2025,0,1)+Math.floor(i*365*86400000/100000)).toISOString(); const project=i%100, model=i%20; await event('request_start',timestamp,{schemaVersion:1,requestId:`r${i}`,operationId:`op${project}`,workspaceKey:key,projectId:`p${project}`,projectLabel:`Project ${project}`,attributionStatus:'known',activity:'chat',subtask:'generation',trigger:'user',requestedProvider:'provider',requestedModel:`model${model}`,provider:'provider',model:`model${model}`,modelIdentitySource:'runtime',startedAt:timestamp,completedAt:timestamp,status:'completed',retryOfRequestId:null,attempt:1,validationOutcome:'not_applicable',inputUncached:100,cacheRead:0,cacheWrite:0,output:10,reasoning:null,totalTokens:110,usageCoverage:'complete',usageSource:'provider',normalizerVersion:1,errorCode:null}); }
await flush(); console.log(`Seeded ${sequence} events in ${root}`);
