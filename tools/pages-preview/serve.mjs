import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {resolve, join, extname} from 'node:path';
import {pathToFileURL} from 'node:url';

const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.geojson':'application/geo+json','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.woff':'font/woff','.webmanifest':'application/manifest+json','.pbf':'application/x-protobuf','.txt':'text/plain; charset=utf-8','.pdf':'application/pdf','.apk':'application/vnd.android.package-archive'};

/** Local static review server: project prefix and directory redirects mirror Pages. */
export async function createPreviewServer(directory) {
const root = resolve(directory);
const {base} = JSON.parse(await readFile(join(root, 'build-info.json'), 'utf8'));
const server=createServer(async(req,res)=>{
  try {
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === base.slice(0, -1)) {res.writeHead(301,{Location:base+url.search});res.end();return;}
    if (!url.pathname.startsWith(base)) {res.writeHead(404);res.end(`Preview is under ${base}`);return;}
    let relative;
    try {relative=decodeURIComponent(url.pathname.slice(base.length));} catch {res.writeHead(400);res.end('Invalid URL');return;}
    if(relative.includes('\0')){res.writeHead(400);res.end('Invalid URL');return;}
    let path = resolve(root, relative);
    if (path !== root && !path.startsWith(root + '/')) {res.writeHead(403);res.end();return;}
    const info = await stat(path).catch(()=>null);
    if (info?.isDirectory()) {
      if (!url.pathname.endsWith('/')) {res.writeHead(301,{Location:url.pathname+'/'+url.search});res.end();return;}
      path=join(path,'index.html');
    }
    let status=200,data;
    try {data=await readFile(path);} catch {status=404;path=join(root,'404.html');data=await readFile(path);}
    res.writeHead(status,{'Content-Type':mime[extname(path)]||'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'});res.end(req.method==='HEAD'?undefined:data);
  } catch {res.writeHead(500);res.end('Preview server error');}
});
return {server,base};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  const value=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
  const {server,base}=await createPreviewServer(value('--dir','web/pages-preview/dist'));
  const port=Number(value('--port','4173'));
  server.listen(port,'127.0.0.1',()=>console.log(`Static preview: http://127.0.0.1:${server.address().port}${base}`));
}
