export function terrainPitchForZoom(zoom:number,focused=false){
  const safe=Number.isFinite(zoom)?zoom:2;
  if(safe<2.5)return focused?20:14;
  if(safe<4.5)return focused?28:22;
  if(safe<7)return focused?38:32;
  if(safe<10)return focused?46:42;
  return focused?50:46;
}

export function terrainExaggerationForZoom(zoom:number){
  const safe=Number.isFinite(zoom)?zoom:2;
  if(safe<2.5)return .72;
  if(safe<4.5)return .82;
  if(safe<7)return .94;
  if(safe<10)return 1.04;
  return 1.12;
}
