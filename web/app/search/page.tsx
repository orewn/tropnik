import type {Metadata} from 'next';
import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {SiteSearch} from '@/components/SiteSearch';
import {readSearchState} from '@/lib/search-state';

export const metadata: Metadata = {title: 'Поиск', description: 'Поиск маршрутов, направлений и полезных страниц Тропника.', robots: {index: false, follow: true}};

export default async function SearchPage({searchParams}: {searchParams?: Promise<Record<string, string | string[] | undefined>>}) {
  const values = await searchParams || {}, params = new URLSearchParams();
  for (const key of ['q', 'kind', 'unknown', 'page']) {
    const value = values[key];
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  return <><Header active="search"/><SiteSearch initialState={readSearchState(params)}/><Footer/></>;
}
