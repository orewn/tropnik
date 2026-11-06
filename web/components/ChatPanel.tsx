'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {PaperPlaneTilt, ChatCircleDots, ArrowClockwise, WifiSlash, Flag} from '@/components/TropnikIcons';
import {api, ApiError, errorText, isAbort, type User, type ChatMessage, type RecruitmentMessage} from '@/lib/api';
import {mergeMessages} from '@/lib/trip-policy';
import {ReportDialog} from './ReportDialog';

type ChatItem = (ChatMessage | RecruitmentMessage) & {visibility?: 'visible' | 'hidden'};

export function ChatPanel({kind, id, user}: {kind: 'departures' | 'recruitment-requests'; id: string; user: User}) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [text, setText] = useState('');
  const [readError, setReadError] = useState('');
  const [sendError, setSendError] = useState('');
  const [pending, setPending] = useState(false);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const generation = useRef(0);
  const sequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const attempt = useRef<{body: string; clientId: string} | null>(null);
  const endpoint = kind + '/' + encodeURIComponent(id) + '/messages';

  const load = useCallback(async () => {
    const epoch = generation.current;
    const request = ++sequence.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    try {
      const list = await api<ChatItem[]>(endpoint, {signal: controller.signal});
      if (epoch !== generation.current || request !== sequence.current) return;
      setMessages(previous => mergeMessages(previous, list));
      setReadError('');
      setDenied(false);
    } catch (error) {
      if (isAbort(error) || epoch !== generation.current || request !== sequence.current) return;
      setReadError(errorText(error));
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setMessages([]);
        setDenied(true);
      }
    } finally {
      if (epoch === generation.current && request === sequence.current) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    generation.current++;
    setMessages([]);
    setText('');
    setReadError('');
    setSendError('');
    setDenied(false);
    setReport(null);
    setLoading(true);
    setPending(false);
    sending.current = false;
    attempt.current = null;
    void load();
    const state = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && !document.hidden) void load();
    };
    const timer = setInterval(() => {
      if (navigator.onLine && !document.hidden) void load();
    }, 10000);
    window.addEventListener('online', state);
    window.addEventListener('offline', state);
    document.addEventListener('visibilitychange', state);
    setOnline(navigator.onLine);
    return () => {
      generation.current++;
      readController.current?.abort();
      clearInterval(timer);
      window.removeEventListener('online', state);
      window.removeEventListener('offline', state);
      document.removeEventListener('visibilitychange', state);
    };
  }, [load, user.id]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending.current || denied) return;
    if (!navigator.onLine) {
      setSendError('Сообщение не отправлено. Текст остаётся в поле; отправьте его после восстановления связи.');
      return;
    }
    const epoch = generation.current;
    if (attempt.current?.body !== body) attempt.current = {body, clientId: crypto.randomUUID()};
    const submitted = attempt.current!;
    sending.current = true;
    setPending(true);
    setSendError('');
    try {
      const item = await api<ChatItem>(endpoint, {method: 'POST', body: JSON.stringify(submitted)});
      if (epoch !== generation.current) return;
      setMessages(previous => mergeMessages(previous, [item]));
      setText('');
      attempt.current = null;
    } catch (error) {
      if (epoch !== generation.current) return;
      setSendError(errorText(error));
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        setMessages([]);
        setDenied(true);
      }
      // Retain the exact body and clientId after an uncertain response.
      // Retrying it cannot create a duplicate server message.
    } finally {
      if (epoch === generation.current) {
        sending.current = false;
        setPending(false);
      }
    }
  }

  return <section className="chat-pane" aria-label="Чат группы">
    <div className="chat-heading">
      <ChatCircleDots size={23}/><h2>Обсуждение</h2>
      <span className={'status-pill ' + (online ? '' : 'offline')}>{online ? 'Есть сеть' : <><WifiSlash size={12}/>Без сети</>}</span>
      <button className="icon-button" onClick={() => void load()} aria-label="Обновить сообщения" disabled={loading}><ArrowClockwise size={18}/></button>
    </div>
    {readError && <p className="error-message" role="alert" style={{margin: 16}}>{readError}</p>}
    <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions">
      {loading ? <p className="status-loading">Загружаем сообщения…</p> : messages.length ? messages.map(message => <article className={'chat-message ' + (message.userId === user.id ? 'mine' : '')} key={message.id}>
        <header><strong>{message.displayName || 'Участник'}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString('ru', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'})}</time></header>
        <p>{message.visibility === 'hidden' ? 'Сообщение скрыто модератором.' : message.body}</p>
        {message.visibility !== 'hidden' && <button className="text-link" onClick={() => setReport(message.id)} aria-label="Сообщить о нарушении в этом сообщении"><Flag size={14}/>Пожаловаться</button>}
      </article>) : !readError && <div className="small-empty"><ChatCircleDots size={32}/><h3>Начните знакомство</h3><p>Расскажите о своём опыте и ожиданиях от похода. Сообщения видны участникам этого обсуждения.</p></div>}
    </div>
    <form className="chat-composer" onSubmit={send}>
      <textarea aria-label="Ваше сообщение" placeholder={denied ? 'Нет доступа к отправке сообщений' : 'Напишите группе…'} maxLength={4000} rows={2} value={text} disabled={pending || denied} onChange={event => setText(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(event); }
      }}/>
      <button className="button primary" disabled={pending || denied || !text.trim()} type="submit"><PaperPlaneTilt size={19}/>{pending ? 'Отправляем…' : 'Отправить'}</button>
    </form>
    {sendError && <p className="error-message" role="alert" style={{margin: 16}}>{sendError}</p>}
    <p className="fineprint" style={{padding: '0 16px 12px'}}>Показаны последние 100 сообщений. Ответ сервера подтверждает отправку. Ctrl / ⌘ + Enter — отправить.</p>
    {report && <ReportDialog targetType={kind === 'departures' ? 'message' : 'recruitment_message'} targetId={report} onClose={() => setReport(null)}/>}
  </section>;
}
