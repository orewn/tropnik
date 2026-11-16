import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {UserFacingError, apiErrorText, userErrorText} from '../lib/user-facing-errors.ts';
import {ApiError, errorText} from '../lib/api.ts';
import {MAX_SAFETY_STORAGE_LENGTH, saveLocalSafetyPassports, saveOfflineEmergencyCard} from '../public/offline-safety.js';
import {newSafetyPassport, transitionSafetyPassport} from '../lib/safety-passport.ts';
import {validateHikeDraft} from '../lib/hike-draft.ts';

test('native and arbitrary error messages stay out of Russian UI', () => {
  const cases = [
    [new SyntaxError('Unexpected token at byte 12'), 'plan_import', /прочитать файл плана/],
    [new Error('Preview resource unavailable (404)'), 'route_geometry', /загрузить линии этапов/],
    [new Error('Ошибка: provider failed after commit'), 'action', /подтвердить действие/],
    [new TypeError('Failed to fetch'), 'download', /скачивание карты/],
    [new RangeError('Unexpected local range failure'), 'storage', /сохранить изменения/],
    [{message:'Untrusted plain object'}, 'safety_status', /статус уведомления/],
  ];
  for (const [failure, context, expected] of cases) {
    const displayed = userErrorText(failure, context);
    assert.match(displayed, expected);
    assert.ok(!displayed.includes(failure.message), 'the diagnostic is not presented');
  }
  const impostor = Object.assign(new Error('Not trusted'), {name:'UserFacingError'});
  assert.notEqual(userErrorText(impostor), impostor.message);
});

test('trusted domain guidance survives with the original diagnostic cause', () => {
  const cause = new Error('Source geometry integrity mismatch');
  const failure = new UserFacingError('Не удалось проверить и сохранить геометрию. Пакет не изменён.', {cause});
  assert.equal(userErrorText(failure, 'storage'), failure.message);
  assert.equal(errorText(failure, 'storage'), failure.message);
  assert.equal(failure.cause, cause);
  assert.equal(cause.message, 'Source geometry integrity mismatch');
});

test('browser storage and cancellation failures give a concrete Russian recovery', () => {
  const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  const security = new DOMException('Access is denied.', 'SecurityError');
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  assert.match(userErrorText(quota, 'storage'), /Недостаточно места.*Освободите/);
  assert.match(userErrorText(security, 'storage'), /Хранилище браузера недоступно/);
  assert.match(userErrorText(aborted, 'download'), /Скачивание остановлено.*не отмечен готовым/);
  assert.match(userErrorText(new DOMException('Timed out', 'TimeoutError')), /Действие не подтверждено/);
});

test('API rendering uses confirmed codes while preserving the full original error', () => {
  const failure = new ApiError(409, 'departure_full', 'There are no vacancies', true);
  assert.equal(errorText(failure), 'Свободных мест больше нет.');
  assert.equal(failure.message, 'There are no vacancies');
  assert.equal(failure.code, 'departure_full');
  assert.equal(failure.status, 409);
  assert.equal(failure.localSessionCleared, true);
  assert.match(errorText(new ApiError(503, 'future_code', 'Ошибка: action may have committed')), /подтвердить действие.*обновите данные/);
  for (const code of ['__proto__', 'constructor', 'toString']) {
    assert.equal(typeof apiErrorText(code, 500), 'string');
    assert.match(apiErrorText(code, 500), /подтвердить действие/);
  }
  assert.match(apiErrorText('account_has_active_trips', 409), /завершите участие.*закройте свои открытые заявки/);
  assert.match(apiErrorText('repeated_content', 429), /Новое сообщение не отправлено.*историю обсуждения/);
});

test('Pages API alias shares the same safe native and domain error formatting', () => {
  const source = readFileSync(new URL('../pages-preview/src/api.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS},
  }).outputText;
  const scope = {
    exports:{}, Error, DOMException,
    require(name) {
      if (name === 'virtual:pages-build') return {default:{base:'/fixture/'}};
      assert.equal(name, '../../lib/user-facing-errors.ts');
      return {apiErrorText, userErrorText};
    },
  };
  vm.runInNewContext(compiled, scope);
  const pages = scope.exports;
  const failures = [
    [new DOMException('Quota exceeded', 'QuotaExceededError'), 'storage'],
    [new Error('Preview resource unavailable (503)'), 'route_geometry'],
    [new UserFacingError('Проверка целостности карты не пройдена.'), 'download'],
  ];
  for (const [failure, context] of failures) assert.equal(pages.errorText(failure, context), errorText(failure, context));
  assert.equal(pages.errorText(new pages.ApiError()), pages.PREVIEW_API_MESSAGE);
  assert.match(pages.errorText(new pages.ApiError(502, 'unknown', 'Raw upstream message')), /подтвердить действие/);
});

test('standalone safety storage retains useful bounded-storage guidance without native text', () => {
  let written = false;
  const storage = {setItem() {written = true;}};
  assert.throws(() => saveLocalSafetyPassports(storage, [{notes:'я'.repeat(MAX_SAFETY_STORAGE_LENGTH)}]), failure => {
    assert.ok(failure instanceof RangeError);
    assert.equal(failure.code, 'safety_passports_too_large');
    assert.equal(userErrorText(failure, 'storage'), failure.message);
    return true;
  });
  assert.equal(written, false);
  assert.throws(() => saveOfflineEmergencyCard(storage, {}), failure => {
    assert.equal(failure.code, 'emergency_card_incomplete');
    assert.match(userErrorText(failure, 'storage'), /неполную аварийную карточку/);
    return true;
  });
});

test('safety transitions show Russian status labels while the internal status stays unchanged', () => {
  const passport = newSafetyPassport('fixture', new Date('2026-11-16T00:00:00Z'));
  assert.throws(() => transitionSafetyPassport(passport, 'closed'), failure => {
    assert.ok(failure instanceof UserFacingError);
    assert.match(userErrorText(failure, 'safety_status'), /Черновик.*Поход закрыт/);
    assert.ok(!failure.message.includes('draft'));
    assert.ok(!failure.message.includes('closed'));
    return true;
  });
  assert.equal(passport.status, 'draft');
});

test('unsupported imported plan format gives guidance without exposing the JSON schema key', () => {
  assert.throws(() => validateHikeDraft({schemaVersion:2}, {}), failure => {
    assert.ok(failure instanceof UserFacingError);
    assert.match(userErrorText(failure, 'plan_import'), /формат файла версии 1/);
    assert.ok(!failure.message.includes('schemaVersion'));
    return true;
  });
});
