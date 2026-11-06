import type {Metadata} from 'next';import {Header} from '@/components/Header';import {Footer} from '@/components/Footer';import {ModerationPanel} from '@/components/ModerationPanel';
export const metadata:Metadata={title:'Модерация сообщества',robots:{index:false,follow:false}};
export default function ModerationPage(){return <><Header/><main id="main" className="account-page"><ModerationPanel/></main><Footer/></>;}
