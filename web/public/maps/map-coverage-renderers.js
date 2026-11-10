import {leafletRussiaMask,MAP_OUTSIDE_COLOR} from './russia-viewport.js';

function coverageSnapshot(cells,data) {
  if(!cells||data?.type!=='FeatureCollection'||!Array.isArray(data.features))return;
  const features=new Map();
  for(const feature of data.features){
    const id=feature.id,cell=feature.properties?.cell;
    if((typeof id!=='string'&&!(typeof id==='number'&&Number.isFinite(id)))||features.has(id)||!cells.has(cell))return;
    features.set(id,feature);
  }
  return {cells,features};
}
function coverageDiff(previous,next) {
  const remove=[],add=[];
  for(const id of previous.features.keys())if(!next.features.has(id))remove.push(id);
  for(const [id,feature] of next.features){
    const cell=feature.properties.cell;
    if(!previous.features.has(id)||previous.cells.get(cell)!==next.cells.get(cell))add.push(feature);
  }
  // Adding an existing ID replaces its whole feature, including removed
  // properties. Use the composed role's geometry, including canonical masks.
  return {remove,add};
}

/** One map owns the submitted cell snapshots for its public GeoJSON sources.
 * Unchanged cells keep their worker data; all changed roles are submitted in
 * the same task. Camera, source options, layer order and filters stay intact. */
export function createMapLibreCoverage(map) {
  const records=new Map(),pending=new Set();let disposed=false,epoch=0;
  const current=record=>{try{return record.epoch===epoch&&map.getSource(record.id)===record.source;}catch{return false;}};
  const loaded=record=>{try{return current(record)&&map.isSourceLoaded(record.id);}catch{return false;}};
  const invalidate=(record,error)=>{
    record.snapshot=undefined;record.ready=false;record.flushed=false;record.serial++;
    for(const job of [...pending])if(job.records.includes(record))job.fail(error);
  };
  const release=(record,error)=>{
    invalidate(record,error);record.source.off('error',record.error);records.delete(record.source);
  };
  const check=()=>{
    for(const job of [...pending]){
      if(job.submitting)continue;
      if(job.records.some(record=>!current(record))){job.fail(new Error('coverage-render-removed'));continue;}
      if(job.records.every(record=>record.ready&&record.flushed&&loaded(record)))job.done();
    }
  };
  const render=()=>{
    for(const record of [...records.values()]){
      if(!current(record))release(record,new Error('coverage-render-removed'));
      else if(record.flushed&&loaded(record))record.ready=true;
    }
    check();
  };
  const reset=()=>{
    epoch++;
    for(const job of [...pending])job.fail(new Error('coverage-render-removed'));
    for(const record of records.values())record.source.off('error',record.error);
    records.clear();
  };
  const destroy=()=>{
    if(disposed)return;disposed=true;reset();
    map.off('render',render);map.off('style.load',reset);map.off('remove',destroy);
  };
  const sourceRecord=(id,source)=>{
    let record=records.get(source);
    if(record)return record;
    record={id,source,epoch,serial:0,ready:false,flushed:false,snapshot:undefined,error:undefined};
    // The SDK's flush promise also resolves after worker errors. Listen before
    // submitting, and invalidate every queued descendant on that same source.
    record.error=event=>{if(records.get(source)===record&&current(record))invalidate(record,event.error??new Error('coverage-render-source'));};
    source.on('error',record.error);records.set(source,record);return record;
  };
  const submit=(record,data,snapshot,diff)=>{
    const serial=++record.serial;record.ready=false;record.flushed=false;record.snapshot=snapshot;
    const failed=error=>{
      // A replaced object is independent. A source reused by a new style is
      // not: a late rejection must conservatively invalidate its new snapshot.
      const active=records.get(record.source);
      if(active&&current(active))invalidate(active,error);
    };
    try{
      const result=diff?record.source.updateData(diff):record.source.setData(data);
      if(result?.then)Promise.resolve(result).then(()=>{
        if(records.get(record.source)===record&&record.serial===serial){record.flushed=true;check();}
      },failed);
      else if(record.serial===serial)record.flushed=true;
    }catch(error){failed(error);}
  };
  const apply=coverage=>{
    if(disposed)return Promise.reject(new Error('coverage-render-removed'));
    for(const record of [...records.values()])if(!current(record))release(record,new Error('coverage-render-removed'));
    const cells=coverage.cellFeatures instanceof Map?new Map(coverage.cellFeatures):undefined,snapshots=new Map();
    const data={'land':coverage.area,'overview-land':coverage.area,'russia-land':coverage.area,'russia-mask':coverage.mask,'regions':coverage.territories,'regions-outline':coverage.boundaries};
    const entries=[];
    for(const [id,value] of Object.entries(data)){
      const source=map.getSource(id);if(typeof source?.setData!=='function')continue;
      const record=sourceRecord(id,source);
      if(!snapshots.has(value))snapshots.set(value,coverageSnapshot(cells,value));
      const snapshot=snapshots.get(value);
      const diff=record.snapshot&&snapshot&&typeof source.updateData==='function'?coverageDiff(record.snapshot,snapshot):undefined;
      entries.push({record,data:value,snapshot,diff,changed:!diff||!!(diff.remove.length||diff.add.length)});
    }
    if(!entries.length)return;
    return new Promise((resolve,reject)=>{
      let timer,settled=false;
      const finish=(failed,error)=>{if(settled)return;settled=true;clearTimeout(timer);pending.delete(job);if(failed)reject(error??new Error('coverage-render-source'));else resolve();};
      const job={records:entries.map(entry=>entry.record),submitting:true,done:()=>finish(false),fail:error=>finish(true,error)};
      pending.add(job);
      timer=setTimeout(()=>{for(const record of job.records)invalidate(record,new Error('coverage-render-timeout'));},15000);
      for(const entry of entries){
        if(settled)break;
        if(entry.changed)submit(entry.record,entry.data,entry.snapshot,entry.diff);
        else entry.record.snapshot=entry.snapshot;
      }
      job.submitting=false;
      // A no-op on already rendered, loaded sources needs no new frame. A
      // pending predecessor still has ready=false and keeps this barrier open.
      check();
    });
  };
  // Install reset before bindMapCoverage's style.load publisher.
  map.on('render',render);map.on('style.load',reset);map.on('remove',destroy);
  return {apply,destroy};
}

