import {leafletRussiaMask,MAP_OUTSIDE_COLOR} from './russia-viewport.js';

/** Update existing public GeoJSON sources and wait for the SDK to finish their
 * worker work. The caller retains camera, layer order and selected filters. */
export function applyMapLibreCoverage(map,coverage) {
  const data={'land':coverage.area,'overview-land':coverage.area,'russia-land':coverage.area,'russia-mask':coverage.mask,'regions':coverage.territories,'regions-outline':coverage.boundaries};
  const entries=Object.entries(data).map(([id,value])=>[id,map.getSource(id),value]).filter(([,source])=>typeof source?.setData==='function');
  if(!entries.length)return;
  return new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);map.off('render',check);map.off('remove',removed);map.off('style.load',removed);};
    const removed=()=>{cleanup();reject(new Error('coverage-render-removed'));};
    const check=()=>{
      try{if(!entries.every(([id,source])=>map.getSource(id)===source&&map.isSourceLoaded(id)))return;}
      catch{return;}
      cleanup();resolve();
    };
    map.on('render',check);map.on('remove',removed);map.on('style.load',removed);
    timer=setTimeout(()=>{cleanup();reject(new Error('coverage-render-timeout'));},15000);
    for(const [,source,value] of entries)source.setData(value);
  });
}

/** Keep persistent overview cells and replace only changed visible leaves.
 * One renderer per role avoids hundreds of canvases. Administrative outlines
 * come from actual source lines, never a polygon's artificial cell perimeter. */
export function createCanvasCoverage(L,map,options={}) {
  const renderer=options.renderer??(settings=>L.canvas(settings));
  const landRenderer=renderer({pane:'russia-land',padding:.15}),maskRenderer=renderer({pane:'russia-mask',padding:.15});
  const adminRenderer=renderer({padding:.15});
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
      };cells.set(id,next);
    }
  };
  return {apply,territories,restyle:()=>territories.setStyle(style),destroy:()=>{land.remove();mask.remove();territories.remove();cells.clear();}};
}
