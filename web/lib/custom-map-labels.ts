import type {MapTileLabel} from './custom-map-painter';
import {priorityCityFontSize} from '../public/maps/map-city-labels.js';

type LabelPoint={x:number;y:number};
export type MapLabelRect={left:number;top:number;right:number;bottom:number};
export type MapLabelStyle={fontSize:number;lineHeight:number;weight:500|600;ink:string;surface:string;border:string};
export type MapLabelLayout={rect:MapLabelRect;plate:MapLabelRect|null;textY:number;textWidth:number};

/** Named map typography follows the same steps as the surrounding interface. */
export function mapLabelStyle(label:MapTileLabel,zoom:number,color?:string):MapLabelStyle{
  const requested=label.priorityCity?priorityCityFontSize(zoom):label.kind==='place'&&label.rank<3?14:12;
  const fontSize=[12,14,16,18,20].filter(size=>size<=requested).at(-1)??12;
  const water=label.kind==='water'||label.symbol==='water'||label.symbol==='waterfall';
  return{fontSize,lineHeight:fontSize<=12?16:fontSize<=14?20:fontSize<=16?24:28,
    weight:label.kind==='place'||label.kind==='peak'?600:500,
    ink:color&&/^#[\da-f]{6}$/i.test(color)?color:water?'#315f69':label.kind==='path'?'#745733':'#294535',
    surface:water?'rgba(244,250,249,.95)':'rgba(255,254,247,.95)',
    border:water?'rgba(66,124,136,.22)':'rgba(69,94,72,.20)'};
}

/** Keep the chosen geography readable before admitting neighbourhood detail. */
export function mapLabelPriority(label:MapTileLabel):number{
  if(label.rank<=0)return 0;
  if(label.priorityCity)return 1;
  if(label.kind==='place'&&label.rank<3)return 2;
  if(label.symbol==='water'||label.symbol==='shelter'||label.symbol==='pass')return 3;
  if(label.kind==='peak')return 4;
  if(label.kind==='water')return 5;
  if(label.symbol)return 6;
  if(label.kind==='path')return 7;
  return 8;
}

/** Density scales with CSS viewport area, never device pixel ratio. */
export function mapLabelBudget(width:number,height:number):number{
  return Math.max(8,Math.min(56,Math.floor(Math.max(0,width)*Math.max(0,height)/18000)));
}

/** Linear and areal names recur across source tile boundaries. Distinct point
 * landmarks and settlements may legitimately share a name and are not merged. */
export function mapLabelRepeatDistance(label:MapTileLabel):number{
  return label.kind==='path'?320:label.kind==='water'?240:0;
}

export function mapLabelRepeatKey(label:MapTileLabel):string{
  return `${label.kind}:${label.text.trim().replace(/[«»„“”"]/g,'').replace(/\s+/g,' ').toLocaleLowerCase('ru')}`;
}

/** Measure the full plate and symbol before collision or viewport admission. */
export function mapLabelLayout(label:MapTileLabel,point:LabelPoint,textWidth:number,hasText:boolean,style:MapLabelStyle):MapLabelLayout{
  const textY=point.y+(label.symbol?24:0),halfHeight=style.lineHeight/2+4;
  const plate=hasText?{left:point.x-textWidth/2-8,right:point.x+textWidth/2+8,top:textY-halfHeight,bottom:textY+halfHeight}:null;
  const rect={left:Math.min(plate?.left??point.x,label.symbol?point.x-12:point.x)-4,
    right:Math.max(plate?.right??point.x,label.symbol?point.x+12:point.x)+4,
    top:Math.min(plate?.top??point.y,label.symbol?point.y-12:point.y)-4,
    bottom:Math.max(plate?.bottom??point.y,label.symbol?point.y+12:point.y)+4};
  return{rect,plate,textY,textWidth};
}

/** Clear surfaces replace heavy per-glyph white outlines on detailed terrain. */
export function drawMapLabel(context:CanvasRenderingContext2D,value:string,point:LabelPoint,layout:MapLabelLayout,style:MapLabelStyle){
  if(!value||!layout.plate)return;
  const plate=layout.plate;
  context.beginPath();context.roundRect(plate.left,plate.top,plate.right-plate.left,plate.bottom-plate.top,4);
  context.fillStyle=style.surface;context.fill();context.strokeStyle=style.border;context.lineWidth=1;context.stroke();
  context.textAlign='center';context.textBaseline='middle';context.fillStyle=style.ink;context.fillText(value,point.x,layout.textY);
}
