import {ArrowRight} from '@/components/TropnikIcons';
import {Header} from '@/components/Header';import {Footer} from '@/components/Footer';
export default function NotFound(){return<><Header/><main id="main" className="not-found"><span className="eyebrow">404 · немного в стороне от тропы</span><h1>Такого адреса<br/>на карте нет.</h1><p>Возможно, ссылка изменилась. Вернитесь к выбору направления.</p><a className="button primary" href="/">К карте России <ArrowRight size={18}/></a></main><Footer/></>;}
