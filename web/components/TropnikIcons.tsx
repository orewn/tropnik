import type {CSSProperties,SVGProps} from 'react';
/** Original Тропник symbol family. 28px grid, open paths, waypoint endpoints.
 * Drawings are project-owned; names retain source compatibility with product components.
 */
type Props=Omit<SVGProps<SVGSVGElement>,'size'> & {size?:number|string;weight?:'thin'|'light'|'regular'|'bold'|'fill'|'duotone';mirrored?:boolean};
const drawings={
 ArrowRight:['M5 14h18m-7-7 7 7-7 7','M3 14h.01'],
 ArrowLeft:['M23 14H5m7-7-7 7 7 7','M25 14h.01'],
 ArrowUp:['M14 23V5m-7 7 7-7 7 7','M14 25v.01'],
 ArrowDown:['M14 3v20m-7-7 7 7 7-7','M14 25v.01'],
 ArrowUpRight:['M6 22 22 6M10 6h12v12','M4 24h.01'],
 ArrowSquareOut:['M16 4h8v8m0-8L12 16','M11 5H5v18h18v-6'],
 ArrowClockwise:['M23 11A9 9 0 1 0 23 18','M23 4v7h-7','M13 11v5h4'],
 ArrowsOut:['M4 10V4h6m8 0h6v6M4 18v6h6m14-6v6h-6','m4-4 6 6m10-6-6 6m-10 10 6-6m10 6-6-6'],
 CaretLeft:['m17 6-8 8 8 8','M6 14h.01'],CaretRight:['m11 6 8 8-8 8','M22 14h.01'],
 Backpack:['M7 8a7 7 0 0 1 14 0v17H7V8Z','M10 3V1h8v2M7 13H4v9h3m14-9h3v9h-3','M10 17h8v5h-8v-5ZM10 10h8'],
 Bell:['M6 20h16l-2-4V11a6 6 0 0 0-12 0v5l-2 4Z','M11 24h6M14 2v3','M3 11V8m22 0v3'],
 BookmarkSimple:['M7 3h14v22l-7-5-7 5V3Z','M11 9h6m-6 4h4'],
 CalendarBlank:['M5 6h18v19H5V6Z','M9 3v6m10-6v6M5 12h18','M9 17h2m6 0h2m-10 4h2'],
 CalendarCheck:['M5 6h18v19H5V6Z','M9 3v6m10-6v6M5 12h18','m9 18 3 3 7-6'],
 ChatCircleDots:['M5 4h18v16H12l-7 5V4Z','M9 12h.01M14 12h.01M19 12h.01'],
 ChatCircleText:['M5 4h18v16H12l-7 5V4Z','M9 9h10m-10 5h7'],
 Check:['m5 14 6 6L23 7','M3 14h.01'],
 CheckCircle:['m4 10 3-5 7-2 7 2 3 5v8l-3 5-7 2-7-2-3-5v-8Z','m9 14 4 4 7-8'],
 Clock:['M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z','M14 7v7l5 3','M14 2v2m0 20v2'],
 Compass:['M14 2v3m0 18v3M2 14h3m18 0h3','M23 14a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','m17.5 7-1 9-6 5 1-9 6-5Zm-6 5 5 4'],
 DownloadSimple:['M14 3v15m-6-6 6 6 6-6','M4 19v6h20v-6','M9 22h10'],
 Export:['M14 18V3m-6 6 6-6 6 6','M7 13H4v12h20V13h-3'],
 Flag:['M6 26V3h16l-4 5 4 5H6','M3 26h6'],
 Gavel:['m10 4 4-3 11 11-4 4L10 4Z','m6 7 4-3 11 12-4 3L6 7Z','m12 14-8 9m12 1h10'],
 Info:['M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z','M13 12h2v8m-2 0h4','M14 8v.01'],
 List:['M4 7h20M4 14h14M4 21h20','M22 14h2'],
 LockKey:['M6 12h16v13H6V12Z','M9 12V7a5 5 0 0 1 10 0v5','M14 17v4'],
 MagnifyingGlass:['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z','m18 18 7 7M8 12a4 4 0 0 1 4-4'],
 MapPin:['M22 10c0 6-8 15-8 15S6 16 6 10a8 8 0 0 1 16 0Z','m11 13 3-6 3 6h-6Z'],
 MapTrifold:['m3 7 7-3 8 3 7-3v18l-7 3-8-3-7 3V7Z','M10 4v18m8-15v18','m5 15 2-2m5-2 2 2 2-1m4 4 3-3'],
 Medal:['m8 17-3 9 6-2 3 2 3-2 6 2-3-9','m14 2 8 4 1 8-9 7-9-7 1-8 8-4Z','m10 14 4-7 4 7h-8Z'],
 Minus:['M5 14h18'],Plus:['M14 5v18M5 14h18'],
 Mountains:['M3 23 10 10l4 5 4-11 7 19H3Z','m8 12 3 3 4-6','M6 23c2-4 4-5 7-5m0 5c2-3 5-4 9-4'],
 NavigationArrow:['m14 3 9 21-9-5-9 5 9-21Z','M14 8v11'],
 NotePencil:['M13 4H5v21h18v-9','m12 15 2 2 11-11-4-4-11 11-1 5 5-1Z','m18 4 4 4M9 22h10'],
 PaperPlaneTilt:['M3 4 25 13 3 24l4-10-4-10Z','m7 14 15-1M7 14l4 7'],
 Path:['M6 5h13a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h13','M7 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM24 21a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z'],
 Pause:['M8 5v18M20 5v18'],Play:['m8 4 16 10-16 10V4Z'],
 ShieldCheck:['m14 2 10 4v8c0 5-5 9-10 12C9 23 4 19 4 14V6l10-4Z','m9 13 4 4 6-7'],
 SlidersHorizontal:['M3 7h7m6 0h9M3 21h13m6 0h3M3 14h2m6 0h14','M10 4h6v6h-6V4Zm-5 7h6v6H5v-6Zm11 7h6v6h-6v-6Z'],
 Stack:['m14 3 11 6-11 6L3 9l11-6Z','m3 14 11 6 11-6M3 19l11 6 11-6'],
 Star:['m14 2 4 8 9 2-7 6 1 9-7-5-7 5 1-9-7-6 9-2 4-8Z'],
 Trash:['M7 8h14l-1 17H8L7 8ZM4 8h20','M10 8V3h8v5m-6 5v7m4-7v7'],
 Tree:['m14 2 7 9h-4l6 9H5l6-9H7l7-9Z','M14 15v11M9 26h10'],
 UserCircle:['M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z','M18 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z','M7 21a7 7 0 0 1 14 0'],
 UsersThree:['M18 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z','M8 24v-6a6 6 0 0 1 12 0v6','M6 7a3 3 0 0 0 0 6m-2 3a4 4 0 0 0-2 4v3M22 7a3 3 0 0 1 0 6m2 3a4 4 0 0 1 2 4v3'],
 WaveSine:['M2 11c5-12 7 12 12 0s7 12 12 0M2 19c5-12 7 12 12 0s7 12 12 0'],
 WifiSlash:['M3 9a18 18 0 0 1 22 0M7 13a12 12 0 0 1 9-2M11 18a5 5 0 0 1 3-1','M14 23h.01M3 3l22 22'],
 X:['M7 7 21 21M21 7 7 21','M4 4h.01M24 24h.01']
} as const;
function makeIcon(name:keyof typeof drawings){
 const Icon=({size=24,weight='regular',mirrored=false,style,...props}:Props)=>{
 const selected=weight==='fill'&&(name==='Star'||name==='BookmarkSimple');
 return <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth={weight==='bold'?1.9:weight==='thin'?1:weight==='light'?1.25:1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-tropnik-icon={name} style={{...(mirrored?{transform:'scaleX(-1)'}:{}),...style} as CSSProperties} {...props}>{drawings[name].map((d,i)=><path key={i} d={d} fill={selected&&i===0?'currentColor':'none'}/>)}</svg>;
 }; Icon.displayName=`Tropnik${name}`; return Icon;
}

export const ArrowClockwise=makeIcon('ArrowClockwise');
export const ArrowDown=makeIcon('ArrowDown');
export const ArrowLeft=makeIcon('ArrowLeft');
export const ArrowRight=makeIcon('ArrowRight');
export const ArrowSquareOut=makeIcon('ArrowSquareOut');
export const ArrowUp=makeIcon('ArrowUp');
export const ArrowUpRight=makeIcon('ArrowUpRight');
export const ArrowsOut=makeIcon('ArrowsOut');
export const Backpack=makeIcon('Backpack');
export const Bell=makeIcon('Bell');
export const BookmarkSimple=makeIcon('BookmarkSimple');
export const CalendarBlank=makeIcon('CalendarBlank');
export const CalendarCheck=makeIcon('CalendarCheck');
export const CaretLeft=makeIcon('CaretLeft');
export const CaretRight=makeIcon('CaretRight');
export const ChatCircleDots=makeIcon('ChatCircleDots');
export const ChatCircleText=makeIcon('ChatCircleText');
export const Check=makeIcon('Check');
export const CheckCircle=makeIcon('CheckCircle');
export const Clock=makeIcon('Clock');
export const Compass=makeIcon('Compass');
export const DownloadSimple=makeIcon('DownloadSimple');
export const Export=makeIcon('Export');
export const Flag=makeIcon('Flag');
export const Gavel=makeIcon('Gavel');
export const Info=makeIcon('Info');
export const List=makeIcon('List');
export const LockKey=makeIcon('LockKey');
export const MagnifyingGlass=makeIcon('MagnifyingGlass');
export const MapPin=makeIcon('MapPin');
export const MapTrifold=makeIcon('MapTrifold');
export const Medal=makeIcon('Medal');
export const Minus=makeIcon('Minus');
export const Mountains=makeIcon('Mountains');
export const NavigationArrow=makeIcon('NavigationArrow');
export const NotePencil=makeIcon('NotePencil');
export const PaperPlaneTilt=makeIcon('PaperPlaneTilt');
export const Path=makeIcon('Path');
export const Pause=makeIcon('Pause');
export const Play=makeIcon('Play');
export const Plus=makeIcon('Plus');
export const ShieldCheck=makeIcon('ShieldCheck');
export const SlidersHorizontal=makeIcon('SlidersHorizontal');
export const Stack=makeIcon('Stack');
export const Star=makeIcon('Star');
export const Trash=makeIcon('Trash');
export const Tree=makeIcon('Tree');
export const UserCircle=makeIcon('UserCircle');
export const UsersThree=makeIcon('UsersThree');
export const WaveSine=makeIcon('WaveSine');
export const WifiSlash=makeIcon('WifiSlash');
export const X=makeIcon('X');
