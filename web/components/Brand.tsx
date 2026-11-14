import Link from 'next/link';
import {BRAND} from '@/lib/brand';
import {BrandMark} from './BrandMark';
export function Brand({small=false}:{small?:boolean}) {
  return <Link prefetch={false} href="/" className={`brand ${small?'small':''}`} aria-label={`${BRAND.name} — на главную`}><BrandMark/><span>{BRAND.wordmark}</span></Link>;
}
