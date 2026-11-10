// This viewer deliberately has no network calls. Private records stay in the
// user's local storage and never enter the service worker's public asset cache.
export const LOCAL_SAFETY_KEY = 'tropnik-safety-passports-v1';
export const EMERGENCY_CARD_KEY = 'tropnik-emergency-cards-v1';
// Match the serialized string's UTF-16 code units on both write and cold read.
export const MAX_SAFETY_STORAGE_LENGTH = 512 * 1024;
const localStatuses = new Set(['draft','ready','submitted','confirmed','amendment_required','active','closed']);
const serverStatuses = new Set(['not_required','recommended','required','preparing','ready_to_submit','submitted_unverified','start_contact_pending','confirmed','amendment_required','active','return_report_pending','closed','rejected','cancelled']);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max).trim() : '';
const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : '';
function records(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_SAFETY_STORAGE_LENGTH) return [];
  try { const data = JSON.parse(raw); return Array.isArray(data) ? data.slice(0, 20).filter(record) : []; } catch { return []; }
}
function points(value) {
  return Array.isArray(value) ? value.slice(0,50).filter(record).map(point => {
    const result={name:text(point.name),description:text(point.description,2000)};
    if (Number.isFinite(point.latitude)&&Math.abs(point.latitude)<=90&&Number.isFinite(point.longitude)&&Math.abs(point.longitude)<=180) {
      result.latitude=point.latitude;result.longitude=point.longitude;
    }
    return result;
  }).filter(point=>point.name) : [];
}
function pointDescription(point) {
  const coordinates=Number.isFinite(point.latitude)&&Number.isFinite(point.longitude)?`Широта: ${point.latitude}; долгота: ${point.longitude}`:'';
  return [point.name,point.description,coordinates].filter(Boolean).join(': ');
}
function serverRecord(value) {
  if (!record(value) || !record(value.card) || value.schemaVersion !== 1) return null;
  const card = value.card;
  if (!text(card.departureId,128) || !text(card.routeTitle) || !date(card.startsAt) || !date(card.endsAt) || !serverStatuses.has(card.mchsStatus)) return null;
  return {schemaVersion:1,savedAt:date(value.savedAt),card:{
    departureId:text(card.departureId,128),routeTitle:text(card.routeTitle),startsAt:date(card.startsAt),endsAt:date(card.endsAt),timeZone:text(card.timeZone,80),
    leaderName:text(card.leaderName,160),leaderPhone:text(card.leaderPhone,64),emergencyContactName:text(card.emergencyContactName,160),emergencyContactPhone:text(card.emergencyContactPhone,64),
    mchsStatus:card.mchsStatus,mchsSubmissionId:text(card.mchsSubmissionId,160),emergencyNumber:'112',controlPoints:points(card.controlPoints),emergencyExits:points(card.emergencyExits),messageTemplate:text(card.messageTemplate,6000),
  }};
}

export function parseOfflineSafety(localRaw, serverRaw) {
  const cards = [];
  for (const item of records(localRaw)) {
    if (item.schemaVersion !== 1 || !text(item.id,128) || !localStatuses.has(item.status)) continue;
    const participants = Array.isArray(item.participants) ? item.participants.slice(0,50).filter(person=>record(person)&&text(person.name)&&text(person.phone,64)).length : 0;
    cards.push({id:'local:'+text(item.id,128),recordId:text(item.id,128),source:'local',title:text(item.routeTitle)||'Поход без названия',savedAt:date(item.updatedAt),
      notice:'Локальный черновик. Не регистрация в МЧС. Отметки сохранены пользователем и не проверены ведомством.',
      facts:[['Регион',text(item.region)],['Выход',text(item.startDate,10)],['Возвращение',text(item.endDate,10)],['Контрольный срок',text(item.returnDeadline,40)],['Часовой пояс',text(item.timeZone,80)],['Руководитель',text(item.leaderName,160)],['Телефон руководителя',text(item.leaderPhone,64)],['Контакт вне группы',text(item.outsideContactName,160)],['Телефон контакта',text(item.outsideContactPhone,64)],['Точка старта',text(item.startPoint,1000)],['Точка завершения',text(item.finishPoint,1000)],['Описание маршрута',text(item.routeDescription,8000)],['Запасной маршрут',text(item.reserveRoute,4000)],['Аварийные выходы',text(item.emergencyExits,4000)],['План связи',text(item.communication,4000)],['Участников с заполненными контактами',String(participants)],['Личная запись о подаче',text(item.mchsReference,240)]],
      message:`Нужна помощь туристской группе. Маршрут: ${text(item.routeTitle)||'не указан'}. Руководитель: ${text(item.leaderName,160)||'не указан'}, ${text(item.leaderPhone,64)||'телефон не указан'}. Контрольный срок: ${text(item.returnDeadline,40)||'не указан'}. Координаты и число пострадавших сообщу отдельно.`,
    });
  }
  for (const raw of records(serverRaw)) {
    const parsed = serverRecord(raw); if (!parsed) continue;
    const item=parsed.card;
    cards.push({id:'server:'+item.departureId,recordId:item.departureId,source:'server',title:item.routeTitle,savedAt:parsed.savedAt,
      notice:'Копия карточки сервиса на момент сохранения. Текущее состояние без сети не проверено. Карточка не отправляет уведомление в МЧС и не вызывает помощь.',
      facts:[['Выход',item.startsAt],['Плановое возвращение',item.endsAt],['Часовой пояс',item.timeZone],['Руководитель',item.leaderName],['Телефон руководителя',item.leaderPhone],['Контакт вне группы',item.emergencyContactName],['Телефон контакта',item.emergencyContactPhone],['Номер уведомления из сохранённой карточки',item.mchsSubmissionId],['Контрольные точки',item.controlPoints.map(pointDescription).join('\n')],['Аварийные выходы',item.emergencyExits.map(pointDescription).join('\n')]],
      message:item.messageTemplate||`Нужна помощь группе «${item.routeTitle}». Руководитель: ${item.leaderName}. Координаты сообщу отдельно.`,
    });
  }
  return cards.sort((a,b)=>b.savedAt.localeCompare(a.savedAt));
}

