import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createUsageReporter } = createRequire(import.meta.url)('../src/usage-reporting.js');
const req = (id, time, extra={}) => ({requestId:id,operationId:'op-'+id,startedAt:time,projectId:'p1',projectLabel:'Project',attributionStatus:'known',activity:'chat',subtask:'generation',trigger:'user',requestedProvider:'p',requestedModel:'m',provider:'p',model:'m',modelIdentitySource:'provider',status:'completed',inputUncached:8,cacheRead:2,cacheWrite:0,output:5,totalTokens:15,usageCoverage:'complete',...extra});
const query = {from:'2024-03-30T00:00:00Z',to:'2024-04-02T00:00:00Z',timezone:'Europe/Dublin',bucket:'day'};
const fixture = () => ({revision:1,trackingStartedAt:'2024-03-01T00:00:00Z',health:{degraded:false,gaps:[]},operations:[],requests:[]});
const reporter = (data, now=()=>Date.parse('2024-04-02T12:00:00Z')) => createUsageReporter({readLedger:async()=>data,clock:now});

test('half-open ranges, DST days, start attribution and consistent totals', async () => {
  const data=fixture(); data.requests=[req('a',query.from),req('b','2024-03-31T01:30:00Z',{completedAt:'2024-04-02T01:00:00Z',projectId:null,activity:'workspace_review'}),req('c',query.to)];
  const r=await reporter(data).report(query);
  assert.equal(r.totals.totalTokens,30); assert.equal(r.totals.operations,2);
  assert.equal(r.buckets.reduce((n,b)=>n+(b.metrics.totalTokens||0),0),30);
  assert.equal(r.breakdown.rows.reduce((n,x)=>n+x.metrics.totalTokens,0),30);
  assert.ok(r.buckets.some(b=>Date.parse(b.end)-Date.parse(b.start)===23*3600000));
  const filtered=await reporter(data).report({...query,project:'p1'}); assert.equal(filtered.totals.totalTokens,15);
});

test('repeated hours retain offsets, nonexistent hours are omitted and clipped periods are visible', async () => {
  const x=reporter(fixture());
  const fall=await x.report({from:'2024-10-27T00:00:00Z',to:'2024-10-27T03:00:00Z',timezone:'Europe/Dublin',bucket:'hour'});
  assert.equal(fall.buckets.length,3); assert.notEqual(fall.buckets[0].label,fall.buckets[1].label);
  const spring=await x.report({from:'2024-03-31T00:00:00Z',to:'2024-03-31T03:30:00Z',timezone:'Europe/Dublin',bucket:'hour'});
  assert.equal(spring.buckets.length,4); assert.equal(spring.buckets.at(-1).partial,true);
});

test('presets, ISO week year, leap day, and timezone preserve explicit totals', async () => {
  const data=fixture(); data.requests=[req('a','2024-01-01T00:30:00Z')]; const x=reporter(data,()=>Date.parse('2024-02-29T12:34:56Z'));
  const lastYear=await x.report({preset:'last_year',timezone:'UTC',bucket:'week'}); assert.equal(lastYear.range.from,'2023-02-28T12:34:56.000Z');
  const v={from:'2023-12-31T00:00:00Z',to:'2024-01-03T00:00:00Z',bucket:'week'};
  const utc=await x.report({...v,timezone:'UTC'}); const dublin=await x.report({...v,timezone:'Europe/Dublin'});
  assert.equal(utc.totals.totalTokens,dublin.totals.totalTokens); assert.ok(utc.buckets.some(b=>b.label==='2023-W52')); assert.ok(utc.buckets.some(b=>b.label==='2024-W01'));
});

