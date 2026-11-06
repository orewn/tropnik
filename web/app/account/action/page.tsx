import type {Metadata} from 'next';
import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {AccountActionScreen} from '@/components/AccountLifecycle';

export const metadata: Metadata = {title: 'Доступ к аккаунту', robots: {index: false, follow: false}, referrer: 'no-referrer'};

export default function AccountActionPage() {
  return <><Header active="account"/><main id="main" className="account-page"><AccountActionScreen/></main><Footer/></>;
}
