// Run with: node test/usage-reporting.bench.mjs
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const { createUsageReporter } = createRequire(import.meta.url)('../src/usage-reporting.js');
const requests=Array.from({length:100000},(_,i)=>({requestId:`r${i}`,operationId:`o${i}`,startedAt:new Date(Date.UTC(2025,0,1)+(i%365)*86400000).toISOString(),projectId:`p${i%100}`,projectLabel:`Project ${i%100}`,attributionStatus:'known',activity:'chat',requestedProvider:'p',requestedModel:`m${i%20}`,provider:'p',model:`m${i%20}`,status:'completed',inputUncached:10,cacheRead:0,cacheWrite:0,output:5,totalTokens:15,usageCoverage:'complete'}));
const data={revision:1,trackingStartedAt:'2025-01-01T00:00:00Z',health:{gaps:[]},requests,operations:[]};
const reporter=createUsageReporter({readLedger:async()=>data,clock:()=>Date.parse('2026-01-01T00:00:00Z')});
const query={preset:'last_year',bucket:'week',timezone:'UTC'};
let started=performance.now(); const first=await reporter.report(query); const cold=performance.now()-started;
const warm=[]; for(let i=0;i<20;i++){started=performance.now();await reporter.report(query);warm.push(performance.now()-started);} warm.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:os.cpus()[0].model,requests:requests.length,coldMs:cold,freshWarmP95Ms:warm[18],freshWarmMaxMs:warm[19]},null,2));
