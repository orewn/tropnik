import test from 'node:test';
import assert from 'node:assert/strict';
import {trailGeometryDescription, sourceDateLabel, safeSourceHref, formatEvidenceDate} from '../lib/trail-evidence.ts';

test('a community description without a track never claims OSM or displayed geometry', () => {
  const explanation = trailGeometryDescription({publicationStatus:'reference', sourceKind:'community'});
  assert.match(explanation, /Линия пути пока не добавлена/);
  assert.doesNotMatch(explanation, /OpenStreetMap|Отображены сегменты|соответствует опубликованной/);
  assert.equal(sourceDateLabel('community'), 'Источник рассмотрен');
});

test('missing geometry remains explicit even for a published route', () => {
  assert.match(trailGeometryDescription({publicationStatus:'published'}), /Линия пути пока не добавлена/);
});

test('existing sourced lines and published geometry keep their distinct provenance', () => {
  assert.match(trailGeometryDescription({publicationStatus:'reference', geometryUrl:'/data/routes/1.geojson'}), /OpenStreetMap/);
  assert.match(trailGeometryDescription({publicationStatus:'reference', sourceKind:'community', geometry:{type:'LineString',coordinates:[[1,1],[2,2]]}}), /сообщества/);
  assert.match(trailGeometryDescription({publicationStatus:'published', geometryUrl:'/data/routes/1.geojson'}), /опубликованный путь/);
});

test('official GPX and an official schematic line do not claim OSM provenance or field verification', () => {
  const track = trailGeometryDescription({publicationStatus:'reference', geometryUrl:'/data/routes/official.geojson', geometrySourceKind:'official', geometryScope:'source_track'});
  assert.match(track, /опубликована организацией/);
  assert.doesNotMatch(track, /OpenStreetMap|проверена на местности/);
  const scheme = trailGeometryDescription({publicationStatus:'reference', geometryUrl:'/data/routes/official.geojson', geometrySourceKind:'official', geometryScope:'source_scheme'});
  assert.match(scheme, /схема пути/);
  assert.match(scheme, /подробная карта/);
});

test('source references reject executable schemes, credential URLs and invalid addresses', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,anything', 'https://user:secret@t.me/poiskpohod/1', '/relative-source', 'not a URL']) {
    assert.equal(safeSourceHref(value), null);
  }
  assert.equal(safeSourceHref('https://t.me/poiskpohod/164600'),'https://t.me/poiskpohod/164600');
});

test('message date and review date can be displayed independently without Invalid Date', () => {
  assert.equal(formatEvidenceDate('2026-11-06'), '06.11.2026');
  assert.equal(formatEvidenceDate('2026-11-05T22:30:00Z'), '06.11.2026');
  assert.equal(formatEvidenceDate('invalid'), 'Дата не указана');
  assert.equal(formatEvidenceDate(), 'Дата не указана');
});
