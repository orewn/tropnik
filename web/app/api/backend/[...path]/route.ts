import {NextRequest,NextResponse} from 'next/server';
import {backendRequestHeaders,backendResponseHeaders,validSessionToken as validToken} from '@/lib/backend-forwarding';
import {publicOriginPolicy} from '@/lib/backend-origin';
import {clearsAccountSession} from '@/lib/account-action';
import {API_TRANSPORT_LIMITS,apiResponseBytes,BodyLimitError,readBoundedBody,readBoundedJSON,requestDeadline} from '@/lib/api-transport';
const allowed=new Set(['auth','me','regions','routes','departures','recruitment-requests','sync','guides','reports','moderation','moderation-actions']);
const err=(status:number,code:string,message:string)=>NextResponse.json({error:{code,message}},{status,headers:{'Cache-Control':'no-store'}});
async function proxy(req:NextRequest,{params}:{params:Promise<{path:string[]}>}){
 const {path}=await params;
 if(!path?.length||!allowed.has(path[0])||path.some(p=>!p||p==='.'||p==='..'||p.includes('/')))return err(404,'not_found','Страница не найдена.');
 const config=process.env.TROPA_API_URL;
 if(!config)return err(503,'service_not_configured','Сервис аккаунтов и групп ещё не подключён. Карта и сохранение карточек доступны без регистрации.');
 const publicOrigin=publicOriginPolicy(process.env.PUBLIC_ORIGIN,process.env.NODE_ENV);
 if(!publicOrigin)return err(503,'service_config','Сервис временно недоступен.');
 const unsafe=!['GET','HEAD','OPTIONS'].includes(req.method);
 if(unsafe){const origin=req.headers.get('origin');if(!origin||origin!==publicOrigin.origin)return err(403,'origin_mismatch','Запрос отклонён. Откройте форму на сайте.');if(!req.headers.get('content-type')?.startsWith('application/json'))return err(415,'content_type','Требуется JSON.');}
 let url:URL;
 try{url=new URL(config);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();const local=['localhost','127.0.0.1','[::1]','api'].includes(url.hostname);if(url.protocol==='http:'&&!local)throw new Error();url.pathname=url.pathname.replace(/\/$/,'')+'/api/v1/'+path.map(encodeURIComponent).join('/');url.search=req.nextUrl.search;}catch{return err(503,'service_config','Сервис временно недоступен.');}
 const token=req.cookies.get('tropa_session')?.value;
 const headers=backendRequestHeaders(req.headers,token,process.env.TROPA_PROXY_TOKEN);
 const isAuth=req.method==='POST'&&path.length===2&&path[0]==='auth'&&['login','register'].includes(path[1]);
 const isLogout=req.method==='POST'&&path.length===2&&path[0]==='auth'&&path[1]==='logout';
 const clearSession=(response:NextResponse)=>{response.headers.set('X-Tropa-Session-Cleared','1');response.cookies.set('tropa_session','',{httpOnly:true,secure:publicOrigin.secureCookies,sameSite:'lax',path:'/',maxAge:0});return response;};
 const deadline=requestDeadline(API_TRANSPORT_LIMITS.proxyTimeoutMs,req.signal);
 let readingRequest=true;
 try{
  const body=unsafe&&req.body?await readBoundedBody(req,API_TRANSPORT_LIMITS.requestBytes,deadline.signal):undefined;
  deadline.signal.throwIfAborted();readingRequest=false;
  const upstream=await fetch(url,{method:req.method,headers,body:body as BodyInit|undefined,redirect:'error',cache:'no-store',signal:deadline.signal});
  deadline.signal.throwIfAborted();
  const closesAccountSession=clearsAccountSession(req.method,path,upstream.status);
  if(upstream.status===204||req.method==='HEAD'){const response=new NextResponse(null,{status:upstream.status,headers:backendResponseHeaders(upstream.headers)});return isLogout||closesAccountSession?clearSession(response):response;}
  const data=await readBoundedJSON(upstream,apiResponseBytes(path.join('/'),req.method,upstream.ok),deadline.signal) as {data?:{token?:unknown;expiresAt?:unknown;[key:string]:unknown};[key:string]:unknown};let session:string|undefined,expires:Date|undefined;
  if(isAuth&&upstream.ok){const raw=data?.data?.token,expiry=data?.data?.expiresAt;const parsed=typeof expiry==='string'?new Date(expiry):null;if(!validToken(raw)||!parsed||!Number.isFinite(parsed.getTime())||parsed.getTime()<=Date.now())return err(502,'invalid_session','Не удалось безопасно открыть сессию.');session=raw;expires=parsed;if(data.data)delete data.data.token;}
  const response=NextResponse.json(data,{status:upstream.status,headers:backendResponseHeaders(upstream.headers)});
  if(session)response.cookies.set('tropa_session',session,{httpOnly:true,secure:publicOrigin.secureCookies,sameSite:'lax',path:'/',expires});
  return isLogout||closesAccountSession||(upstream.status===401&&!isAuth&&validToken(token))?clearSession(response):response;
 }catch(e){const response=e instanceof BodyLimitError?readingRequest?err(413,'body_too_large','Данные слишком велики.'):err(502,'response_too_large','Ответ сервера слишком велик. Действие не подтверждено; попробуйте позже.'):err(502,'upstream_unavailable',isLogout?'Вы вышли на этом устройстве. Отзыв серверной сессии не подтверждён из-за отсутствия связи.':'Нет ответа от сервера. Действие не подтверждено; попробуйте позже.');return isLogout?clearSession(response):response;}
 finally{deadline.dispose();}
}
export const GET=proxy;export const HEAD=proxy;export const POST=proxy;export const PATCH=proxy;export const DELETE=proxy;
