'use client';
import {useCallback, useState} from 'react';
import {Flag, CheckCircle, Info} from '@/components/TropnikIcons';
import {api, errorText} from '@/lib/api';
import {Modal} from './Modal';

export type ReportTarget = 'message' | 'recruitment_message' | 'review';
export function ReportDialog({targetType,targetId,onClose,onSubmitted}:{targetType:ReportTarget;targetId:string;onClose:()=>void;onSubmitted?:()=>void}){
  const [reason,setReason]=useState('spam'),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false);
  const close=useCallback(()=>{if(!busy)onClose();},[busy,onClose]);
  return <Modal title={sent?'Жалоба принята':'Сообщить о нарушении'} onClose={close}>
    {sent?<div className="success-panel"><CheckCircle size={44}/><p>Обращение появится в вашем личном кабинете. Модератор проверит материал и укажет причину решения.</p><a className="button primary" href="/account?tab=trust">Мои обращения</a><button className="text-link" onClick={close}>Закрыть</button></div>:<form className="stack" onSubmit={async e=>{e.preventDefault();setError('');setBusy(true);try{await api('reports',{method:'POST',body:JSON.stringify({targetType,targetId,reason,body:body.trim()})});setSent(true);onSubmitted?.();}catch(e){setError(errorText(e));}finally{setBusy(false);}}}>
      <div className="inline-note"><Flag size={23}/><span>Жалоба отправляется модерации. Она не публикуется в чате и не скрывает материал автоматически.</span></div>
      <label>Причина<select value={reason} onChange={e=>setReason(e.target.value)}><option value="spam">Спам или нежелательная реклама</option><option value="harassment">Оскорбления или травля</option><option value="dangerous_information">Опасная информация о маршруте</option><option value="personal_data">Чужие личные данные</option><option value="other">Другое нарушение</option></select></label>
      <label>Что следует проверить<textarea required minLength={10} maxLength={2000} rows={4} value={body} onChange={e=>setBody(e.target.value)} placeholder="Опишите конкретное нарушение и контекст"/><span className="field-help">Не добавляйте документы, телефоны и другие лишние персональные данные.</span></label>
      <p className="source-note"><Info size={15}/> Для непосредственной угрозы жизни используйте экстренную связь: жалобы не заменяют службу спасения.</p>
      {error&&<p className="error-message" role="alert">{error}</p>}
      <button className="button primary full" disabled={busy}>{busy?'Отправляем…':'Отправить жалобу'}</button>
    </form>}
  </Modal>;
}
