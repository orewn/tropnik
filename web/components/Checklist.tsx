'use client';
import {useEffect,useState} from 'react';import {gearChecklist} from '@/lib/content';
export function Checklist(){const[values,setValues]=useState<string[]>([]),[error,setError]=useState('');
 // Browser storage is only available after hydration.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{try{const v=JSON.parse(localStorage.getItem('tropnik-checklist')||'[]');if(Array.isArray(v))setValues(v.filter(x=>typeof x==='string'));}catch{}},[]);return <div><div className="checklist-form">{gearChecklist.map(item=><label key={item}><input type="checkbox" checked={values.includes(item)} onChange={e=>{const next=e.target.checked?[...values,item]:values.filter(x=>x!==item);setValues(next);try{localStorage.setItem('tropnik-checklist',JSON.stringify(next));setError('');}catch{setError('Отметки не сохранены: хранилище устройства недоступно.');}}}/><span>{item}</span></label>)}</div><p className="fineprint">{values.length} из {gearChecklist.length} пунктов отмечено. Это личная памятка, она не заменяет инструктаж и решение гида.</p>{error&&<p className="error-message" role="alert">{error}</p>}</div>;}
