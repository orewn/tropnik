'use client';

import {useState, useEffect, useCallback, useRef} from 'react';
import {ShieldCheck,Star,UsersThree,ArrowClockwise,Flag,ArrowRight} from '@/components/TropnikIcons';
import {api, ApiError, errorText, isAbort, type Guide, type Review} from '@/lib/api';
import {ReportDialog} from './ReportDialog';

const activities: Record<string, string> = {hiking: 'Пешие походы', trekking: 'Треккинг', mountain: 'Горные маршруты'};

export function GuideDirectory() {
  const [guides, setGuides] = useState<Guide[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewError, setReviewError] = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    try { const items = await api<Guide[]>('guides', {signal}); if (request === sequence.current) { setGuides(items); setPreview(false); } }
    catch (error) {
      if (isAbort(error) || request !== sequence.current) return;
      if (error instanceof ApiError && error.code === 'service_not_configured') setPreview(true);
      else setError(errorText(error));
    } finally { if (request === sequence.current) setLoading(false); }
  }, []);
  // The initial directory request is an external lifecycle, not derived render state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { const activeSequence = sequence, controller = new AbortController(); void load(controller.signal); return () => { ++activeSequence.current; controller.abort(); }; }, [load]);
  useEffect(() => {
    // Never display the previous guide's reviews while a different guide loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReviews([]);
    setReviewError('');
    if (!opened) return;
    const controller = new AbortController();
    setReviewLoading(true);
    api<Review[]>('guides/' + encodeURIComponent(opened) + '/reviews', {signal: controller.signal})
      .then(items => { if (!controller.signal.aborted) setReviews(items); })
      .catch(error => { if (!isAbort(error)) setReviewError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setReviewLoading(false); });
    return () => controller.abort();
  }, [opened]);

  return <section>
    <div className="offline-heading"><h2>Гиды сообщества</h2>{!loading && !error && !preview && <span className="status-pill">{guides.length} опубликовано</span>}<button className="icon-button" aria-label="Обновить каталог гидов" onClick={() => void load()} disabled={loading}><ArrowClockwise size={19}/></button></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {loading ? <p className="status-loading">Загружаем подтверждённые профили…</p> : guides.length ? <div className="list-grid">{guides.map(guide => <article className="prose-card" key={guide.id}>
      <ShieldCheck size={27}/><h3>{guide.displayName}</h3>
      <p>Есть действующий допуск · {guide.activities.map(activity => activities[activity] || activity).join(', ')}<br/>{guide.completedTrips} завершённых выходов</p>
      <div className="departure-meta"><span><Star size={16} weight={guide.rating !== null ? 'fill' : 'regular'}/>{guide.rating !== null ? guide.rating.toFixed(1) + ' · отзывов: ' + guide.reviewCount : 'Пока без отзывов'}</span></div>
      <p className="fineprint">Допуск к выбранному маршруту проверяется отдельно.</p>
      <a className="text-link" href="/trips" style={{marginTop: 16}}>Посмотреть набор в походы <ArrowRight size={18}/></a>
      <div><button className="text-link" onClick={() => setOpened(opened === guide.id ? null : guide.id)} aria-expanded={opened === guide.id}>{opened === guide.id ? 'Свернуть отзывы' : 'Отзывы о работе гида'}</button></div>
      {opened === guide.id && <div className="stack">
        {reviewLoading ? <p role="status">Загружаем отзывы…</p> : reviewError ? <p className="error-message" role="alert">{reviewError}</p> : reviews.length ? reviews.map(review => <article key={review.id}>
          <span className="status-pill"><Star size={12}/>{review.rating} / 5</span><p style={{whiteSpace: 'pre-wrap', marginTop: 8}}>{review.body}</p>
          <small>Участие подтверждено · {new Date(review.createdAt).toLocaleDateString('ru')}</small>
          <div><button className="text-link" onClick={() => setReport(review.id)}><Flag size={14}/>Сообщить о нарушении</button></div>
        </article>) : <p>Опубликованных отзывов пока нет.</p>}
      </div>}
    </article>)}</div> : !error && <div className="empty-state"><UsersThree size={37}/><h2>Здесь появятся первые гиды</h2><p>{preview ? 'Каталог гидов пока недоступен. Вы можете изучить маршруты и сохранить планы на будущую поездку.' : 'Профили публикуются после проверки действующего допуска. Рейтинги формируются из отзывов участников завершённых походов.'}</p></div>}
    {report && <ReportDialog targetType="review" targetId={report} onClose={() => setReport(null)}/>}
  </section>;
}