test('snapshots bind cursors to filters; export includes all rows and neutralizes formulas', async () => {
  let now=Date.parse('2024-04-02T12:00:00Z'); const data=fixture(); data.requests=[req('a',query.from,{projectId:'p1',projectLabel:'=danger'}),req('b',query.from,{projectId:'p2',projectLabel:'second'})]; const x=reporter(data,()=>now);
  const first=await x.report({...query,limit:'1'}); assert.ok(first.nextCursor); data.requests.push(req('c',query.from,{projectId:'p3'}));
  const second=await x.report({...query,limit:'1',snapshot:first.snapshot,cursor:first.nextCursor}); assert.equal(second.totals.requests,2); assert.notEqual(first.breakdown.rows[0].id,second.breakdown.rows[0].id);
  await assert.rejects(x.report({...query,project:'p1',snapshot:first.snapshot,cursor:first.nextCursor}),{code:'INVALID_USAGE_QUERY'});
  const csv=await x.export({...query,limit:'1',snapshot:first.snapshot}); assert.match(csv,/'=danger/); assert.match(csv,/second/); assert.doesNotMatch(csv,/p3/);
  now+=600000; await assert.rejects(x.report({...query,snapshot:first.snapshot}),{code:'USAGE_SNAPSHOT_EXPIRED',status:409});
});

test('unknown counts, historical identities, zero request operations, bucket detail and filtering', async () => {
  const data=fixture(); data.requests=[req('a',query.from,{operationId:'run',projectId:'gone',projectLabel:'Gone',activity:'project_review',provider:null,model:null,requestedProvider:'old',requestedModel:'removed',inputUncached:null,cacheRead:null,cacheWrite:null,output:null,totalTokens:null,usageCoverage:'unavailable'}),req('b','2024-03-31T12:00:00Z',{operationId:'run',projectId:null,activity:'workspace_review'})];
  data.operations=[{operationId:'run',startedAt:query.from,activity:'project_review',projectId:'gone'}, {operationId:'empty',startedAt:query.from,activity:'chat',projectId:'gone',status:'failed'}];
  const x=reporter(data); const r=await x.report({...query,activity:'all_reviews',breakdown:'models'}); assert.equal(r.totals.requests,2); assert.equal(r.totals.operations,1); assert.equal(r.totals.unavailable,1); assert.ok(r.options.models.some(m=>m.model==='removed' && m.identitySource==='requested_only'));
  const detail=await x.report({...query,project:'gone'}); assert.equal(detail.totals.totalTokens,null); assert.equal(detail.totals.requests,1);
  const ops=await x.report({...query,breakdown:'operations'}); assert.ok(ops.breakdown.rows.some(o=>o.id==='empty' && o.metrics.requests===0));
  const bucket=r.buckets[0]; const narrowed=await x.report({...query,bucketFrom:bucket.start,bucketTo:bucket.end}); assert.equal(narrowed.totals.requests,2); assert.equal(narrowed.breakdown.rows.reduce((n,v)=>n+v.metrics.requests,0),1);
  assert.equal((await x.operation('empty')).requests.length,0); await assert.rejects(x.operation('absent'),{code:'USAGE_NOT_FOUND',status:404});
});

test('pretracking buckets are unavailable and validation rejects invalid requests', async () => {
  const data=fixture(); data.trackingStartedAt='2024-04-01T00:00:00Z'; const x=reporter(data); const r=await x.report(query);
  assert.equal(r.buckets[0].coverage,'untracked'); assert.equal(r.buckets[0].metrics.totalTokens,null);
  for (const q of [{...query,typo:'x'},{...query,timezone:'nonsense'},{...query,model:'m'},{...query,bucket:'second'},{...query,limit:'201'},{...query,bucketFrom:query.from}]) await assert.rejects(x.report(q),{code:'INVALID_USAGE_QUERY'});
  await assert.rejects(x.report({from:'2020-01-01T00:00:00Z',to:'2024-01-01T00:00:00Z',timezone:'UTC',bucket:'hour'}),{code:'INVALID_USAGE_QUERY'});
});

test('request details omit non-ledger content and CSV streaming retains snapshot', async () => {
  const data=fixture(); data.requests=[req('a',query.from,{operationId:'op',prompt:'fixture secret',response:'fixture secret'})]; data.operations=[{operationId:'op',startedAt:query.from,prompt:'fixture secret',promptSubmissions:[{id:'id',acceptedAt:query.from,text:'fixture secret'}]}];
  const x=reporter(data); const r=await x.report(query); const detail=await x.operation('op',{snapshot:r.snapshot}); assert.doesNotMatch(JSON.stringify(detail),/fixture secret/);
  const chunks=[]; for await (const chunk of await x.exportRows({...query,snapshot:r.snapshot})) chunks.push(chunk); assert.doesNotMatch(chunks.join(''),/fixture secret/); assert.ok(chunks.length>2);
});

test('fresh rolling snapshots update boundaries and reaggregate when a request crosses an edge', async () => {
  let now=Date.parse('2024-04-02T12:00:00Z'); const data=fixture(); data.requests=[req('edge','2024-04-01T12:00:01Z')]; const x=reporter(data,()=>now);
  const q={preset:'last_24_hours',bucket:'hour',timezone:'UTC'}; const first=await x.report(q); assert.equal(first.totals.requests,1);
  now+=500; const second=await x.report(q); assert.equal(second.totals.requests,1); assert.equal(second.range.to,'2024-04-02T12:00:00.500Z');
  now+=1000; const third=await x.report(q); assert.equal(third.totals.requests,0); assert.equal(third.buckets.at(-1).end,third.range.to);
});

test('half-hour timezone transitions create distinct actual buckets', async () => {
  const x=reporter(fixture()); const r=await x.report({from:'2024-10-05T14:00:00Z',to:'2024-10-05T18:00:00Z',timezone:'Australia/Lord_Howe',bucket:'hour'});
  assert.ok(r.buckets.some(b=>Date.parse(b.end)-Date.parse(b.start)===1800000));
  assert.equal(r.buckets[0].start,'2024-10-05T14:00:00.000Z'); assert.equal(r.buckets.at(-1).end,'2024-10-05T18:00:00.000Z');
});

test('availability is captured with the snapshot and marks historical identities', async () => {
  const data=fixture(); data.requests=[req('a',query.from,{projectId:'gone',provider:'old',model:'removed'})]; let availability={projects:[],models:[]};
  const x=createUsageReporter({readLedger:async()=>data,readAvailability:async()=>structuredClone(availability),clock:()=>Date.parse('2024-04-02T12:00:00Z')});
  const first=await x.report({...query,breakdown:'models'}); assert.equal(first.breakdown.rows[0].available,false); assert.equal(first.options.projects[0].available,false);
  availability={projects:['gone'],models:[{provider:'old',model:'removed'}]};
  const old=await x.report({...query,breakdown:'projects',snapshot:first.snapshot}); assert.equal(old.breakdown.rows[0].available,false);
  const current=await x.report({...query,breakdown:'models'}); assert.equal(current.breakdown.rows[0].available,true);
});

test('chart components reconcile contradictory provider totals in buckets and groups', async () => {
  const data=fixture(); data.requests=[req('bad',query.from,{inputUncached:100,cacheRead:20,cacheWrite:0,output:10,totalTokens:50,usageCoverage:'partial',mismatch:true}),req('normal',query.from,{inputUncached:8,cacheRead:2,cacheWrite:0,output:5,totalTokens:20,usageCoverage:'partial'})];
  const report=await reporter(data).report(query); const sum=c=>Object.values(c).reduce((a,b)=>a+(b||0),0);
  assert.equal(report.totals.totalTokens,70); assert.equal(report.totals.inputUncached,108);
  assert.deepEqual(report.totals.chartComponents,{inputUncached:8,cacheRead:2,cacheWrite:0,output:5,unclassified:55});
  assert.equal(sum(report.totals.chartComponents),report.totals.totalTokens);
  assert.equal(sum(report.buckets[0].metrics.chartComponents),report.buckets[0].metrics.totalTokens);
  assert.equal(sum(report.breakdown.rows[0].metrics.chartComponents),report.breakdown.rows[0].metrics.totalTokens);
});


test('accounting degradation rejects fresh reads while an explicit prior snapshot remains consistent', async () => {
  const data=fixture(); data.requests=[req('a',query.from)]; data.operations=[{operationId:'op-a',startedAt:query.from,activity:'chat'}];
  const x=reporter(data); const previous=await x.report(query);
  data.health.degraded=true;
  await assert.rejects(x.report(query),{code:'USAGE_STORE_UNAVAILABLE',status:503});
  await assert.rejects(x.operation('op-a'),{code:'USAGE_STORE_UNAVAILABLE',status:503});
  const retained=await x.report({...query,snapshot:previous.snapshot}); assert.equal(retained.totals.totalTokens,15);
});
