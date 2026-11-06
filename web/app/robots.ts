export const dynamic='force-dynamic';
import {getOrigin,isPublicIndexingEnabled} from '@/lib/content';
export default function robots(){return{rules:isPublicIndexingEnabled()?{userAgent:'*',allow:'/',disallow:['/api/','/account','/moderation','/chat','/offline','/qa-mobile','/trips','/community']}:{userAgent:'*',disallow:'/'},sitemap:`${getOrigin()}/sitemap.xml`};}
