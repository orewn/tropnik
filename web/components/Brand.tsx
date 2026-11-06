export function Brand({small=false}:{small?:boolean}) {
  return <a href="/" className={`brand ${small?'small':''}`} aria-label="Тропник — на главную"><svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 31 20 8l13 23H7Z" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round"/><path d="m14.5 31 7-11 4.5 7-3 4" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"/><path d="m17 13 3 4 3-4" stroke="currentColor" strokeWidth="2.1"/></svg><span>тропник</span><span className="brand-dot"/></a>;
}
