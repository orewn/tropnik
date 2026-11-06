import {Header} from './Header';
import {Footer} from './Footer';
export function ContentPage({title,kicker,lead,children,active}:{title:string;kicker:string;lead:string;children:React.ReactNode;active?:string}){return <><Header active={active||''}/><main id="main" className="article-body"><div className="breadcrumbs"><a href="/">Карта маршрутов</a><span> / </span><span>{title}</span></div><span className="eyebrow">{kicker}</span><h1>{title}</h1><p className="lede">{lead}</p>{children}</main><Footer/></>;}
