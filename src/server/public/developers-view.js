const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => value == null ? 'Not available' : Number(value.toFixed(2)).toLocaleString();
const defaults = () => ({ name:'Developers',config:{aggregation:'average',quantile:90,normalization:'none',sizeWeighting:'none',authorshipThreshold:2,renormalizeAuthorship:false,attribution:'proportional',basis:'churn',merges:'exclude',created:1,deleted:1,changed:1} });
const contributions = (files, {ignoreWithoutFunctions=false,ignoreZeros=false}={}) => files.filter(f =>
  f.weight > 0 && Number.isFinite(f.contribution) &&
  (!ignoreWithoutFunctions || f.function_count > 0) && (!ignoreZeros || f.contribution !== 0)
).map(f => f.contribution);
const quantile = (values,p) => {
  const i=(values.length-1)*p, lo=Math.floor(i), fraction=i-lo;
  return values[lo]*(1-fraction)+values[Math.ceil(i)]*fraction;
};
export function contributionDomain(developers, filters) {
  const values=[];
  for(const person of developers) for(const value of contributions(person.files,filters)) values.push(value);
  if(!values.length) return [0,1];
  values.sort((a,b)=>a-b);
  let min=values[0];
  const max=quantile(values,.99);
  // Keep the P99 upper bound exact, even when all values coincide.
  if(min===max) min=min>0?0:min-1;
  return [min,max];
}
// Contributions already include attribution shares; each attributed file counts once.
export function contributionSummary(files, filters) {
  const values = contributions(files,filters).sort((a,b) => a-b);
  if (!values.length) return null;
  const q1=quantile(values,.25), median=quantile(values,.5), q3=quantile(values,.75), iqr=q3-q1;
  const low=values.find(v=>v>=q1-5*iqr), high=values.findLast(v=>v<=q3+5*iqr);
  return {count:values.length,q1,median,q3,low,high,min:values[0],max:values.at(-1),outliers:values.filter(v=>v<low || v>high)};
}
function boxplot(summary, domain, person, scale, filters) {
  if (!summary) return '<p class="hint developer-no-data">No data</p>';
  const [min,max]=domain;
  // Signed extension keeps log1p defined for negative scores and padded zero domains.
  const transform=scale==='log1p'?v=>Math.sign(v)*Math.log1p(Math.abs(v)):v=>v;
  const inverse=scale==='log1p'?v=>Math.sign(v)*Math.expm1(Math.abs(v)):v=>v;
  const start=transform(min), end=transform(max);
  const position=v=>4+92*((transform(Math.max(min,Math.min(max,v)))-start)/(end-start));
  const x=v=>`${position(v)}%`, y=28;
  const {count,q1,median,q3,low,high,outliers}=summary;
  const clipped=contributions(person.files,filters).filter(v=>v>max).length;
  const overflow=clipped?` · ${clipped} files above P99 ${number(max)} · Maximum ${number(summary.max)}`:'';
  const description=`${person.name}: ${count} files · Q1 ${number(q1)} · Median ${number(median)} · Q3 ${number(q3)} · Whiskers ${number(low)}–${number(high)} · ${outliers.length} outliers${overflow}`;
  const line=(a,b,y1,y2,cls='')=>`<line class="${cls}" x1="${x(a)}" x2="${x(b)}" y1="${y1}" y2="${y2}"/>`;
  return `<div class="developer-boxplot"><svg width="100%" height="76" role="img" tabindex="0" aria-label="${esc(description)}"><title>${esc(description)}</title>
    ${line(min,max,y,y,'developer-plot-guide')}${line(low,high,y,y)}${line(low,low,19,37)}${line(high,high,19,37)}
    <rect x="${x(q1)}" y="16" width="${position(q3)-position(q1)}%" height="24"/>${line(median,median,14,42,'developer-plot-median')}
    ${[...new Set(outliers)].filter(v=>v<=max).map(v=>`<circle cx="${x(v)}" cy="${y}" r="3"/>`).join('')}
    ${clipped?`<g class="developer-plot-overflow"><text x="98%" y="34" text-anchor="middle">›</text><text x="96%" y="12" text-anchor="end">${clipped} &gt; P99 · max ${number(summary.max)}</text></g>`:''}
    ${[0,.25,.5,.75,1].map((fraction,i)=>{const v=i===0?min:i===4?max:inverse(start*(1-fraction)+end*fraction);return `${line(v,v,51,55,'developer-plot-axis')}<text class="developer-plot-tick" x="${x(v)}" y="70" text-anchor="${i===0?'start':i===4?'end':'middle'}">${number(v)}</text>`;}).join('')}
    </svg><span class="developer-plot-tooltip" role="tooltip">${esc(description)}</span></div>`;
}
export async function mountDevelopers(host, { state, api, reload }) {
  const mountToken = Symbol('developers'); host.developerMount = mountToken;
  const plotFilters={ignoreWithoutFunctions:false,ignoreZeros:false};
  let summaries = new Map(), domain = [0,1], scale = 'linear';
  let draft, data, search = '', sort = 'score', direction = -1, page = 0, request = 0;
  const selected = (items,key) => items.find(p=>p.id===state.selection[key]) ?? items[0];
  const listOptions = (items,id) => items.map(p=>`<option value="${esc(p.id)}" ${p.id===id?'selected':''}>${esc(p.name)}</option>`).join('');
  const select = (label,name,items,value) => `<label>${label}<select name="${name}">${items.map(([id,text])=>`<option value="${id}" ${id===value?'selected':''}>${text}</option>`).join('')}</select></label>`;
  async function refresh() { await reload(); state = await api('state'); }
  function recalculatePlots() {
    if(!data)return;
    summaries=new Map(data.developers.map(p=>[p.id,contributionSummary(p.files,plotFilters)]));
    domain=contributionDomain(data.developers,plotFilters);
  }
  function render() {
    const inspection=selected(state.inspections,'inspection'), scoring=selected(state.presets,'preset'), preset=draft ?? selected(state.developerPresets,'developerPreset') ?? defaults(), c={...defaults().config,...preset.config};
    host.innerHTML=`<section class="graph-workspace developers-workspace"><div class="graph-main"><div class="graph-tools"><h1>Developers</h1><label>Plot scale<select data-plot-scale><option value="linear" ${scale==='linear'?'selected':''}>Linear</option><option value="log1p" ${scale==='log1p'?'selected':''}>Logarithmic (log1p)</option></select></label><label class="checkbox-label"><input type="checkbox" data-plot-filter="ignoreWithoutFunctions" ${plotFilters.ignoreWithoutFunctions?'checked':''}>Ignore files without functions</label><label class="checkbox-label"><input type="checkbox" data-plot-filter="ignoreZeros" ${plotFilters.ignoreZeros?'checked':''}>Ignore zeros</label><label>Search<input data-search type="search" placeholder="Name or email" value="${esc(search)}"></label></div><p class="hint">Current file scores attributed through Git history. Selected path and Git date filters apply; developer merge rules apply. Line counts include comments and whitespace. Rename history is not followed.</p><p data-status role="status"></p><div data-results style="overflow:auto"></div></div><details class="developer-settings"><summary>Developer settings</summary><aside class="graph-sidebar"><label>Inspection<select data-context="inspection">${listOptions(state.inspections,inspection?.id)}</select></label><label>Scoring preset<select data-context="preset">${listOptions(state.presets,scoring?.id)}</select></label><label>Filter<select data-context="filter">${listOptions(state.filters,selected(state.filters,'filter')?.id)}</select></label><label>Developer preset<select data-context="developerPreset">${listOptions(state.developerPresets,preset.id)}</select></label><div class="graph-actions"><button data-new>New</button><button data-duplicate>Duplicate</button><button data-delete ${preset.id?'':'disabled'}>Delete</button></div><form><label>Preset name<input name="name" required value="${esc(preset.name)}"></label>${select('File score normalization','normalization',[['none','Unchanged'],['lines','Per code line'],['scale','Scale to 0–100']],c.normalization)}${select('Contribution size weighting','sizeWeighting',[['none','None (factor 1)'],['size_bytes','Byte size'],['total_lines','Total lines (including comments and blanks)'],['effective_lines','Effective lines of code']],c.sizeWeighting)}<label>Authorship threshold (%)<input name="authorshipThreshold" type="number" min="0" max="100" step="any" required value="${c.authorshipThreshold}"></label><label class="checkbox-label"><input name="renormalizeAuthorship" type="checkbox" ${c.renormalizeAuthorship?'checked':''}>Renormalize remaining authorship to 100%</label><p class="hint">Only original shares strictly above the threshold count. Remaining shares can be renormalized after filtering. Git activity remains visible. Contribution = normalized score × author share × size. Per-code-line normalization and effective-code-line weighting cancel each other for files with code. Zero size gives zero contribution; missing size gives no contribution.</p>${select('File attribution','attribution',[['proportional','Proportional'],['winner','Winner takes all']],c.attribution)}${select('Contribution basis / main author','basis',[['churn','Weighted line changes'],['commits','Commit count']],c.basis)}${select('Merges','merges',[['exclude','Without merges'],['only','Only merges'],['include','Include merges']],c.merges)}<h2>Line weights</h2>${['created','deleted','changed'].map(k=>`<label>${k}<input name="${k}" type="number" min="0" step="any" required value="${c[k]}"></label>`).join('')}<p class="hint">Weights affect attribution, not displayed line counts. If a file has unknown or zero weighted changes, commit shares are used and marked. Files with no code lines have no score in per-line mode.</p><button class="primary">Save &amp; apply</button></form></aside></details></section>`;
    const fail=e=>{ if(host.isConnected && host.developerMount === mountToken && host.querySelector('[data-status]')) host.querySelector('[data-status]').textContent=e.message; };
    host.querySelectorAll('[data-plot-filter]').forEach(el=>el.onchange=()=>{plotFilters[el.dataset.plotFilter]=el.checked;page=0;recalculatePlots();table();});
    host.querySelector('[data-plot-scale]').onchange=e=>{scale=e.target.value;table();};
    host.querySelector('[data-search]').oninput=e=>{ search=e.target.value;page=0;table(); };
    host.querySelectorAll('[data-context]').forEach(el=>el.onchange=async()=>{try{await api('selection','POST',{[el.dataset.context]:el.value});await refresh();draft=undefined;data=undefined;render();}catch(e){fail(e);}});
    host.querySelector('[data-new]').onclick=()=>{draft={...defaults(),name:''};data=undefined;render();};
    host.querySelector('[data-duplicate]').onclick=()=>{draft=structuredClone(preset);delete draft.id;draft.name+=' copy';data=undefined;render();};
    host.querySelector('[data-delete]').onclick=async()=>{try{await api(`developerPresets/${preset.id}`,'DELETE');await refresh();draft=undefined;data=undefined;render();}catch(e){fail(e);}};
    host.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target),config={};for(const key of Object.keys(c)) config[key]=['aggregation','quantile'].includes(key)?c[key]:key==='renormalizeAuthorship'?f.has(key):['created','deleted','changed','authorshipThreshold'].includes(key)?Number(f.get(key)):f.get(key);await api(`developerPresets${preset.id?'/'+preset.id:''}`,preset.id?'PUT':'POST',{name:f.get('name'),config});await refresh();draft=undefined;data=undefined;render();}catch(e){fail(e);}};
    const ticket=++request;
    if(!inspection?.hasResults || !scoring || !preset.id){host.querySelector('[data-status]').textContent='Choose inspection results and saved presets.';return;}
    host.querySelector('[data-status]').textContent='Calculating developers…';
    api(`developers?${new URLSearchParams({inspection:inspection.id,preset:scoring.id,developerPreset:preset.id})}`).then(result=>{if(ticket!==request || host.developerMount !== mountToken || !host.isConnected || !host.querySelector('[data-results]'))return;data=result;
      recalculatePlots();
      host.querySelector('[data-status]').textContent=result.available?'':'New line statistics are not available. Run inspection again.';table();}).catch(fail);
  }
  function table() {
    if(!data)return;
    const fields=[['name','Developer'],['files','Files'],['commits','Commits'],...['created','deleted','changed'].flatMap(k=>[[k,k],[`${k}Average`,`${k} / commit`]])];
    const value=(p,k)=>k==='score'?summaries.get(p.id)?.median:k==='files'||k==='commits'?p[k].length:k.endsWith('Average')?p.perCommit[k.slice(0,-7)]:p.totals[k]??p[k];
    const rows=data.developers.filter(p=>`${p.name} ${p.id}`.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>{const x=value(a,sort),y=value(b,sort);if(x==null)return y==null?0:1;if(y==null)return -1;return direction*(typeof x==='string'?x.localeCompare(y):x-y);});
    page=Math.min(page,Math.max(0,Math.ceil(rows.length/100)-1));
    host.querySelector('[data-results]').innerHTML=`<p>${rows.length} developers · Page ${page+1} / ${Math.max(1,Math.ceil(rows.length/100))} <button data-page="-1" ${page===0?'disabled':''}>Previous</button><button data-page="1" ${(page+1)*100>=rows.length?'disabled':''}>Next</button></p><p class="hint">Score contribution per file (plot filters apply) · Box: Q1–Q3 · Line: median · Whiskers: 5 × IQR · Dots: outliers · Axis capped at global P99 (${number(domain[1])}); › marks values above the limit. <button data-sort="score">Median${sort==='score'?(direction<0?' ↓':' ↑'):''}</button></p><table class="developer-table"><thead><tr>${fields.map(([k,label])=>`<th><button data-sort="${k}">${label}${sort===k?(direction<0?' ↓':' ↑'):''}</button></th>`).join('')}<th>Details</th></tr></thead><tbody>${rows.slice(page*100,page*100+100).map(p=>`<tr class="developer-row">${fields.map(([k])=>`<td>${k==='name'?`<span style="display:inline-block;width:12px;height:12px;background:${p.color}"></span> ${esc(p.name)}<small style="display:block">${esc(p.id)}</small>`:number(value(p,k))}</td>`).join('')}<td><button data-person="${esc(p.id)}">Files / commits</button></td></tr><tr class="developer-plot-row"><td colspan="${fields.length+1}">${boxplot(summaries.get(p.id),domain,p,scale,plotFilters)}</td></tr>`).join('')}</tbody></table><div data-detail></div>`;
    host.querySelectorAll('[data-sort]').forEach(el=>el.onclick=()=>{direction=sort===el.dataset.sort?-direction:-1;sort=el.dataset.sort;table();});
    host.querySelectorAll('[data-page]').forEach(el=>el.onclick=()=>{page+=Number(el.dataset.page);table();});
    host.querySelectorAll('[data-person]').forEach(el=>el.onclick=()=>{
      const p=data.developers.find(p=>p.id===el.dataset.person);
      host.querySelector('[data-detail]').innerHTML=`<h2>${esc(p.name)}</h2><h3>Files</h3><table><thead><tr><th>File</th><th>Raw score</th><th>Normalized score</th><th>Share</th><th>Size factor</th><th>Score contribution</th></tr></thead><tbody>${p.files.map(f=>`<tr><td>${esc(f.path)}${f.fallback?' · Commit-share fallback':''}</td><td>${number(f.rawScore)}</td><td>${number(f.score)}</td><td>${number(f.weight*100)}%</td><td>${number(f.sizeFactor === undefined ? 1 : f.sizeFactor)}</td><td>${number(f.contribution)}</td></tr>`).join('')}</tbody></table><h3>Commits</h3><table><thead><tr><th>Date</th><th>Hash</th><th>Created</th><th>Deleted</th><th>Changed</th></tr></thead><tbody>${p.commits.map(c=>`<tr><td>${esc(c.date)}</td><td title="${esc(c.hash)}">${esc(c.hash.slice(0,12))}</td>${['created','deleted','changed'].map(k=>`<td>${number(c[k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    });
  }
  render();
}
