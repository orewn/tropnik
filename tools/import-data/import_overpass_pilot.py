#!/usr/bin/env python3
"""One bounded read-only OSM path query near Avachinsky, not an app backend."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog'
RAW = OUT / 'raw/overpass'
URL = 'https://overpass-api.de/api/interpreter'
# South, west, north, east. This is a small pilot area, not Kamchatka as a whole.
BBOX = [53.15, 158.55, 53.35, 159.0]
QUERY = '[out:json][timeout:25][maxsize:33554432];way["highway"~"^(path|footway|bridleway)$"](53.15,158.55,53.35,159.0);out geom;'
UA = 'Tropa-data-import/0.1 (one bounded OSM path query; https://tropa-rf-atlas-2026.wintrybluebell1.chatgpt.site)'


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(data, bytes):
        data = (json.dumps(data, ensure_ascii=False, separators=(',', ':'))+'\n').encode()
    path.write_bytes(data)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    raw = RAW / 'kamchatka-avachinsky.json'
    source_path = RAW / 'kamchatka-avachinsky.source.json'
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'sourceUrl': URL,
              'query': QUERY, 'bboxSouthWestNorthEast': BBOX, 'requests': 0,
              'scope': 'A single bounded Avachinsky-area query, not all Kamchatka trails.',
              'license': 'ODbL-1.0', 'attribution': '© OpenStreetMap contributors'}
    try:
        if raw.exists() and source_path.exists():
            body=raw.read_bytes();meta=json.loads(source_path.read_text())
            if hashlib.sha256(body).hexdigest()!=meta['sha256']:
                raise RuntimeError('Cached response checksum mismatch')
        else:
            req=urllib.request.Request(URL, data=urllib.parse.urlencode({'data':QUERY}).encode(),
                headers={'User-Agent':UA,'Content-Type':'application/x-www-form-urlencoded'})
            report['requests']=1
            with urllib.request.urlopen(req, timeout=40) as response:
                body=response.read(10_000_001)
            if len(body)>10_000_000:
                raise RuntimeError('Response exceeded bounded 10 MB budget')
            data=json.loads(body)
            if data.get('remark'):
                raise RuntimeError('Overpass reported incomplete/error result: '+data['remark'])
            meta={'sourceUrl':URL,'query':QUERY,'retrievedAt':datetime.now(timezone.utc).isoformat(),
                  'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body),
                  'osmTimestamp':data.get('osm3s',{}).get('timestamp_osm_base'),
                  'license':'ODbL-1.0','attribution':'© OpenStreetMap contributors'}
            save(raw,body);save(source_path,meta)
        data=json.loads(body);features=[]
        for item in data.get('elements',[]):
            tags=item.get('tags',{})
            if item.get('type')!='way' or tags.get('footway') in ('sidewalk','crossing','traffic_island','link'):
                continue
            coords=[[p['lon'],p['lat']] for p in item.get('geometry',[])]
            if len(coords)<2: continue
            ident=item['id']
            props={'id':f'osm-way-{ident}','sourceType':'raw_trail','osmType':'way','osmId':ident,
                   'name':tags.get('name:ru') or tags.get('name'),'regionIds':['kamchatka'],
                   'osmTags':tags,'highway':tags.get('highway'),
                   'sourceUrl':f'https://www.openstreetmap.org/way/{ident}',
                   'dataSourceUrl':URL,'sourceRawSha256':meta['sha256'],'retrievedAt':meta['retrievedAt'],
                   'upstreamDataTimestamp':meta['osmTimestamp'],'license':'ODbL-1.0',
                   'attribution':'© OpenStreetMap contributors','difficulty':None,'conditions':None,
                   'fieldVerified':False,'navigationReady':False,'accessPermissionVerified':False,
                   'verificationStatus':'source_only','publicationStatus':'reference',
                   'geometryNote':'Original OSM way, not a complete or verified itinerary.'}
            features.append({'type':'Feature','id':props['id'],'properties':props,
                             'geometry':{'type':'LineString','coordinates':coords}})
        output=OUT/'raw-trails-kamchatka-pilot.geojson'
        save(output,{'type':'FeatureCollection','features':features})
        report.update({'status':'imported','rawTrailCount':len(features),'source':meta,
                       'outputPath':output.name,'outputSha256':hashlib.sha256(output.read_bytes()).hexdigest(),
                       'outputBytes':output.stat().st_size})
    except Exception as error:
        report.update({'status':'unavailable','rawTrailCount':0,'error':str(error),
                       'retryOrAlternateEndpointUsed':False})
    save(OUT/'overpass-pilot-report.json',report)
    print(json.dumps(report,ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
