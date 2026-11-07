import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  buildEmergencyMessage,
  buildSafetyPackage,
  invalidateOfficialStatus,
  newSafetyPassport,
  notificationDeadline,
  parseSafetyPassport,
  safetyReadiness,
  transitionSafetyPassport,
} from '../lib/safety-passport.ts';

function completePassport() {
  const passport = newSafetyPassport('test', new Date('2026-11-01T00:00:00Z'));
  Object.assign(passport, {
    routeTitle: 'Тестовый маршрут',
    region: 'Карелия',
    startDate: '2026-11-23',
    endDate: '2026-11-25',
    startPoint: 'Старт',
    finishPoint: 'Финиш',
    routeDescription: 'Старт — озеро — финиш',
    communication: 'Телефон и спутниковый коммуникатор',
    leaderName: 'Руководитель',
    leaderPhone: '+70000000000',
    outsideContactName: 'Контакт',
    outsideContactPhone: '+71111111111',
    returnDeadline: '2026-11-25T20:00',
    participants: [{id: 'p1', name: 'Участник', phone: '+72222222222', emergencyName: '', emergencyPhone: '', minor: false}],
  });
  return passport;
}

test('notification deadline counts weekdays rather than calendar days', () => {
  assert.equal(notificationDeadline('2026-11-23'), '2026-11-09');
  assert.equal(notificationDeadline(''), undefined);
});

test('passport readiness requires route, contacts, dates and a real participant', () => {
  const empty = newSafetyPassport('empty');
  assert.equal(safetyReadiness(empty).complete, false);
  const complete = completePassport();
  assert.equal(safetyReadiness(complete).complete, true);
  complete.endDate = '2026-11-20';
  assert.equal(safetyReadiness(complete).complete, false);
});

test('official status cannot be fabricated and critical edits require an amendment', () => {
  const ready = transitionSafetyPassport(completePassport(), 'ready', new Date('2026-11-02T00:00:00Z'));
  const submitted = transitionSafetyPassport(ready, 'submitted', new Date('2026-11-03T00:00:00Z'));
  assert.throws(() => transitionSafetyPassport(submitted, 'confirmed'), /номер|подтверждение/i);
  const withReference = {...submitted, mchsReference: 'REG-123'};
  const confirmed = transitionSafetyPassport(withReference, 'confirmed', new Date('2026-11-04T00:00:00Z'));
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(invalidateOfficialStatus({...confirmed, startDate: '2026-11-24'}).status, 'amendment_required');
});

test('stored values are parsed defensively', () => {
  assert.equal(parseSafetyPassport(null), undefined);
  assert.equal(parseSafetyPassport({schemaVersion: 1, id: ''}), undefined);
  const parsed = parseSafetyPassport({...completePassport(), status: 'forged', participants: [{id: 'p', name: 10}]});
  assert.equal(parsed?.status, 'draft');
  assert.equal(parsed?.participants[0]?.name, '');
});

test('exports state clearly that a local package is not an official submission', () => {
  const passport = completePassport();
  const text = buildSafetyPackage(passport);
  assert.match(text, /не является поданным уведомлением/i);
  assert.match(text, /Тестовый маршрут/);
  assert.match(buildEmergencyMessage(passport, '60.000000, 30.000000'), /60\.000000, 30\.000000/);
});

test('registration UI remains local-first and links to the official MChS form', async () => {
  const component = await readFile(new URL('../components/SafetyRegistration.tsx', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../lib/safety-passport.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../app/safety/registration/page.tsx', import.meta.url), 'utf8');
  assert.match(policy, /forms\.mchs\.gov\.ru\/registration_tourist_groups/);
  assert.match(component, /MCHS_REGISTRATION_URL/);
  assert.match(component, /localStorage\.setItem\(SAFETY_STORAGE_KEY/);
  assert.match(component, /href="tel:112"/);
  assert.match(component, /Переход по ссылке сам по себе не является регистрацией/);
  assert.doesNotMatch(component, /api<|fetch\(/);
  assert.match(page, /SafetyRegistration/);
});
