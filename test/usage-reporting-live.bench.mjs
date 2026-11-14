// Run against the seeded 100k-request fixture: node test/usage-reporting-live.bench.mjs /tmp/usage-ledger-benchmark
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {UsageStore}=require('../src/usage-store');
const {createUsageReporter}=require('../src/usage-reporting');
const stateDir=process.argv[2]; if (!stateDir) throw new Error('Provide the seeded fixture state directory');
const store=new UsageStore({stateDir,workspaceRoot:'/benchmark'});
let start=performance.now(); await store.init(); const initMs=performance.now()-start;
const operation=await store.startOperation({activity:'chat',startedAt:'2025-12-31T00:00:00Z'});
const request=await store.startRequest({operationId:operation.operationId,activity:'chat',projectId:'p0',provider:'provider',model:'model0',startedAt:'2025-12-31T00:00:00Z'});
const reporter=createUsageReporter({readLedger:()=>store.snapshot(),clock:()=>Date.parse('2026-01-01T00:00:00Z')});
const query={preset:'last_year',bucket:'week',timezone:'UTC'};
start=performance.now(); await reporter.report(query); const coldMs=performance.now()-start;
const times=[];
for (let i=0;i<40;i++) { await store.checkpointRequest(request.requestId,{totalTokens:i,usageCoverage:'partial'}); start=performance.now(); await reporter.report(query); times.push(performance.now()-start); }
times.sort((a,b)=>a-b);
const logging=[]; for(let i=0;i<100;i++){ start=performance.now(); await store.startRequest({operationId:operation.operationId,activity:'chat'}); logging.push(performance.now()-start); } logging.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:os.cpus()[0].model,initMs,coldMs,changedRevisionP95Ms:times[37],changedRevisionMaxMs:times[39],retainedSnapshots:41,dispatchStartP95Ms:logging[94],rssMB:process.memoryUsage().rss/1e6},null,2));