export function saveLocalSafetyPassports(storage, passports) {
  const raw = JSON.stringify(passports);
  if (raw.length > MAX_SAFETY_STORAGE_LENGTH) throw new RangeError('Паспорта занимают слишком много места для автономного просмотра. Сократите описания или удалите старые паспорта. Изменения не сохранены.');
  storage.setItem(LOCAL_SAFETY_KEY, raw);
}

export function saveOfflineEmergencyCard(storage, card, now = new Date()) {
  const value = serverRecord({schemaVersion:1,savedAt:now.toISOString(),card});
  if (!value) throw new Error('Сервис вернул неполную аварийную карточку. Обновите сведения перед сохранением.');
  const existing = records(storage.getItem(EMERGENCY_CARD_KEY)).map(serverRecord).filter(Boolean);
  const next = [value,...existing.filter(item=>item.card.departureId!==value.card.departureId)].slice(0,20);
  const raw = JSON.stringify(next);
  if (raw.length>MAX_SAFETY_STORAGE_LENGTH) throw new Error('Карточки занимают слишком много места. Удалите старую локальную копию.');
  storage.setItem(EMERGENCY_CARD_KEY, raw);
}

function startViewer() {
  const status=document.getElementById('safety-status'),list=document.getElementById('safety-list'),detail=document.getElementById('safety-detail');
  if (!status||!list||!detail) return;
  let cards=[],selected='';
  const element=(tag,value,className='')=>{const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;};
  function renderCard(card) {
    selected=card.id;detail.replaceChildren();
    for(const button of list.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.id===selected));
    detail.append(element('h2',card.title,'heading-5'),element('p',card.notice,'notice body-3'),element('p','Сохранено: '+(card.savedAt?new Date(card.savedAt).toLocaleString('ru-RU'):'дата неизвестна'),'caption-2'));
    const facts=element('dl','','facts');
    for(const [name,value] of card.facts){const row=element('div','');row.append(element('dt',name),element('dd',value||'Не указано'));facts.append(row);}detail.append(facts);
    detail.append(element('h3','Сообщение для передачи','heading-6'),element('p',card.message,'message'));
    const actions=element('div','','actions'),copy=element('button','Скопировать сообщение','button button-md'),remove=element('button','Удалить локальную копию','button button-md');copy.id='safety-copy';remove.id='safety-delete';
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(card.message);status.textContent='Сообщение скопировано. Оно ещё не передано экстренным службам.';}catch{status.textContent='Не удалось скопировать. Выделите текст сообщения и скопируйте его вручную.';}});
    remove.addEventListener('click',()=>{remove.disabled=true;const confirm=element('button','Подтвердить удаление','button button-md');const cancel=element('button','Оставить карточку','button button-md');actions.append(confirm,cancel);cancel.addEventListener('click',()=>{confirm.remove();cancel.remove();remove.disabled=false;});confirm.addEventListener('click',()=>{try{const key=card.source==='local'?LOCAL_SAFETY_KEY:EMERGENCY_CARD_KEY;const next=records(localStorage.getItem(key)).filter(item=>(card.source==='local'?item.id:item.card?.departureId)!==card.recordId);localStorage.setItem(key,JSON.stringify(next));selected='';load();status.textContent='Локальная копия удалена. Серверные сведения и уведомление МЧС не изменены.';}catch{status.textContent='Не удалось удалить копию. Проверьте доступ к хранилищу браузера.';}});});
    actions.append(copy,remove);detail.append(actions);
  }
  function load() {
    try{cards=parseOfflineSafety(localStorage.getItem(LOCAL_SAFETY_KEY),localStorage.getItem(EMERGENCY_CARD_KEY));}catch{status.textContent='Хранилище браузера недоступно. Здесь нельзя прочитать сохранённые карточки.';return;}
    list.replaceChildren();
    for(const card of cards){const li=element('li',''),button=element('button',card.title,'button button-md');button.dataset.id=card.id;button.type='button';button.addEventListener('click',()=>renderCard(card));li.append(button);list.append(li);}
    status.textContent=cards.length?'Сохранённых карточек: '+cards.length+'. Свежесть сведений проверьте перед выходом.':'На этом устройстве пока нет сохранённой карточки.';
    const query=new URLSearchParams(location.search),requested=query.get('passport')?'local:'+query.get('passport'):query.get('departure')?'server:'+query.get('departure'):'';
    const card=cards.find(item=>item.id===(selected||requested))||cards[0];
    if(card)renderCard(card);else{detail.replaceChildren(element('h2','Пока нет сохранённой карточки','heading-5'),element('p','При подключении откройте подготовку уведомления и нажмите «Сохранить на устройстве».','body-3'));}
  }
  window.addEventListener('storage',event=>{if(event.key===LOCAL_SAFETY_KEY||event.key===EMERGENCY_CARD_KEY||event.key===null)load();});
  load();
}
if(typeof document!=='undefined')startViewer();
