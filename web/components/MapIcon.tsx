/** Original Tropnik symbols: 28×28 construction grid, 24px optical size. */
export type MapIconName='terrain'|'satellite'|'map'|'compass'|'location'|'layers'|'fit'|'plus'|'minus'|'camp'|'water'|'shelter'|'pass'|'peak'|'viewpoint'|'back'|'rotate'|'info';
const paths:Record<MapIconName,string[]>={
 terrain:['M3 23 10 10l4 6 5-12 6 19H3Z','m7 17 3-3 4 4','m17 10 2 3 2-3'],
 satellite:['m10 13 5-5 5 5-5 5-5-5Z','m4 7 4-4 5 5-4 4-5-5Zm13 13 4-4 4 4-4 4-4-4Z','m12 16-3 3','M4 17a7 7 0 0 1 7 7M4 21a3 3 0 0 1 3 3'],
 map:['m3 7 7-3 8 3 7-3v18l-7 3-8-3-7 3V7Z','M10 4v18m8-15v18','m5 16 3-3 4 2 4-4 6 3'],
 compass:['M14 2v3m0 18v3M2 14h3m18 0h3','M23 14a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','m17.5 7-1 9-6 5 1-9 6-5Z','m11.5 12 5 4'],
 location:['m14 3 9 21-9-5-9 5 9-21Z','M14 8v11'],
 layers:['m14 3 11 6-11 6L3 9l11-6Z','m3 14 11 6 11-6M3 19l11 6 11-6'],
 fit:['M10 4H4v6m14-6h6v6M4 18v6h6m14-6v6h-6','m10 17 4-7 4 7h-8Z'],
 plus:['M14 5v18M5 14h18'],minus:['M5 14h18'],
 camp:['m4 23 10-18 10 18H4Z','m10 23 4-8 4 8M11 2l3 3 3-3','M2 25h24'],
 water:['M14 3c-2 4-7 9-7 14a7 7 0 0 0 14 0c0-5-5-10-7-14Z','M10 18c0 2 1 3 3 3','M4 25h20'],
 shelter:['m3 13 11-10 11 10M6 11v13h16V11','M11 24v-8h6v8','M3 26h22'],
 pass:['m2 22 6-13 6 8 6-8 6 13','M8 5v4m12-4v4','m11 24 3-7 3 7'],
 peak:['m3 24 11-20 11 20H3Z','m10 11 4 3 4-3','M14 4V1m7 4 2-2M7 5 5 3'],
 viewpoint:['M3 15s4-7 11-7 11 7 11 7-4 7-11 7S3 15 3 15Z','m9 17 5-8 5 8H9Z','M14 3V1m-9 5L3 4m20 2 2-2'],
 back:['M23 14H5m8-8-8 8 8 8'],
 rotate:['M7 8a9 9 0 1 1-2 10','M3 4v7h7','m12 18 3-5 3 5h-6Z'],
 info:['M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z','M13 12h2v8m-2 0h4','M14 8v.01']
};
export function MapIcon({name,size=24}:{name:MapIconName;size?:number}){return <svg className="map-icon" width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-map-icon={name}>{paths[name].map((d,i)=><path d={d} key={i}/>)}</svg>;}
