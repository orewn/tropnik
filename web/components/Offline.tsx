'use client';
import {useCallback,useEffect,useState,useRef,useSyncExternalStore} from 'react';import Link from 'next/link';import {DownloadSimple,CheckCircle,MapTrifold,Mountains,ArrowRight,Trash,ArrowSquareOut,WifiSlash,Info,Export,X} from '@/components/TropnikIcons';import {packs,deletePack,downloadJson,type SavedPack} from '@/lib/local';import {getMapReceipt,downloadMap,removeMap,watchMapChanges,type MapReceipt} from '@/lib/offline-map';import {errorText} from '@/lib/api';import {Modal} from './Modal';
function watchConnection(listener:()=>void){window.addEventListener('online',listener);window.addEventListener('offline',listener);return()=>{window.removeEventListener('online',listener);window.removeEventListener('offline',listener);};}
const connectionSnapshot=()=>navigator.onLine,serverConnectionSnapshot=()=>true;
export function Offline(){const[saved,setSaved]=useState<SavedPack[]>([]),[receipt,setReceipt]=useState<MapReceipt|null>(null),[progress,setProgress]=useState<number|null>(null),[error,setError]=useState(''),[remove,setRemove]=useState<string|null>(null),[removing,setRemoving]=useState(false);const online=useSyncExternalStore(watchConnection,connectionSnapshot,serverConnectionSnapshot);const controller=useRef<AbortController|null>(null),mutating=useRef(false),mounted=useRef(true),refreshVersion=useRef(0);
 const refresh=useCallback(async()=>{
  const version=++refreshVersion.current;
  const [cards,map]=await Promise.allSettled([packs(),getMapReceipt()]);
  if(!mounted.current||version!==refreshVersion.current)return;
  if(cards.status==='fulfilled')setSaved(cards.value);
  setReceipt(map.status==='fulfilled'?map.value:null);
  if(cards.status==='rejected'||map.status==='rejected')setError('Хранилище браузера недоступно. Проверьте настройки приватности и свободное место.');
 },[]);
 useEffect(()=>{
  mounted.current=true;let active=true;
  queueMicrotask(()=>{if(active)void refresh();});
  const stopWatching=watchMapChanges(()=>{void refresh();});
  return()=>{active=false;mounted.current=false;controller.current?.abort();stopWatching();};
 },[refresh]);
 async function saveMap(){
  if(mutating.current)return;
  mutating.current=true;setError('');setProgress(0);
  const current=new AbortController();controller.current=current;
  try{await downloadMap((i,n)=>{if(mounted.current)setProgress(Math.round(i/n*100));},current.signal);}
  catch(e){if(mounted.current)setError(e instanceof DOMException&&e.name==='AbortError'?'Скачивание остановлено. Незавершённый пакет не отмечен готовым.':errorText(e));}
  finally{await refresh();mutating.current=false;controller.current=null;if(mounted.current)setProgress(null);}
 }
 async function confirmRemove(){
  if(mutating.current||!remove)return;
  const target=remove;mutating.current=true;setRemoving(true);setError('');
  try{if(target==='map')await removeMap();else await deletePack(target);}
  catch(e){if(mounted.current)setError(errorText(e));}
  finally{await refresh();mutating.current=false;if(mounted.current){setRemoving(false);setRemove(null);}}
 }
 return <><div className="toolbar"><span className={`status-pill ${online?'':'offline'}`}>{online?<CheckCircle size={13}/>:<WifiSlash size={13}/>} {online?'Есть подключение':'Без сети'}</span><a className="text-link" href="/offline-viewer.html">Открыть автономную карту <ArrowSquareOut size={14}/></a></div>{error&&<div className="inline-error" role="alert"><Info size={21}/><span>{error}</span><button className="icon-button" aria-label="Закрыть уведомление" onClick={()=>setError('')}><X size={17}/></button></div>}
 <div className="offline-heading"><h2>Подробная карта</h2><span className="eyebrow">Бзерпинский карниз</span></div><article className="pack-card"><div className="pack-art"><Mountains size={55}/></div><div className="pack-content"><span className={receipt?'status-pill':'status-pill warning'}>{receipt?<><CheckCircle size={12}/>Сохранена и проверена</>:'Доступна для скачивания'}</span><h3>Район Бзерпинского карниза</h3><p>Тропы, местность, подписи и объёмный рельеф внутри границ пакета. Маршруты рощи в Хосте находятся за его пределами. Условия посещения проверяются отдельно.</p><div className="pack-meta"><span>≈ 7,0 МБ</span><span>Данные на 1 ноября 2026</span></div>{progress!==null&&<><div className="pack-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Скачивание карты"><span style={{transform:`scaleX(${progress/100})`}}/></div><span className="fineprint">{progress}% · скачивание и проверка файлов</span></>}{receipt&&<p className="source-note" style={{marginTop:10}}>Сохранена {new Date(receipt.savedAt).toLocaleDateString('ru')}.</p>}</div><div className="pack-actions">{progress!==null?<button className="button secondary" onClick={()=>controller.current?.abort()}>Отменить скачивание</button>:<button className="button primary" disabled={!online||removing} onClick={saveMap}><DownloadSimple size={18}/>{receipt?'Обновить пакет':'Скачать карту'}</button>}{receipt?<><a className="text-link" href="/offline-viewer.html?map=pilot">Открыть офлайн-карту <ArrowRight size={14}/></a>{receipt.landscape&&<a className="text-link" href="/offline-map/terrain/landscape.html">Открыть сохранённый ландшафт <Mountains size={18}/></a>}<button className="text-link" disabled={progress!==null||removing} onClick={()=>setRemove('map')}>Удалить с устройства</button></>:<a className="text-link" href="/sources">Что входит в пакет</a>}</div></article>
 <div className="offline-heading"><h2>Сохранённые карточки</h2><span className="status-pill offline">{saved.length} на устройстве</span></div>{saved.length?<div className="saved-grid">{saved.map(p=><article className="saved-card" key={p.id}><span className="eyebrow">Справочные данные</span><h3>{p.title}</h3><p>Источник от {new Date(p.sourceCheckedAt+'T12:00:00').toLocaleDateString('ru')}<br/>Сохранено {new Date(p.savedAt).toLocaleDateString('ru')}</p><footer><a className="text-link" href={`/offline-viewer.html?route=${encodeURIComponent(p.id)}`}>Открыть <ArrowRight size={14}/></a><button className="icon-button" onClick={()=>downloadJson(`tropnik-${p.id}.json`,p)} aria-label={`Экспорт карточки ${p.title}`}><Export size={19}/></button><button className="icon-button" disabled={progress!==null||removing} onClick={()=>setRemove(p.id)} aria-label={`Удалить карточку ${p.title}`}><Trash size={19}/></button></footer></article>)}</div>:<div className="empty-state"><MapTrifold size={45}/><h2>Ваш следующий маршрут<br/>может быть здесь</h2><p>Откройте маршрут на карте и нажмите «Сохранить карточку офлайн». Описание и доступная геометрия останутся на этом устройстве.</p><Link className="button primary" href="/?region=krasnodar">Выбрать маршрут <ArrowRight size={16}/></Link></div>}
 <div className="notice-block" style={{marginTop:25}}>Перед походом откройте сохранённые данные без подключения. Карточка и геометрия не обновляют ограничения автоматически. Для новых сообщений и подтверждения участия нужно подключение к интернету.</div><div className="section-actions"><a className="button secondary" href="/android">Приложение для Android <ArrowRight size={17}/></a><a className="text-link" href="/safety">Памятка перед выходом</a></div>
 {remove&&<Modal title="Удалить с этого устройства?" onClose={()=>setRemove(null)}><p className="muted">{remove==='map'?'Подробный пакет перестанет быть доступен без сети. Его можно будет скачать снова.':'Карточку можно будет сохранить снова при подключении к сети.'}</p><div className="section-actions"><button className="button danger" disabled={progress!==null||removing} aria-busy={removing} onClick={confirmRemove}><Trash size={17}/>{removing?'Удаляем…':'Удалить'}</button><button className="button secondary" onClick={()=>setRemove(null)}>Оставить</button></div></Modal>}
 </>;
}
