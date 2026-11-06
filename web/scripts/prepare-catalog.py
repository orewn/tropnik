import json,shutil
from pathlib import Path
root=Path(__file__).resolve().parents[1]
catalog=root.parent/'data/catalog'
records=json.loads((catalog/'routes.json').read_text())['routes']
evidence={r['osmRelationId']:r for r in json.loads((catalog/'verification-evidence.json').read_text())['records']}
aliases={3748147:'kavkaz-16a',3748250:'kavkaz-16b',11566519:'kavkaz-8a'}
points={};out=[];active_files=set();target=root/'public/data/imported';target.mkdir(parents=True,exist_ok=True)
for r in records:
 geometry=json.loads((catalog/r['geometryPath']).read_text())
 lines=[]
 def readgeom(g):
  if g['type']=='LineString':lines.append(g['coordinates'])
  elif g['type']=='MultiLineString':lines.extend(g['coordinates'])
  elif g['type']=='GeometryCollection':
   for sub in g['geometries']:readgeom(sub)
 if geometry['type']=='FeatureCollection':
  for f in geometry['features']:readgeom(f['geometry'])
 elif geometry['type']=='Feature':readgeom(geometry['geometry'])
 else:readgeom(geometry)
 line=max(lines,key=len);center=line[len(line)//2][:2]
 routeid=aliases.get(r['osmId'],r['id'])
 points[routeid]={'center':center,'bbox':r['bbox'],'osmId':r['osmId'],'geometryLengthKm':r['geometryLengthKm'],'sourceTechnicalDifficulty':r.get('sourceDifficultyTags',{}).get('sac_scale')}
 if r['osmId'] in aliases:continue
 geoout=target/(r['id']+'.geojson');active_files.add(geoout.name)
 # Preserve real segments without synthetic joins, but strip repeated verbose properties for the display payload.
 if geometry['type']=='FeatureCollection':
  for f in geometry['features']:f['properties']={k:v for k,v in f.get('properties',{}).items() if k in ['osm_id','osmId','wayId','id','sac_scale','trail_visibility','surface','access']}
 geoout.write_text(json.dumps(geometry,ensure_ascii=False,separators=(',',':')))
 e=evidence.get(r['osmId']);published=(e or {}).get('publishedFacts',{})
 duration=published.get('publishedDurationDays')
 if isinstance(duration,dict):duration=f"{duration['min']}–{duration['max']} дней"
 elif duration is not None:duration=f'{duration} дн.'
 duration=published.get('publishedWalkingTime',duration)
 description='Пеший маршрут из открытой базы OpenStreetMap. На карте сохранены исходные сегменты: между ними могут быть развилки и разрывы. Проходимость, разрешения и условия ещё требуют проверки.'
 if e:description=e['summary']+' Геометрия OSM не сверена с полной официальной ниткой.'
 notes=['Проверить актуальный доступ и ограничения у администрации территории.','Оценить технические участки, набор высоты и подготовку группы с подходящим гидом.','Геометрия из открытой базы не является проверенным навигационным треком.']
 if e and e.get('sourceCaution'):notes.insert(0,e['sourceCaution'])
 item={'id':routeid,'regionId':r['regionIds'][0],'regionIds':r['regionIds'],'title':r['title'],'subtitle':('Маршрут '+str(r['ref'])+' · ' if r.get('ref') else '')+'Данные OpenStreetMap','description':description,'distanceKm':published.get('publishedDistanceKm'),'duration':duration,'ascentM':None,'difficulty':'unknown','difficultyLabel':'Сложность не оценена','geometryUrl':'/data/imported/'+geoout.name,'sourceUrl':r['sourceUrl'],'sourceName':'OpenStreetMap','checkedAt':r['retrievedAt'][:10],'publicationStatus':'reference','season':published.get('publishedSeason','Требует проверки'),'notes':notes,'sourceKind':'database',**points[routeid]}
 if e:
  item['officialEvidence']={'url':e.get('officialDescriptionUrl',e['sourceUrl']),'summary':e['summary'],'checkedAt':e['checkedAt'][:10],'scope':e.get('displayScope','Официальное описание, без проверки геометрии')}
  if e.get('operatingStatus') not in [None,'unknown']:
   item['operatingNotice']={'title':e.get('operatingLabel') or ('По сообщению от '+e['sourcePublishedAt'] if e.get('sourcePublishedAt') else 'Статус у оператора · прочитан '+e['checkedAt'][:10]),'body':e['summary']+' Это датированное сообщение, перед выходом режим нужно перепроверить.','url':e['sourceUrl'],'effectiveAt':e.get('effectiveFrom') or e['checkedAt'][:10]}
 out.append(item)
for old in target.glob('*.geojson'):
 if old.name not in active_files:old.unlink()
(root/'lib/catalog.generated.json').write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')))
(root/'lib/route-points.generated.json').write_text(json.dumps(points,ensure_ascii=False,separators=(',',':')))
print(json.dumps({'importedCards':len(out),'allRoutePoints':len(points),'geometryFiles':len(list(target.glob('*.geojson'))),'cardBytes':(root/'lib/catalog.generated.json').stat().st_size,'geometryBytes':sum(x.stat().st_size for x in target.glob('*.geojson'))}))
