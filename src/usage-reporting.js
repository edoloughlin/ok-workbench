'use strict';

const crypto = require('node:crypto');
const TTL = 10 * 60 * 1000;
const fields = new Set(['preset','from','to','bucket','timezone','project','activity','provider','model','operationId','breakdown','sort','direction','cursor','limit','snapshot','bucketFrom','bucketTo']);
const activities = new Set(['chat','project_review','workspace_review','progress_report','system','all_reviews']);
const breakdowns = new Set(['projects','activities','models','operations']);
const sorts = new Set(['totalTokens','inputUncached','cacheRead','cacheWrite','output','requests','operations','startedAt','label']);
function error(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function invalid(field, message) { throw error('INVALID_USAGE_QUERY', `${field}: ${message}`); }
function params(input) { return input instanceof URLSearchParams ? Object.fromEntries(input) : { ...input }; }
const formatters = new Map();
function formatter(zone, options) { const key = zone + JSON.stringify(options); if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat('en-CA', {timeZone:zone,...options})); return formatters.get(key); }
function parts(ms, zone) {
  const f = formatter(zone, { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  return Object.fromEntries(f.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
}
function localEpoch(p) { return Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0); }
function instant(p, zone) {
  const target = localEpoch(p); let value = target;
  for (let i = 0; i < 6; i++) { const next = value + target - localEpoch(parts(value, zone)); if (next === value) break; value = next; }
  return value;
}
function shift(p, unit, n) {
  const d = new Date(localEpoch(p));
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + n);
  if (unit === 'month') { const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 0)).getUTCDate())); }
  if (unit === 'year') { const day = d.getUTCDate(), month = d.getUTCMonth(); d.setUTCDate(1); d.setUTCFullYear(d.getUTCFullYear() + n); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), month+1, 0)).getUTCDate())); }
  return { year:d.getUTCFullYear(), month:d.getUTCMonth()+1, day:d.getUTCDate(), hour:d.getUTCHours(), minute:d.getUTCMinutes(), second:d.getUTCSeconds() };
}
function offset(ms,zone) { const second=Math.floor(ms/1000)*1000; return localEpoch(parts(second,zone))-second; }
function transition(lo,hi,zone) { const original=offset(lo,zone); if (offset(hi,zone)===original) return null; while (hi-lo>1000) { const mid=Math.floor((lo+hi)/2000)*1000; if (offset(mid,zone)===original) lo=mid; else hi=mid; } return hi; }
function floorCalendar(ms, unit, zone) {
  const p = parts(ms, zone); p.minute = 0; p.second = 0;
  if (unit === 'hour') { // Preserve the offset of a repeated local hour.
    const start=ms - (ms % 1000) - (parts(ms, zone).minute * 60 + parts(ms, zone).second) * 1000; return transition(start,ms - (ms % 1000),zone) ?? start;
  }
  p.hour = 0;
  if (unit === 'month') p.day = 1;
  if (unit === 'week') { const weekday = new Date(localEpoch(p)).getUTCDay(); Object.assign(p, shift(p, 'day', -((weekday + 6) % 7))); }
  return instant(p, zone);
}
function nextBoundary(ms, unit, zone) {
  if (unit === 'hour') { const p=parts(ms,zone); const candidate=ms+(60-p.minute)*60000-p.second*1000; return transition(ms,candidate,zone) ?? candidate; }
  return instant(shift(parts(ms, zone), unit === 'week' ? 'day' : unit, unit === 'week' ? 7 : 1), zone);
}
function isoWeek(ms, zone) { const p = parts(ms, zone); const d = new Date(Date.UTC(p.year,p.month-1,p.day)); d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7)); const y=d.getUTCFullYear(); return `${y}-W${String(Math.ceil((((d-new Date(Date.UTC(y,0,1)))/86400000)+1)/7)).padStart(2,'0')}`; }
function label(ms, unit, zone) { if (unit === 'week') return isoWeek(ms, zone); const options = unit === 'hour' ? {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'shortOffset',hourCycle:'h23'} : unit === 'month' ? {year:'numeric',month:'2-digit'} : {year:'numeric',month:'2-digit',day:'2-digit'}; return formatter(zone, options).format(new Date(ms)); }
function validInstant(value) { const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value); if (!m) return false; const [,y,mo,d,h,mi,sec,zone]=m; const maxDay=new Date(Date.UTC(+y,+mo,0)).getUTCDate(); return +mo>=1 && +mo<=12 && +d>=1 && +d<=maxDay && +h<=23 && +mi<=59 && +sec<=59 && (zone==='Z' || (+zone.slice(1,3)<=23 && +zone.slice(4)<=59)) && Number.isFinite(Date.parse(value)); }
function validate(input, now) {
  const q = params(input);
  for (const key of Object.keys(q)) if (!fields.has(key)) invalid(key, 'unknown field');
  for (const [k,v] of Object.entries(q)) if (typeof v !== 'string' || v.length > 512 || /[\x00-\x1f]/.test(v)) invalid(k, 'invalid value');
  if (!q.timezone) invalid('timezone','required');
  try { if (/^[+-]/.test(q.timezone)) throw new Error('offset is not an IANA zone'); new Intl.DateTimeFormat('en', {timeZone:q.timezone}).format(); } catch { invalid('timezone','unknown IANA timezone'); }
  if (!['hour','day','week','month'].includes(q.bucket)) invalid('bucket','choose hour, day, week, or month');
  if (!!q.preset === !!(q.from || q.to) || (!q.preset && (!q.from || !q.to))) invalid('range','provide a preset or both from and to');
  let from, to = now; const p = parts(now, q.timezone);
  if (q.preset === 'last_24_hours') from = now - 86400000;
  else if (q.preset === 'last_30_days') from = instant({...shift(p,'day',-29),hour:0,minute:0,second:0},q.timezone);
  else if (q.preset === 'last_year') from = instant(shift(p,'year',-1),q.timezone) + (now % 1000);
  else if (q.preset === 'last_12_months') from = instant({...shift({...p,day:1},'month',-11),hour:0,minute:0,second:0},q.timezone);
  else if (q.preset) invalid('preset','unknown preset');
  else { if (!validInstant(q.from) || !validInstant(q.to)) invalid('range','use ISO instants with offsets'); from = Date.parse(q.from); to = Date.parse(q.to); }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) invalid('range','start must precede end');
  if (to > instant(shift(parts(from,q.timezone),'year',5),q.timezone) + (from % 1000)) invalid('range','maximum range is five calendar years');
  if (!!q.bucketFrom !== !!q.bucketTo) invalid('bucketFrom','provide both bucket boundaries');
  if (q.bucketFrom && (!validInstant(q.bucketFrom) || !validInstant(q.bucketTo) || Date.parse(q.bucketFrom) >= to || Date.parse(q.bucketTo) <= from || Date.parse(q.bucketFrom) >= Date.parse(q.bucketTo) || Date.parse(q.bucketTo)-Date.parse(q.bucketFrom) > 370*86400000)) invalid('bucketFrom','bucket must lie within the report range');
  if (q.activity && !activities.has(q.activity)) invalid('activity','unknown activity');
  if (q.model && !q.provider) invalid('model','provider is required');
  if (q.breakdown && !breakdowns.has(q.breakdown)) invalid('breakdown','unknown breakdown');
  if (q.sort && !sorts.has(q.sort)) invalid('sort','unknown sort column');
  if (q.direction && !['asc','desc'].includes(q.direction)) invalid('direction','choose asc or desc');
  if (q.limit && (!/^\d+$/.test(q.limit) || +q.limit < 1 || +q.limit > 200)) invalid('limit','must be between 1 and 200');
  return { ...q, fromMs:from, toMs:to, breakdown:q.breakdown || 'projects', sort:q.sort || 'totalTokens', direction:q.direction || 'desc', limit:q.limit ? +q.limit : 50 };
}
function metrics(records) {
  const m = { requests:records.length, operations:new Set(records.map(r=>r.operationId)).size, complete:0, partial:0, unavailable:0, inFlight:0, inputUncached:null, cacheRead:null, cacheWrite:null, output:null, totalTokens:null, unclassified:null, chartComponents:{inputUncached:0,cacheRead:0,cacheWrite:0,output:0,unclassified:0} };
  for (const r of records) {
    m[['complete','partial','unavailable'].includes(r.usageCoverage) ? r.usageCoverage : 'unavailable']++;
    if (r.status === 'in_flight') m.inFlight++;
    for (const k of ['inputUncached','cacheRead','cacheWrite','output','totalTokens']) if (Number.isSafeInteger(r[k]) && r[k] >= 0) m[k] = (m[k] || 0) + r[k];
    if (Number.isSafeInteger(r.totalTokens) && r.totalTokens >= 0) { const keys=['inputUncached','cacheRead','cacheWrite','output']; const known=keys.reduce((n,k)=>n+(Number.isSafeInteger(r[k]) && r[k]>=0?r[k]:0),0); if (known>r.totalTokens) { m.chartComponents.unclassified+=r.totalTokens; } else { for (const k of keys) if (Number.isSafeInteger(r[k]) && r[k]>=0) m.chartComponents[k]+=r[k]; m.chartComponents.unclassified+=r.totalTokens-known; } m.unclassified=(m.unclassified || 0)+Math.max(0,r.totalTokens-known); }
  }
  if (!records.length) for (const k of ['inputUncached','cacheRead','cacheWrite','output','totalTokens','unclassified']) m[k]=0;
  else if (m.totalTokens===null) for (const k of Object.keys(m.chartComponents)) m.chartComponents[k]=null;
  return m;
}
function identity(r) { return r.provider && r.model ? {provider:r.provider, model:r.model, identitySource:r.modelIdentitySource || 'runtime'} : {provider:r.requestedProvider || null, model:r.requestedModel || null, identitySource: r.requestedProvider && r.requestedModel ? 'requested_only' : 'unknown'}; }
function matches(r,q) { const id=identity(r); return (!q.project || (q.project === 'shared' ? r.projectId == null && r.attributionStatus !== 'unattributed' : q.project === 'unattributed' ? r.attributionStatus === 'unattributed' : r.projectId === q.project)) && (!q.activity || (q.activity === 'all_reviews' ? ['project_review','workspace_review'].includes(r.activity) : r.activity === q.activity)) && (!q.provider || id.provider === q.provider) && (!q.model || id.model === q.model) && (!q.operationId || r.operationId === q.operationId); }
function project(r) { return r.attributionStatus === 'unattributed' ? {id:'unattributed',label:'Legacy / unattributed'} : r.projectId == null ? {id:'shared',label:'Workspace / shared'} : {id:r.projectId,label:r.projectLabel || r.projectId}; }
const timeCache=new WeakMap();
function timeOf(record) { let time=timeCache.get(record); if (time===undefined) { time=Date.parse(record.startedAt); timeCache.set(record,time); } return time; }
function group(records, kind, operations, withSubtasks=true) {
  const groups = new Map(), opMap = new Map(operations.map(o=>[o.operationId,o]));
  for (const r of records) {
    let item;
    if (kind === 'projects') item=project(r);
    else if (kind === 'activities') item={id:r.activity,label:r.activity};
    else if (kind === 'models') { const i=identity(r); item={id:JSON.stringify([i.provider,i.model,i.identitySource === 'requested_only' ? 'requested' : 'physical']),label:`${i.provider || 'Unknown'} / ${i.model || 'Unknown'}`, ...i}; }
    else { const o=opMap.get(r.operationId)||{}; item={id:r.operationId,label:r.operationId,startedAt:o.startedAt || r.startedAt,trigger:o.trigger || r.trigger,projectId:o.projectId ?? r.projectId,status:o.status || r.status}; }
    if (!groups.has(item.id)) groups.set(item.id,{...item, records:[]}); groups.get(item.id).records.push(r);
  }
  return [...groups.values()].map(({records:rs,...row})=>{ const result={...row,metrics:metrics(rs)}; if (kind==='operations') { const models=new Map(); for (const r of rs) { const i=identity(r); models.set(JSON.stringify([i.provider,i.model,i.identitySource]),i); } result.models=[...models.values()]; } if (kind==='activities' && withSubtasks) { const subtasks=new Map(); for (const r of rs) { const id=r.subtask||'other'; if (!subtasks.has(id)) subtasks.set(id,[]); subtasks.get(id).push(r); } result.subtasks=[...subtasks].map(([id,items])=>({id,label:id,metrics:metrics(items)})); const retries=rs.filter(r=>r.retryOfRequestId); if (retries.length) result.retries=metrics(retries); } return result; });
}
function key(q) { const copy={...q}; for (const k of ['cursor','snapshot','limit','fromMs','toMs']) delete copy[k]; return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a],[b])=>a.localeCompare(b)))); }
function csvCell(value) { let s=String(value ?? ''); if (/^[\s\x00-\x1f]*[=+\-@]/.test(s)) s="'"+s; return `"${s.replace(/"/g,'""')}"`; }
const requestKeys = ['schemaVersion','requestId','operationId','projectId','projectLabel','attributionStatus','activity','subtask','trigger','requestedProvider','requestedModel','provider','model','modelIdentitySource','startedAt','completedAt','status','retryOfRequestId','attempt','validationOutcome','inputUncached','cacheRead','cacheWrite','output','reasoning','totalTokens','usageCoverage','usageSource','normalizerVersion','errorCode','mismatch'];
const operationKeys = ['schemaVersion','operationId','projectId','projectLabel','activity','trigger','startedAt','completedAt','status','promptSubmissions','stages','reuse'];
function cleanRecord(record,keys) { const result=Object.fromEntries(keys.filter(k=>record[k] !== undefined).map(k=>[k,record[k]])); if (Array.isArray(result.promptSubmissions)) result.promptSubmissions=result.promptSubmissions.map(x=>({id:x.id,acceptedAt:x.acceptedAt})); for (const k of ['stages','reuse']) if (Array.isArray(result[k])) result[k]=result[k].map(x=>({stage:x.stage,projectId:x.projectId,outcome:x.outcome})); return result; }
const cleanedRecords=new WeakMap();
function cleanCached(record,keys) { if (!cleanedRecords.has(record)) cleanedRecords.set(record,cleanRecord(record,keys)); return cleanedRecords.get(record); }
function cleanLedger(data) { const source=Object.isFrozen(data) && Object.isFrozen(data.requests) && Object.isFrozen(data.operations) ? data : structuredClone(data); return {...source, requests:(source.requests || []).map(r=>cleanCached(r,requestKeys)), operations:(source.operations || []).map(o=>cleanCached(o,operationKeys))}; }
function createUsageReporter({readLedger, readAvailability = async () => ({}), clock = () => Date.now()} = {}) {
  if (typeof readLedger !== 'function') throw new TypeError('readLedger is required');
  const readHealthyLedger = async () => { const data = await readLedger(); if (data.health?.degraded) throw error('USAGE_STORE_UNAVAILABLE', 'Usage accounting is degraded; retry after restoring durable storage.', 503); return data; };
  const snapshots=new Map(); let lastLedger; let lastOptions; const warmReports=new Map();
  async function prepare(input) {
    const raw=params(input), now=Number(clock()); let snap;
    if (raw.snapshot) { snap=snapshots.get(raw.snapshot); if (!snap || now-snap.createdAt >= TTL) { snapshots.delete(raw.snapshot); throw error('USAGE_SNAPSHOT_EXPIRED','Snapshot expired; refresh the report.',409); } }
    else { const data=await readHealthyLedger(); if (!lastLedger || data.revision !== lastLedger.revision || JSON.stringify(data.health) !== lastLedger.healthKey) { lastLedger={revision:data.revision,healthKey:JSON.stringify(data.health),data:cleanLedger(data)}; warmReports.clear(); } const id=crypto.randomBytes(18).toString('base64url'); snap={id,createdAt:now,data:lastLedger.data,availability:await readAvailability()}; snapshots.set(id,snap); for (const [k,v] of snapshots) if (now-v.createdAt >= TTL) snapshots.delete(k); }
    const q=validate(raw,snap.createdAt);
    return {snap,q};
  }
  function build(snap,q,allRows=false) {
    snap.reports ||= new Map();
    const reportKey=key(q);
    if (snap.reports.has(reportKey)) {
      const cached=snap.reports.get(reportKey);
      if (allRows) return cached;
      let offset=0;
      if (q.cursor) { let c; try { c=JSON.parse(Buffer.from(q.cursor,'base64url').toString()); } catch { invalid('cursor','invalid cursor'); } if (c.snapshot!==snap.id || c.key!==reportKey || !Number.isSafeInteger(c.offset) || c.offset<0) invalid('cursor','cursor does not match this report'); offset=c.offset; }
      const rows=cached.breakdown.rows;
      return {...cached,breakdown:{...cached.breakdown,rows:rows.slice(offset,offset+q.limit)},nextCursor:offset+q.limit<rows.length ? Buffer.from(JSON.stringify({snapshot:snap.id,key:reportKey,offset:offset+q.limit})).toString('base64url') : null};
    }
    if (!allRows) { build(snap,q,true); return build(snap,q,false); }
    const previous=warmReports.get(reportKey);
    if (previous && previous.data===snap.data && !q.bucketFrom && previous.q.fromMs<=q.fromMs && previous.q.toMs<=q.toMs &&
        floorCalendar(previous.q.fromMs,q.bucket,q.timezone)===floorCalendar(q.fromMs,q.bucket,q.timezone) &&
        floorCalendar(previous.q.toMs-1,q.bucket,q.timezone)===floorCalendar(q.toMs-1,q.bucket,q.timezone) &&
        !previous.instants.some(t=>(t>=previous.q.fromMs && t<q.fromMs)||(t>=previous.q.toMs && t<q.toMs)) &&
        !(snap.data.trackingStartedAt && Date.parse(snap.data.trackingStartedAt)>=previous.q.fromMs && Date.parse(snap.data.trackingStartedAt)<q.fromMs) &&
        !(snap.data.health?.gaps?.length)) {
      const old=previous.result; const buckets=old.buckets.slice();
      if (buckets.length) {
        const first={...buckets[0],start:new Date(q.fromMs).toISOString(),partial:floorCalendar(q.fromMs,q.bucket,q.timezone)!==q.fromMs}; buckets[0]=first;
        const last={...buckets[buckets.length-1],end:new Date(q.toMs).toISOString(),partial:q.toMs!==nextBoundary(floorCalendar(q.toMs-1,q.bucket,q.timezone),q.bucket,q.timezone)};
        if (buckets.length===1) last.partial=first.partial||last.partial; buckets[buckets.length-1]=last;
      }
      const result={...old,snapshot:snap.id,asOf:new Date(snap.createdAt).toISOString(),range:{from:new Date(q.fromMs).toISOString(),to:new Date(q.toMs).toISOString()},buckets};
      snap.reports.set(reportKey,result); return result;
    }
    const data=snap.data, requests=data.requests || [], operations=data.operations || [];
    const selected=requests.filter(r=>{const t=timeOf(r); return t>=q.fromMs && t<q.toMs && matches(r,q);});
    const requestOps=new Set(requests.map(r=>r.operationId));
    const zeroOps=(!q.provider && !q.model) ? operations.filter(o=>!requestOps.has(o.operationId) && timeOf(o)>=q.fromMs && timeOf(o)<q.toMs && matches({...o,attributionStatus:'known'},q)) : [];
    const buckets=[]; let b=floorCalendar(q.fromMs,q.bucket,q.timezone);
    while (b<q.toMs) { const n=nextBoundary(b,q.bucket,q.timezone); if (!(n>b)) invalid('bucket','could not advance calendar boundary'); if (buckets.length>=2000) invalid('bucket','range exceeds 2,000 buckets; choose a larger bucket'); const start=Math.max(b,q.fromMs),end=Math.min(n,q.toMs); buckets.push({start:new Date(start).toISOString(),end:new Date(end).toISOString(),label:label(b,q.bucket,q.timezone),partial:start!==b || end!==n,coverage: !data.trackingStartedAt ? 'untracked' : start<Date.parse(data.trackingStartedAt) ? (end<=Date.parse(data.trackingStartedAt)?'untracked':'partial') : 'tracked',records:[]}); b=n; }
    const bucketEnds=buckets.map(b=>Date.parse(b.end));
    for (const r of selected) { const t=timeOf(r); let lo=0,hi=buckets.length; while(lo<hi){const mid=(lo+hi)>>1;if(bucketEnds[mid]<=t)lo=mid+1;else hi=mid;} if(buckets[lo]) buckets[lo].records.push(r); }
    const gaps=data.health?.gaps || [];
    for (const bucket of buckets) { if (gaps.some(g => !g.from || !g.to || (Date.parse(g.from)<Date.parse(bucket.end) && Date.parse(g.to)>Date.parse(bucket.start)))) bucket.coverage=bucket.coverage === 'untracked' ? 'untracked' : 'partial'; bucket.metrics=metrics(bucket.records); bucket.metrics.operations+=zeroOps.filter(o=>timeOf(o)>=Date.parse(bucket.start) && timeOf(o)<Date.parse(bucket.end)).length; bucket.activities=group(bucket.records,'activities',operations,false); if (bucket.coverage === 'untracked' && !bucket.records.length) { for (const k of ['inputUncached','cacheRead','cacheWrite','output','totalTokens','unclassified']) bucket.metrics[k]=null; for (const k of Object.keys(bucket.metrics.chartComponents)) bucket.metrics.chartComponents[k]=null; } delete bucket.records; }
    const detail=q.bucketFrom ? selected.filter(r=>timeOf(r)>=Date.parse(q.bucketFrom) && timeOf(r)<Date.parse(q.bucketTo)) : selected;
    let rows=group(detail,q.breakdown,operations);
    if (q.breakdown === 'operations' && !q.provider && !q.model) { const ids=new Set(rows.map(r=>r.id)); for (const op of zeroOps) { const t=Date.parse(op.startedAt); if (!ids.has(op.operationId) && t >= (q.bucketFrom ? Date.parse(q.bucketFrom) : q.fromMs) && t < (q.bucketTo ? Date.parse(q.bucketTo) : q.toMs) && matches({...op,attributionStatus:'known'},q) && !requestOps.has(op.operationId)) rows.push({id:op.operationId,label:op.operationId,startedAt:op.startedAt,trigger:op.trigger,projectId:op.projectId,status:op.status,metrics:metrics([])}); } } const dir=q.direction==='asc'?1:-1;
    rows.sort((a,b)=>{const av=a[q.sort] ?? a.metrics[q.sort],bv=b[q.sort] ?? b.metrics[q.sort]; const c=av==null ? (bv==null?0:1) : bv==null ? -1 : typeof av==='number' && typeof bv==='number' ? (av-bv)*dir : String(av).localeCompare(String(bv))*dir; return c || String(a.id).localeCompare(String(b.id));});
    let offset=0; if(q.cursor){ let c; try{c=JSON.parse(Buffer.from(q.cursor,'base64url').toString());}catch{invalid('cursor','invalid cursor');} if(c.snapshot!==snap.id || c.key!==key(q) || !Number.isSafeInteger(c.offset) || c.offset<0) invalid('cursor','cursor does not match this report'); offset=c.offset; }
    const page=allRows?rows:rows.slice(offset,offset+q.limit); const nextCursor=!allRows && offset+q.limit<rows.length ? Buffer.from(JSON.stringify({snapshot:snap.id,key:key(q),offset:offset+q.limit})).toString('base64url') : null;
    if (lastOptions && lastOptions.data!==data && lastOptions.data.requests.length===requests.length && requests.every((r,i)=>{ const prior=lastOptions.data.requests[i]; return r===prior || ['projectId','projectLabel','attributionStatus','activity','provider','model','requestedProvider','requestedModel','modelIdentitySource'].every(k=>r[k]===prior[k]); })) lastOptions={data,value:lastOptions.value};
    if (!lastOptions || lastOptions.data!==data) { const projects=new Map(),models=new Map(),acts=new Set(); for (const r of requests) { const p=project(r),i=identity(r); projects.set(p.id,p); models.set(JSON.stringify([i.provider,i.model,i.identitySource === 'requested_only' ? 'requested' : 'physical']),i); acts.add(r.activity); } lastOptions={data,value:{projects:[...projects.values()],activities:[...acts],models:[...models.values()]}}; } const options=lastOptions.value;
    const totalMetrics=metrics(selected); totalMetrics.operations += zeroOps.length;
    const result={schemaVersion:1,snapshot:snap.id,revision:data.revision,asOf:new Date(snap.createdAt).toISOString(),range:{from:new Date(q.fromMs).toISOString(),to:new Date(q.toMs).toISOString()},timezone:q.timezone,bucket:q.bucket,filters:{project:q.project||null,activity:q.activity||null,provider:q.provider||null,model:q.model||null,operationId:q.operationId||null,bucketFrom:q.bucketFrom||null,bucketTo:q.bucketTo||null},trackingStartedAt:data.trackingStartedAt||null,health:data.health||{gaps:[]},coverage: gaps.length ? 'partial' : !data.trackingStartedAt || q.toMs<=Date.parse(data.trackingStartedAt) ? 'untracked' : q.fromMs<Date.parse(data.trackingStartedAt) ? 'partial' : 'tracked',totals:totalMetrics,buckets,options,breakdown:{type:q.breakdown,rows:page},nextCursor};
    snap.reports.set(reportKey,result); warmReports.set(reportKey,{data,q,result,instants:[...requests.map(r=>timeOf(r)),...operations.map(o=>timeOf(o))]}); return result;
  }
  return {
    async report(query){const {snap,q}=await prepare(query); const report=build(snap,q); const a=snap.availability || {}; const projectAvailability=id=>Array.isArray(a.projects) && !['shared','unattributed'].includes(id) ? a.projects.includes(id) : undefined; const modelAvailability=row=>Array.isArray(a.models) ? a.models.some(m=>m.provider===row.provider && m.model===row.model) : undefined; const annotate=(row,fn)=>{const available=fn(row); return available===undefined?row:{...row,available};}; return {...report, options:{...report.options,projects:report.options.projects.map(p=>annotate(p,x=>projectAvailability(x.id))),models:report.options.models.map(m=>annotate(m,modelAvailability))},breakdown:{...report.breakdown,rows:report.breakdown.rows.map(r=>q.breakdown==='projects' ? annotate(r,x=>projectAvailability(x.id)) : q.breakdown==='models' ? annotate(r,modelAvailability) : r)}};},
    async exportRows(query){
      const {snap,q}=await prepare(query); const report=build(snap,q,true);
      const metadata=[['Range from',report.range.from],['Range to',report.range.to],['Timezone',report.timezone],['Filters',JSON.stringify(report.filters)],['Tracking started',report.trackingStartedAt],['Coverage',report.coverage],['Accounting health',JSON.stringify(report.health)],['Snapshot',report.snapshot]];
      return (async function* () {
        for (const row of [...metadata,[],['ID','Label','Input uncached','Cache read','Cache write','Output','Total tokens','Requests','Operations','Complete','Partial','Unavailable']]) yield row.map(csvCell).join(',')+'\r\n';
        for (const r of report.breakdown.rows) yield [r.id,r.label,r.metrics.inputUncached,r.metrics.cacheRead,r.metrics.cacheWrite,r.metrics.output,r.metrics.totalTokens,r.metrics.requests,r.metrics.operations,r.metrics.complete,r.metrics.partial,r.metrics.unavailable].map(csvCell).join(',')+'\r\n';
      })();
    },
    async export(query){ let output=''; for await (const chunk of await this.exportRows(query)) output+=chunk; return output; },
    async operation(id, query={}) { const raw=params(query); for (const k of Object.keys(raw)) if (!['cursor','limit','snapshot'].includes(k)) invalid(k,'unknown field'); const now=Number(clock()); let snap=raw.snapshot && snapshots.get(raw.snapshot); if(raw.snapshot && (!snap || now-snap.createdAt>=TTL)) throw error('USAGE_SNAPSHOT_EXPIRED','Snapshot expired; refresh the report.',409); if(!snap){snap={id:crypto.randomBytes(18).toString('base64url'),createdAt:now,data:cleanLedger(await readHealthyLedger())};snapshots.set(snap.id,snap);} const op=(snap.data.operations||[]).find(o=>o.operationId===id); if(!op) throw error('USAGE_NOT_FOUND','Operation not found.',404); if(raw.limit && (!/^\d+$/.test(raw.limit)||+raw.limit<1||+raw.limit>200)) invalid('limit','must be between 1 and 200'); let offset=0; if(raw.cursor){let c;try{c=JSON.parse(Buffer.from(raw.cursor,'base64url').toString());}catch{invalid('cursor','invalid cursor');} if(c.snapshot!==snap.id||c.operationId!==id||!Number.isSafeInteger(c.offset)||c.offset<0) invalid('cursor','cursor does not match this operation');offset=c.offset;} const all=(snap.data.requests||[]).filter(r=>r.operationId===id).sort((a,b)=>String(a.startedAt).localeCompare(String(b.startedAt))||String(a.requestId).localeCompare(String(b.requestId))); const limit=+(raw.limit||50); return {schemaVersion:1,snapshot:snap.id,asOf:new Date(snap.createdAt).toISOString(),operation:op,requests:all.slice(offset,offset+limit),nextCursor:offset+limit<all.length?Buffer.from(JSON.stringify({snapshot:snap.id,operationId:id,offset:offset+limit})).toString('base64url'):null}; }
  };
}
module.exports = { createUsageReporter, validateUsageQuery:validate, usageMetrics:metrics };
