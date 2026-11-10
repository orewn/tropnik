import type {SoftwareMapRenderer} from './map-renderer-capabilities.ts';

export function terrainPitchForZoom(zoom:number,focused=false,softwareRenderer?:SoftwareMapRenderer){
  const safe=Number.isFinite(zoom)?zoom:2;
  const pitch=safe<2.5?(focused?20:14):safe<4.5?(focused?28:22):safe<7?(focused?38:32):safe<10?(focused?46:42):focused?50:46;
  // Diagnostic candidate: shallower default framing may reduce the visible
  // terrain workload on software rasterizers. Native data and resolution stay
  // unchanged; manual camera rotation is not limited by this default profile.
  return softwareRenderer?Math.min(pitch,30):pitch;
}

export function terrainExaggerationForZoom(zoom:number){
  const safe=Number.isFinite(zoom)?zoom:2;
  if(safe<2.5)return .72;
  if(safe<4.5)return .82;
  if(safe<7)return .94;
  if(safe<10)return 1.04;
  return 1.12;
}
