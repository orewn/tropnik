'use client';
import {useEffect,useRef} from 'react';
import {X,Mountains} from '@/components/TropnikIcons';
export function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:React.ReactNode;wide?:boolean}){
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{const prev=document.activeElement as HTMLElement|null;const bodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';ref.current?.focus();
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();if(e.key==='Tab'){const nodes=ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,select,textarea,[tabindex="0"]');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
    document.addEventListener('keydown',onKey);return()=>{document.body.style.overflow=bodyOverflow;document.removeEventListener('keydown',onKey);prev?.focus();};
  },[onClose]);
  return <div className="modal-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className={`modal ${wide?'modal-wide':''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><div className="modal-brandline"><Mountains size={24}/><span>Тропник</span></div><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={22}/></button></div>{children}</div></div>;
}
