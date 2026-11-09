'use client';
import Link from 'next/link';
import {ArrowClockwise, MapTrifold} from '@/components/TropnikIcons';
export default function ErrorPage({reset}:{error:Error & {digest?:string};reset:()=>void}){
  return <main id="main" className="standalone-state"><span className="eyebrow">Связь с данными прервалась</span><h1>Не удалось открыть страницу.</h1><p>Сервис временно не ответил. Сохранённые карты на этом устройстве остаются доступны.</p><div className="button-row"><button className="button primary" onClick={reset}><ArrowClockwise size={19}/>Повторить</button><a className="button secondary" href="/offline-viewer.html"><MapTrifold size={19}/>Автономная карта</a></div><Link prefetch={false} className="text-link" href="/">На главную</Link></main>;
}
