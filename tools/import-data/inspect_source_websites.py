#!/usr/bin/env python3
"""Inspect each supplied source website once, without upgrading verification.

Only metadata, hashes, titles and name-match signals are retained. Full source
articles/photos are not copied into the deliverable. A readable page or a name
match alone does not establish authority, access, safety or route geometry.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'data/catalog'
UA='Tropa-source-review/0.1 (route source attribution review; https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site)'
LIMIT=3_000_000


class Text(HTMLParser):
    def __init__(self):
        super().__init__();self.skip=0;self.in_title=False;self.parts=[];self.titles=[]
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style','noscript','svg'): self.skip+=1
        if tag=='title': self.in_title=True
    def handle_endtag(self,tag):
        if tag in ('script','style','noscript','svg') and self.skip: self.skip-=1
        if tag=='title': self.in_title=False
    def handle_data(self,data):
        if not self.skip:
            value=' '.join(data.split())
            if value:self.parts.append(value)
            if self.in_title:self.titles.append(value)


def normalized(s):
    return re.sub(r'[^\w]+',' ',s.lower().replace('ё','е'),flags=re.U).strip()


def inspect(url,rows):
    result={'url':url,'routeIds':[r['id'] for r in rows],
            'checkedAt':datetime.now(timezone.utc).isoformat(),
            'method':'Direct read of the website URL supplied by OSM; not automatically an authoritative source.'}
    if urllib.parse.urlparse(url).scheme not in ('http','https'):
        return {**result,'status':'unsupported_url_scheme'},''
    try:
        req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/html,application/xhtml+xml'})
        with urllib.request.urlopen(req,timeout=22) as response:
            body=response.read(LIMIT+1);ctype=response.headers.get('Content-Type','')
            charset=response.headers.get_content_charset() or 'utf-8'
            result.update({'httpStatus':response.status,'finalUrl':response.url,
                           'contentType':ctype,'lastModified':response.headers.get('Last-Modified')})
        if len(body)>LIMIT:raise RuntimeError('Response exceeds 3 MB inspection bound')
        parser=Text();parser.feed(body.decode(charset,errors='replace'))
        content=' '.join(parser.parts);normal=normalized(content)
        full_title=' '.join(parser.titles)
        # Keep a short page title as metadata, not source article excerpts.
        result.update({'status':'readable' if len(content)>150 else 'insufficient_readable_content',
                       'bodySha256':hashlib.sha256(body).hexdigest(),'bodyBytes':len(body),
                       'readableCharacterCount':len(content),'title':' '.join(full_title.split()[:20]),
                       'fullArticleRedistributed':False,
                       'routeNameSignals':[]})
        for row in rows:
            wanted=normalized(row['title'])
            found=bool(wanted and len(wanted)>4 and wanted in normal)
            result['routeNameSignals'].append({'routeId':row['id'],'exactNormalizedNameFound':found})
        # A bounded preview is emitted for human review but not saved as content.
        indexes=[content.lower().find(row['title'].lower()) for row in rows]
        indexes=[i for i in indexes if i>=0]
        start=max(0,min(indexes)-100) if indexes else 0
        preview=content[start:start+750]
        return result,preview
    except Exception as error:
        result.update({'status':'unavailable','error':str(error),
                       'retryOrIdentityChangeUsed':False})
        return result,''


def main():
    routes=json.loads((OUT/'routes.json').read_text())['routes']
    grouped={}
    for row in routes:
        if row.get('sourceWebsite'):
            url=urllib.parse.urldefrag(row['sourceWebsite'])[0]
            grouped.setdefault(url,[]).append(row)
    existing_path=OUT/'website-inspection.json'
    existing={}
    if existing_path.exists():
        existing={x['url']:x for x in json.loads(existing_path.read_text()).get('sources',[])}
    result=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures={pool.submit(inspect,url,rows):url for url,rows in grouped.items() if url not in existing}
        result.extend(existing[url] for url in grouped if url in existing)
        for future in as_completed(futures):
            record,preview=future.result();result.append(record)
            print(json.dumps({'url':record['url'],'status':record['status'],'title':record.get('title'),
                              'routeNames':[r['title'] for r in grouped[record['url']]],
                              'nameSignals':record.get('routeNameSignals'),
                              'error':record.get('error'),'reviewPreview':preview},ensure_ascii=False),flush=True)
    output={'createdAt':datetime.now(timezone.utc).isoformat(),
            'scope':'All distinct website URLs currently supplied in the imported route records. Fragments share one network read. Name matches are only candidates for human review.',
            'sources':sorted(result,key=lambda r:r['url'])}
    existing_path.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'sources':len(result),'readable':sum(r['status']=='readable' for r in result),'unavailable':sum(r['status']=='unavailable' for r in result)},ensure_ascii=False),flush=True)


if __name__=='__main__':main()
