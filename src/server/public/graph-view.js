const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaults = { mode:'clusters', level:'file', relation:'calls', include:[], exclude:[], resolution:1, weighting:'binary', directed:false, nested:true, targetSize:20, maxDepth:3, minGroup:2, selfLoops:true };
const select = (name,label,value,items) => `<label>${label}<select name="${name}">${items.map(([v,l]) => `<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('')}</select></label>`;
const number = (name,label,value,min,max,step=1) => `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value}" required></label>`;
const checkbox = (name,label,value) => `<label class="checkbox-label"><input type="checkbox" name="${name}" ${value?'checked':''}>${label}</label>`;
export function mountGraph(host, { state, api, reload, openDetail }) {
  let presets = structuredClone(state.graphPresets);
  const selected = state.selection.graphPreset || presets[0]?.id;
  const inspection = state.inspections.find(i=>i.id===state.selection.inspection) || state.inspections[0];
  let draft = presets.find(p=>p.id===selected) || {name:'',config:{...defaults}}, data, request=0, expanded=new Set(), zoom=1, tx=0,ty=0, sceneWidth=1,sceneHeight=1;
  host.innerHTML = `<div class="graph-workspace"><section class="graph-main"><div class="graph-tools"><h1>Dependency graph</h1><button data-graph="fit">Fit</button><button data-graph="in">＋</button><button data-graph="out">−</button><button data-graph="collapse">Collapse all</button><label>Find<input id="graph-search" type="search" placeholder="Name or path"></label></div><p class="hint">A → B means A uses B. Select a group to expand; double-click an element for details. Drag to pan, scroll to zoom.</p><div id="graph-status" role="status"></div><div class="graph-canvas"><svg aria-label="Grouped dependency graph" role="img"></svg></div><div id="graph-warnings" class="hint"></div></section><aside class="graph-sidebar" aria-label="Graph settings"><label>Inspection<select data-select="inspection">${state.inspections.map(i=>`<option value="${esc(i.id)}" ${i.id===inspection?.id?'selected':''}>${esc(i.name)}</option>`).join('')}</select></label><label>Grouping preset<select id="graph-presets"></select></label><div class="graph-actions"><button data-graph="new">New</button><button data-graph="duplicate">Duplicate</button><button data-graph="delete">Delete</button></div><form id="graph-form"></form><section id="graph-evidence" aria-live="polite"><h2>Selection</h2><p class="hint">Select a connection to inspect its source locations.</p></section></aside></div>`;
  const svg=host.querySelector('svg'), status=host.querySelector('#graph-status'), form=host.querySelector('form'), evidence=host.querySelector('#graph-evidence');
  function error(e) { status.textContent=e.message; status.className='graph-error'; }
  function presetOptions() { host.querySelector('#graph-presets').innerHTML=(draft.id?'':'<option value="">Unsaved preset</option>')+presets.map(p=>`<option value="${p.id}" ${p.id===draft.id?'selected':''}>${esc(p.name)}</option>`).join(''); }
  function settings() {
    const c=draft.config;
    presetOptions();
    form.innerHTML=`<label>Preset name<input name="name" value="${esc(draft.name)}" required maxlength="120"></label>${select('mode','Grouping',c.mode,[['clusters','Coupling clusters'],['cycles','Cycle groups']])}${select('level','Elements',c.level,[['file','Files'],['function','Functions']])}${select('relation','Relationships',c.relation,[['calls','Calls'],['references','Symbol / function references'],...(c.level==='file'?[['imports','Imports / reexports']]:[])])}<div data-cluster ${c.mode==='cycles'?'hidden':''}>${number('resolution','Granularity · low = larger groups',c.resolution,.1,5,.1)}</div><details><summary>Advanced settings</summary><label>Include paths<textarea name="include" placeholder="One glob per line">${esc(c.include.join('\n'))}</textarea></label><label>Exclude paths<textarea name="exclude" placeholder="**/*.test.ts">${esc(c.exclude.join('\n'))}</textarea></label><p class="hint">Paths relative to tsconfig. Changing scope recalculates groups. Search only highlights.</p><div data-cluster ${c.mode==='cycles'?'hidden':''}>${select('weighting','Connection weight',c.weighting,[['binary','Each relationship once'],['count','Source occurrences'],['log','Dampened occurrences']])}${checkbox('directed','Use direction for clustering',c.directed)}${checkbox('nested','Create nested subgroups',c.nested)}${number('targetSize','Subdivide groups larger than',c.targetSize,2,200)}${number('maxDepth','Maximum group depth',c.maxDepth,1,6)}<p class="hint">Subdivision is a suggestion; a coherent group may remain larger than the target. Clustering is deterministic.</p></div>${number('minGroup','Minimum size to collapse',c.minGroup,2,100)}${checkbox('selfLoops','Show direct function recursion',c.selfLoops)}</details><button class="primary" type="submit">Save & apply</button><p class="hint" id="graph-dirty">Changes take effect when saved.</p>`;
    form.onchange=event=>{
      const value=read();
      if(value.config.level==='function'&&value.config.relation==='imports') value.config.relation='calls';
      if(['mode','level'].includes(event.target.name)) { draft={...draft,...value}; settings(); }
      host.querySelector('#graph-dirty').textContent='Unsaved changes · Save & apply to recalculate.';
    };
  }
  function read() {
    const f=new FormData(form), c={...draft.config};
    for(const key of ['mode','level','relation','weighting']) c[key]=f.get(key);
    for(const key of ['resolution','targetSize','maxDepth','minGroup']) c[key]=Number(f.get(key));
    for(const key of ['directed','nested','selfLoops']) c[key]=f.has(key);
    for(const key of ['include','exclude']) c[key]=String(f.get(key)).split('\n').map(s=>s.trim()).filter(Boolean);
    return {name:f.get('name'),config:c};
  }
  form.onsubmit=async event=>{
    event.preventDefault(); const button=form.querySelector('[type=submit]'); button.disabled=true;
    try { const saved=await api(`graphPresets${draft.id?'/'+draft.id:''}`,draft.id?'PUT':'POST',read());
      presets=presets.filter(p=>p.id!==saved.id).concat(saved); draft=saved; settings(); await reload(); await fetchGraph();
    } catch(e){error(e);} finally { button.disabled=false; }
  };
  async function fetchGraph() {
    const current=++request; expanded.clear(); data=null; svg.replaceChildren(); evidence.innerHTML='<h2>Selection</h2>'; status.className='';
    if(!inspection?.hasResults || !draft.id) { status.textContent='Choose an inspection with results and save a grouping preset.'; return; }
    status.textContent='Calculating groups…';
    try { const result=await api(`graph?inspection=${encodeURIComponent(inspection.id)}&preset=${draft.id}`); if(current!==request || !svg.isConnected) return;
      data=result; status.textContent=`${data.nodes.length} elements · ${data.edges.length} relationships · ${data.cycleCount} cycle groups`;
      host.querySelector('#graph-warnings').textContent=data.warnings.join(' '); draw(true);
    }catch(e){if(current===request)error(e);}
  }
  host.querySelector('#graph-presets').onchange=async event=>{ if(!event.target.value)return; try { await api('selection','POST',{graphPreset:event.target.value}); draft=structuredClone(presets.find(p=>p.id===event.target.value)); settings(); await reload(); await fetchGraph(); }catch(e){error(e);} };
  host.addEventListener('click',async event=>{
    const action=event.target.closest('[data-graph]')?.dataset.graph;
    if(!action)return;
    try {
      if(action==='new'||action==='duplicate') { draft=action==='new'?{name:'',config:{...defaults}}:{...read(),name:read().name+' copy'}; settings(); return; }
      if(action==='delete') { if(!draft.id)return; if(!confirm(`Delete graph preset "${draft.name}"?`))return; await api(`graphPresets/${draft.id}`,'DELETE');presets=presets.filter(p=>p.id!==draft.id);draft=structuredClone(presets[0]||{name:'',config:{...defaults}});settings();await reload();await fetchGraph();return; }
      if(action==='collapse'){expanded.clear();draw(true);}
      if(action==='fit')fit();
      if(action==='in'||action==='out'){zoom*=action==='in'?1.2:1/1.2;transform();}
    }catch(e){error(e);}
  });
  host.querySelector('#graph-search').oninput=()=>draw();
  function transform(){svg.querySelector('.graph-scene')?.setAttribute('transform',`translate(${tx},${ty}) scale(${zoom})`);}
  function fit(){const r=svg.getBoundingClientRect();zoom=Math.min(r.width/sceneWidth,r.height/sceneHeight,.95)*.92;tx=(r.width-sceneWidth*zoom)/2;ty=(r.height-sceneHeight*zoom)/2;transform();}
  function detailsLink(kind,id,label,line){return `<button class="graph-source" data-kind="${kind}" data-id="${esc(id)}" ${line?`data-line="${line}"`:''}>${esc(label)}</button>`;}
  evidence.onclick=e=>{const b=e.target.closest('[data-kind]');if(b)openDetail(b.dataset.kind,b.dataset.id,b.dataset.line);};
  function showEdges(edges){
    const total=edges.reduce((n,e)=>n+e.count,0), rows=edges.flatMap(e=>e.evidence);
    evidence.innerHTML=`<h2>${edges.length} relationships · ${total} occurrences</h2><p class="hint">Static source occurrences, not runtime frequency. Showing up to 100 locations per relationship.</p>${rows.slice(0,300).map(r=>`<p>${detailsLink('file',r.file,`${r.file}:${r.line}`,r.line)}<small>${esc(r.kind)} · ${esc(r.name)}</small></p>`).join('')}${rows.length>300?'<p>Only the first 300 locations are displayed.</p>':''}`;
  }
  function draw(reset=false){
    if(!data)return;
    const byId=new Map(data.nodes.map(n=>[n.id,n])), visible=[], boxes=[], owner=new Map();
    function size(item){
      const box={...item,w:220,h:64};
      if(item.children&&expanded.has(item.id)){
        box.open=true;box.items=item.children.map(size);const columns=Math.max(1,Math.ceil(Math.sqrt(box.items.length)));
        const widths=Array(columns).fill(0), heights=[];
        box.items.forEach((b,i)=>{widths[i%columns]=Math.max(widths[i%columns],b.w);heights[Math.floor(i/columns)]=Math.max(heights[Math.floor(i/columns)]||0,b.h);});
        box.items.forEach((b,i)=>{b.dx=20+widths.slice(0,i%columns).reduce((a,v)=>a+v+90,0);b.dy=48+heights.slice(0,Math.floor(i/columns)).reduce((a,v)=>a+v+90,0);});
        box.w=40+widths.reduce((a,v)=>a+v,0)+90*(columns-1);box.h=68+heights.reduce((a,v)=>a+v,0)+90*(heights.length-1);
      }return box;
    }
    const roots=data.groups.map(size), columns=Math.max(1,Math.ceil(Math.sqrt(roots.length))), widths=Array(columns).fill(0), heights=[];
    roots.forEach((b,i)=>{widths[i%columns]=Math.max(widths[i%columns],b.w);heights[Math.floor(i/columns)]=Math.max(heights[Math.floor(i/columns)]||0,b.h);});
    function place(b,x,y){b.x=x;b.y=y;boxes.push(b);if(b.open)b.items.forEach(child=>place(child,x+child.dx,y+child.dy));else {visible.push(b);for(const id of b.members)owner.set(id,b);}}
    roots.forEach((b,i)=>place(b,30+widths.slice(0,i%columns).reduce((a,v)=>a+v+100,0),30+heights.slice(0,Math.floor(i/columns)).reduce((a,v)=>a+v+100,0)));
    sceneWidth=60+widths.reduce((a,v)=>a+v,0)+100*Math.max(0,columns-1);sceneHeight=60+heights.reduce((a,v)=>a+v,0)+100*Math.max(0,heights.length-1);
    const bundled=new Map();
    for(const edge of data.edges){const a=owner.get(edge.source),b=owner.get(edge.target);if(!a||!b||a===b&&a.children)continue;const key=JSON.stringify([a.id,b.id]);const row=bundled.get(key)||{a,b,edges:[]};row.edges.push(edge);bundled.set(key,row);}
    const connections=[...bundled.values()],search=host.querySelector('#graph-search').value.toLowerCase();
    const match=b=>search&&b.members.some(id=>{const n=byId.get(id);return `${n.label} ${n.file}`.toLowerCase().includes(search);});
    svg.innerHTML=`<defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs><g class="graph-scene"><g>${boxes.filter(b=>b.open).map(b=>`<g class="graph-box open ${b.cycle?'cycle':''}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12"/><text data-node="${esc(b.id)}" tabindex="0" role="button" x="${b.x+15}" y="${b.y+26}">− ${esc(b.label)}</text></g>`).join('')}</g><g class="graph-edges">${connections.map(({a,b,edges},i)=>{const x=a.x+a.w/2,y=a.y+a.h/2,x2=b.x+b.w/2,y2=b.y+b.h/2;let d,mx,my;
      if(a===b){d=`M ${a.x+a.w-15} ${a.y} C ${a.x+a.w+60} ${a.y-60}, ${a.x+a.w+60} ${a.y+50}, ${a.x+a.w} ${a.y+32}`;mx=a.x+a.w+25;my=a.y-10;}
      else {const dx=x2-x,dy=y2-y,ratio=Math.max(Math.abs(dx)/(b.w/2+8),Math.abs(dy)/(b.h/2+8));const startRatio=Math.max(Math.abs(dx)/(a.w/2+8),Math.abs(dy)/(a.h/2+8));const sx=x+dx/startRatio,sy=y+dy/startRatio,ex=x2-dx/ratio,ey=y2-dy/ratio;const length=Math.hypot(dx,dy),bend=Math.max(40,length*.12);const cx=(sx+ex)/2-dy/length*bend,cy=(sy+ey)/2+dx/length*bend;d=`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;mx=(sx+2*cx+ex)/4;my=(sy+2*cy+ey)/4;}
      return `<g data-edge="${i}" tabindex="0" role="button" aria-label="${esc(a.label||byId.get(a.id)?.label)} uses ${esc(b.label||byId.get(b.id)?.label)}"><path class="graph-edge-hit" d="${d}"/><path class="graph-edge-line" d="${d}" marker-end="url(#graph-arrow)"/><text x="${mx}" y="${my-5}">${edges.length}</text></g>`;}).join('')}</g><g>${visible.map(b=>{const n=byId.get(b.id),label=b.label||n?.label||b.id;return `<g class="graph-box ${b.children?'group':'leaf'} ${b.cycle?'cycle':''} ${match(b)?'match':''}" data-node="${esc(b.id)}" tabindex="0" role="button" aria-label="${esc(label)}"><title>${esc(n?`${n.label}\n${n.file}`:label)}${b.cycle?' · cycle member':''}</title><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8"/><text x="${b.x+12}" y="${b.y+26}">${b.children?'+ ':''}${esc(label.length>27?label.slice(0,25)+'…':label)}</text><text class="graph-node-sub" x="${b.x+12}" y="${b.y+46}">${esc(b.children?'Expand group':n?.file.split('/').at(-1))}${b.cycle?' · cycle':''}</text></g>`;}).join('')}</g></g>`;
    svg.onclick=e=>{
      const edge=e.target.closest('[data-edge]');if(edge){showEdges(connections[Number(edge.dataset.edge)].edges);return;}
      const element=e.target.closest('[data-node]');if(!element)return;const b=boxes.find(b=>b.id===element.dataset.node);
      if(b.children){expanded.has(b.id)?expanded.delete(b.id):expanded.add(b.id);draw();}
      else {const n=byId.get(b.id);evidence.innerHTML=`<h2>${esc(n.label)}</h2><p>${esc(n.file)}</p>${detailsLink(n.kind,n.id,'Open details')}<p class="hint">${b.cycle?'Member of a cycle group.':''}</p>`;}
    };
    svg.ondblclick=e=>{const id=e.target.closest('[data-node]')?.dataset.node,n=byId.get(id);if(n)openDetail(n.kind,n.id);};
    svg.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){if(e.target.matches('[data-node],[data-edge]')){e.preventDefault();e.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}}};
    if(reset)fit();else transform();
    if(!data.nodes.length)status.textContent='No elements match this scope.';
  }
  let drag;
  svg.onpointerdown=e=>{if(e.target.closest('[data-node],[data-edge]'))return;drag={x:e.clientX,y:e.clientY,tx,ty};svg.setPointerCapture(e.pointerId);};
  svg.onpointermove=e=>{if(drag){tx=drag.tx+e.clientX-drag.x;ty=drag.ty+e.clientY-drag.y;transform();}};
  svg.onpointerup=svg.onpointercancel=()=>{drag=null;};
  svg.addEventListener('wheel',e=>{e.preventDefault();const r=svg.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,newZoom=Math.max(.02,Math.min(5,zoom*Math.exp(-e.deltaY*.001)));tx=x-(x-tx)*newZoom/zoom;ty=y-(y-ty)*newZoom/zoom;zoom=newZoom;transform();},{passive:false});
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => { if (!svg.isConnected) observer.disconnect(); else if (data) fit(); });
    observer.observe(svg);
  }
  settings();fetchGraph();
}
