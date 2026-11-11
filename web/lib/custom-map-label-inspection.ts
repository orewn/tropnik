import type {CustomMapLabelDiagnostic} from './custom-map-engine';

// Existing render-input bounds: 64 visible tiles, 96 labels per tile, and
// 256 additional labels. Retain the decisions already made by the last frame;
// a named inspection must not lose its labels behind 512 unrelated records.
export const MAX_RECORDED_MAP_LABELS=64*96+256;
export const MAP_LABEL_SAMPLE_LIMIT=512;
export const MAP_LABEL_INSPECTION_EVENT='tropnik-map-label-inspection';

export type MapLabelInspectionRequest={schemaVersion:1;names:string[];limit:number};
export function parseMapLabelInspectionRequest(value:unknown):MapLabelInspectionRequest|null{
 if(!value||typeof value!=='object')return null;
 const request=value as Partial<MapLabelInspectionRequest>,limit=request.limit;
 if(request.schemaVersion!==1||!Array.isArray(request.names)||request.names.length<1||request.names.length>100||
   !request.names.every(name=>typeof name==='string'&&name.length>0&&name.length<=160)||
   new Set(request.names).size!==request.names.length||typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>100)return null;
 return{schemaVersion:1,names:[...request.names],limit};
}
export function copyMapLabelDiagnostic(record:CustomMapLabelDiagnostic):CustomMapLabelDiagnostic{
 return{...record,coordinate:[...record.coordinate],...(record.rect?{rect:{...record.rect}}:{})};
}
export function selectRecordedMapLabels(records:readonly CustomMapLabelDiagnostic[],totalCandidates:number,value:unknown){
 const request=parseMapLabelInspectionRequest(value);
 if(!request||!Number.isSafeInteger(totalCandidates)||totalCandidates<records.length||records.length>MAX_RECORDED_MAP_LABELS)return null;
 const names=new Set(request.names),matches=records.filter(record=>names.has(record.label));
 return{schemaVersion:1 as const,names:request.names,limit:request.limit,totalCandidates,retainedCandidates:records.length,
  matchingCandidates:matches.length,truncated:totalCandidates>records.length||matches.length>request.limit,
  candidates:matches.slice(0,request.limit).map(copyMapLabelDiagnostic)};
}
