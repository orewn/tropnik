import {ArrowSquareOut} from '@/components/TropnikIcons';
import {Header} from '@/components/Header';
import {Explore} from '@/components/Explore';
import {Footer} from '@/components/Footer';
import {getPublishedTrails} from '@/lib/server';
import {regions} from '@/lib/content';
export default async function Home({searchParams}:{searchParams:Promise<{region?:string;route?:string}>}){
 const params=await searchParams;const published=await getPublishedTrails();
 return <><Header/><main id="main"><Explore initialPublished={published} initialRegion={params.region} initialTrail={params.route}/><section className="below-map"><div><span className="eyebrow">От идеи до тропы</span><h2>Хороший поход<br/>начинается с подготовки.</h2><p>Сначала изучите маршрут и его условия. Затем найдите подходящего гида и группу. Сохраните нужные данные до выхода из зоны связи.</p></div><div className="steps-editorial"><article><span>01</span><div><h3>Выберите направление</h3><p>Регион, тропа, условия и источник данных — всё рядом с картой.</p></div></article><article><span>02</span><div><h3>Соберите группу с гидом</h3><p>Минимум четыре человека вместе с гидом. Его допуск проверяется отдельно.</p></div></article><article><span>03</span><div><h3>Возьмите маршрут с собой</h3><p>Сохранённая карта и описание доступны без сети. Новые изменения — после подключения.</p></div></article></div></section><section className="region-links"><h2>Направления России</h2><nav aria-label="Каталог регионов">{regions.map(r=><a href={`/regions/${r.id}`} key={r.id}>{r.name}<span><ArrowSquareOut size={18}/></span></a>)}</nav></section></main><Footer/></>;
}
