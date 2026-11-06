import type {Metadata} from 'next';import {Header} from '@/components/Header';import {Footer} from '@/components/Footer';import {AccountPanel} from '@/components/AccountPanel';
export const metadata:Metadata={title:'Личный кабинет',robots:{index:false,follow:false}};
export default function AccountPage(){return <><Header active="account"/><main id="main" className="account-page"><div className="breadcrumbs"><a href="/">Карта маршрутов</a><span>/</span><span>Личный кабинет</span></div><h1 className="sr-only">Личный кабинет</h1><AccountPanel/></main><Footer/></>;}