/** Keep persistent overview cells and replace only changed visible leaves.
 * One renderer per role avoids hundreds of canvases. Administrative outlines
 * come from actual source lines, never a polygon's artificial cell perimeter. */
export function createCanvasCoverage(L,map,options={}) {
  const renderer=options.renderer??(settings=>L.canvas(settings));
  const landRenderer=renderer({pane:'russia-land',padding:.15}),maskRenderer=renderer({pane:'russia-mask',padding:.15});
  // Routes and regions must share the map's interactive Canvas: a later
  // route Canvas intercepts clicks even through all of its transparent pixels.
  const adminRenderer=map.options.renderer??renderer({padding:.15});
  map.options.renderer??=adminRenderer;
  const cullLand=options.cull?.(landRenderer),cullMask=options.cull?.(maskRenderer),cullAdmin=options.cull?.(adminRenderer);
  const land=L.geoJSON(null).addTo(map),mask=L.geoJSON(null).addTo(map),territories=L.geoJSON(null).addTo(map),cells=new Map();
  const style=feature=>({...options.territoryStyle?.(feature),smoothFactor:0,stroke:feature?.properties?.role==='territory-boundary',fill:feature?.properties?.role==='territory'});
  const add=(target,data,settings)=>{
    const layers=L.geoJSON(data,settings).getLayers();for(const layer of layers)target.addLayer(layer);return layers;
  };
  const apply=coverage=>{
    for(const [id,features] of coverage.cellFeatures){
      const previous=cells.get(id);if(previous?.features===features)continue;
      if(previous){for(const layer of previous.land)land.removeLayer(layer);for(const layer of previous.mask)mask.removeLayer(layer);for(const layer of previous.territories)territories.removeLayer(layer);}
      const role=name=>({type:'FeatureCollection',features:features.filter(item=>item.properties.role===name)});
      const next={features,
        land:add(land,role('area'),{pane:'russia-land',renderer:landRenderer,interactive:false,style:{smoothFactor:0,stroke:false,fillColor:'#dbe4cd',fillOpacity:1},onEachFeature:(_feature,layer)=>{if(layer instanceof L.Polyline)cullLand?.(layer);}}),
        mask:add(mask,leafletRussiaMask(role('mask')),{pane:'russia-mask',renderer:maskRenderer,interactive:false,style:{smoothFactor:0,stroke:false,fillColor:MAP_OUTSIDE_COLOR,fillOpacity:1,fillRule:'evenodd'},onEachFeature:(_feature,layer)=>{if(layer instanceof L.Polyline)cullMask?.(layer);}}),
        territories:add(territories,{type:'FeatureCollection',features:features.filter(item=>item.properties.role==='territory'||item.properties.role==='territory-boundary')},{renderer:adminRenderer,style,interactive:false,onEachFeature:(feature,layer)=>{
          // Canvas chooses the topmost interactive path. The decorative
          // outline must not intercept a polygon's region-selection click.
          layer.options.interactive=feature.properties.role==='territory'&&!!options.onTerritory;
          if(layer instanceof L.Polyline)cullAdmin?.(layer);
          if(feature.properties.role==='territory')options.onTerritory?.(feature,layer);
        }}),
      };
      // A late LOD leaf must stay below routes already in the shared Canvas.
      // Reverse insertion preserves the fill-before-outline order of the cell.
      for(let index=next.territories.length-1;index>=0;index--)next.territories[index].bringToBack();
      cells.set(id,next);
    }
  };
  return {apply,territories,restyle:()=>territories.setStyle(style),destroy:()=>{land.remove();mask.remove();territories.remove();cells.clear();}};
}
