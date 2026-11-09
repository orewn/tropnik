export type SearchKind = 'route' | 'region' | 'story' | 'page';
export type SearchDocument = {
  id: string; kind: SearchKind; title: string; description: string; href: string;
  regionName?: string; regionId?: string; keywords?: string; body?: string;
  distanceKm?: number | null; duration?: string | null;
  accessStatus?: 'closed' | 'restricted' | 'unknown'; missingGeometry?: boolean;
};
export type SearchHit = Omit<SearchDocument, 'keywords' | 'body'> & {
  score: number; unspecifiedParameters?: boolean;
};
export type SearchOptions = {kind?: 'all' | SearchKind; includeUnspecified?: boolean};
export type SearchResponse = {
  query: string; correctedQuery?: string; results: SearchHit[]; total: number;
  unspecifiedCount: number; appliedFilters: string[];
};
type Query = {text: string; words: string[]; maxKm?: number; minKm?: number; maxHours?: number; filters: string[]};
type Indexed = {document: SearchDocument; title: string[]; place: string[]; body: string[]; all: Set<string>};
const STOP = new Set(['в','во','на','по','и','или','для','к','у','из','от','до','с','со','без','где','как','найти','ищу','хочу','мне','можно','рядом','около','маршрут','маршруты','тропа','тропы','поход','походы','прогулка','прогулки']);
const ALIASES: Record<string, string> = {
  байкальский:'байкал',байкальская:'байкал',байкальской:'байкал',байкале:'байкал',байкала:'байкал',baikal:'байкал',
  алтайский:'алтай',алтайская:'алтай',алтае:'алтай',алтая:'алтай',altai:'алтай',altay:'алтай',
  bzerpin:'бзерпин',khakusy:'хакусы',tobizina:'тобизина',tobizin:'тобизина',ergaki:'ергаки',
  kamchatka:'камчатка',karelia:'карелия',crimea:'крым',krym:'крым',elbrus:'эльбрус',
  краснополянский:'поляна',сочи:'сочи',хайкинг:'поход',треккинг:'поход',трекинг:'поход',hiking:'поход',trekking:'поход',
  offline:'офлайн',оффлайн:'офлайн',скачать:'скачать',android:'андроид',андроид:'андроид',apk:'андроид',
  bbt:'ббт',ббт:'байкал',чехов:'чехова',кеиву:'кейва',кейву:'кейва',кейки:'кейва',
};
const ENDINGS = /(?:иями|ями|ами|ого|ему|ому|ыми|ими|ская|ский|ские|ское|ской|ских|ыми|ими|его|ая|яя|ое|ее|ые|ие|ой|ый|ий|ую|юю|ах|ях|ов|ев|ам|ям|ом|ем|а|я|ы|и|у|ю|е)$/u;
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[\p{Pd}_]/gu,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function stem(word: string): string {
  const alias = ALIASES[word] || word;
  return alias.length >= 5 ? alias.replace(ENDINGS,'') : alias;
}
function words(text: string, dropStop = true): string[] {
  return [...new Set(normalizeSearchText(text).split(' ').filter(word => word && (!dropStop || !STOP.has(ALIASES[word] || word))).map(stem))];
}
const LATIN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const TRANSLIT: Record<string,string> = {shch:'щ',sch:'щ',yo:'е',zh:'ж',kh:'х',ts:'ц',ch:'ч',sh:'ш',yu:'ю',ya:'я',ye:'е',a:'а',b:'б',v:'в',g:'г',d:'д',e:'е',z:'з',i:'и',j:'й',k:'к',l:'л',m:'м',n:'н',o:'о',p:'п',r:'р',s:'с',t:'т',u:'у',f:'ф',h:'х',c:'к',y:'ы',w:'в',x:'кс'};
function variants(value: string): string[] {
  const lower = value.toLocaleLowerCase('ru');
  if (!/[a-z]/.test(lower)) return [value];
  const keyboard = [...lower].map(char => {const i=LATIN_KEYS.indexOf(char);return i < 0 ? char : RU_KEYS[i];}).join('');
  const translit = lower.replace(/shch|sch|yo|zh|kh|ts|ch|sh|yu|ya|ye|[a-z]/g, char => TRANSLIT[char] || char);
  return [...new Set([value,keyboard,translit])];
}
function parseQuery(value: string): Query {
  let text = value.trim().slice(0,160).toLocaleLowerCase('ru').replaceAll('ё','е');
  const query: Query = {text,words:[],filters:[]};
  const n = (v:string) => Number(v.replace(',','.'));
  text = text.replace(/(?:от\s+)?(\d+(?:[.,]\d+)?)\s*(?:–|—|-|до)\s*(\d+(?:[.,]\d+)?)\s*(?:км|километр\p{L}*)/gu,(_m,a,b)=>{
    query.minKm=Math.min(n(a),n(b));query.maxKm=Math.max(n(a),n(b));query.filters.push(`${query.minKm}–${query.maxKm} км`);return ' ';
  });
  text = text.replace(/(?:до|менее|короче|не\s+более)\s*(\d+(?:[.,]\d+)?)\s*(?:км|километр\p{L}*)/gu,(_m,a)=>{query.maxKm=n(a);query.filters.push(`До ${query.maxKm} км`);return ' ';});
  text = text.replace(/(?:от|более|длиннее|не\s+менее)\s*(\d+(?:[.,]\d+)?)\s*(?:км|километр\p{L}*)/gu,(_m,a)=>{query.minKm=n(a);query.filters.push(`От ${query.minKm} км`);return ' ';});
  text = text.replace(/(?:до|не\s+более)\s*(\d+(?:[.,]\d+)?)\s*(?:час(?:а|ов)?|ч)(?!\p{L})/gu,(_m,a)=>{query.maxHours=n(a);query.filters.push(`До ${query.maxHours} ч`);return ' ';});
  text = text.replace(/(?:на|за)\s+(?:один\s+)?день|однодневн\p{L}*/gu,()=>{query.maxHours=24;query.filters.push('На один день');return ' ';});
  text = text.replace(/на\s+выходные/gu,()=>{query.maxHours=48;query.filters.push('До двух дней');return ' ';});
  const meaningful = words(text);
  query.words=(meaningful.length?meaningful:words(text,false)).slice(0,12);
  return query;
}
export function durationHours(value?: string | null): number | null {
  if (!value) return null;
  const text=value.toLocaleLowerCase('ru');
  const unit=text.match(/мин|час|ч(?!\p{L})|день|дн(?:я|ей)?/u);
  if (!unit) return null;
  const numbers=text.slice(0,unit.index).match(/\d+(?:[.,]\d+)?/g)?.map(v=>Number(v.replace(',','.')));
  if(!numbers?.length)return null;
  const largest=Math.max(...numbers);
  return unit[0].startsWith('мин')?largest/60:unit[0].startsWith('д')?largest*24:largest;
}
// Bounded optimal-string-alignment distance: also recognises adjacent transpositions.
function distance(a:string,b:string,limit:number):number {
  if(Math.abs(a.length-b.length)>limit)return limit+1;
  let before:number[]|undefined,previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const current=[i];
    for(let j=1;j<=b.length;j++){
      current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+Number(a[i-1]!==b[j-1]));
      if(before&&i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])current[j]=Math.min(current[j],before[j-2]+1);
    }
    before=previous;previous=current;
  }
  return previous[b.length];
}
function tokenScore(token:string,list:readonly string[]):number {
  if(list.includes(token))return 1;
  if(token.length>=3&&list.some(word=>word.startsWith(token)||token.startsWith(word)&&word.length>=4))return .82;
  if(token.length<4)return 0;
  const budget=token.length>=8?2:1;
  return list.some(word=>word.length>=4&&distance(token,word,budget)<=budget)?.57:0;
}
function visibleHit(document:SearchDocument,score:number,unspecified:boolean):SearchHit {
  // Search-only text is intentionally omitted from the public hit payload.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {body:_body,keywords:_keywords,...hit}=document;
  return {...hit,score,...(unspecified?{unspecifiedParameters:true}:{})};
}
export function createSearchIndex(documents:readonly SearchDocument[]) {
  const seen=new Set<string>();
  const indexed:Indexed[]=documents.map(document=>{
    const identity=document.kind+':'+document.id;
    if(seen.has(identity))throw new Error('Duplicate search document '+identity);seen.add(identity);
    const title=words(document.title,false),place=words(`${document.regionName||''} ${document.keywords||''}`,false),body=words(`${document.description} ${document.body||''}`,false);
    return {document,title,place,body,all:new Set([...title,...place,...body])};
  });
  return function search(value:string,options:SearchOptions={}):SearchResponse {
    const query=value.trim().slice(0,160);
    let best:{query:Query;variant:string;hits:SearchHit[];weight:number;unspecifiedCount:number}|undefined;
    for(const variant of variants(query)){
      const parsed=parseQuery(variant),hits:SearchHit[]=[];let unspecifiedCount=0;
      const constrained=parsed.maxKm!==undefined||parsed.minKm!==undefined||parsed.maxHours!==undefined;
      for(const item of indexed){
        const d=item.document;
        if(options.kind&&options.kind!=='all'&&d.kind!==options.kind)continue;
        if(constrained&&d.kind!=='route')continue;
        let score=0;
        let matches=true;
        for(const token of parsed.words){
          const strength=Math.max(tokenScore(token,item.title)*12,tokenScore(token,item.place)*8,tokenScore(token,item.body)*3);
          if(!strength){matches=false;break;}score+=strength;
        }
        if(!matches)continue;
        let unspecified=false;
        if(parsed.maxKm!==undefined||parsed.minKm!==undefined){
          if(d.distanceKm==null)unspecified=true;
          else if(parsed.maxKm!==undefined&&d.distanceKm>parsed.maxKm||parsed.minKm!==undefined&&d.distanceKm<parsed.minKm)continue;
        }
        if(parsed.maxHours!==undefined){const hours=durationHours(d.duration);if(hours===null)unspecified=true;else if(hours>parsed.maxHours)continue;}
        if(unspecified){unspecifiedCount++;if(options.includeUnspecified===false)continue;score-=2;}
        if(parsed.words.length&&normalizeSearchText(d.title).includes(normalizeSearchText(parsed.text)))score+=7;
        score+=d.kind==='route'?1:0;
        hits.push(visibleHit(d,score,unspecified));
      }
      hits.sort((a,b)=>Number(!!a.unspecifiedParameters)-Number(!!b.unspecifiedParameters)||b.score-a.score||a.title.localeCompare(b.title,'ru')||a.id.localeCompare(b.id));
      const weight=hits.length?Math.max(1,hits[0].score)+Math.min(hits.length,10)*.05:0;
      if(!best||weight>best.weight)best={query:parsed,variant,hits,weight,unspecifiedCount};
    }
    const chosen=best!;
    return {query,...(chosen.variant!==query&&chosen.hits.length?{correctedQuery:chosen.variant}:{}),results:chosen.hits,total:chosen.hits.length,unspecifiedCount:chosen.unspecifiedCount,appliedFilters:chosen.query.filters};
  };
}
