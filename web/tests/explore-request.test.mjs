import test from 'node:test';
import assert from 'node:assert/strict';
import {ExploreRequestSession} from '../lib/explore-request.ts';

function draft(session, routeId = 'first') {
  session.open(routeId);
  session.edit('date', '2026-12-15');
  session.edit('note', `Draft for ${routeId}`);
}

test('Back out of a saved request then selecting another route cannot reopen or transfer its result and fields', () => {
  const session = new ExploreRequestSession('first');
  draft(session);
  const attempt = session.begin('first');
  session.succeed(attempt); session.finish(attempt);
  assert.equal(session.getSnapshot().saved, true);
  session.select(undefined, true);
  session.select('second');
  assert.deepEqual(session.getSnapshot(), {routeId: 'second', open: false, date: '', note: '', error: '', busy: false, saved: false});
  session.open('second');
  assert.equal(session.getSnapshot().open, true);
  assert.equal(session.getSnapshot().saved, false);
  assert.equal(session.getSnapshot().note, '');
});

test('closing and reopening the same route preserves the draft but clears old errors and success', () => {
  for (const outcome of ['error', 'saved']) {
    const session = new ExploreRequestSession('first');
    draft(session);
    const attempt = session.begin('first');
    if (outcome === 'error') session.fail(attempt, 'Previous request failed'); else session.succeed(attempt);
    session.finish(attempt); session.close(); session.open('first');
    assert.deepEqual(session.getSnapshot(), {routeId: 'first', open: true, date: '2026-12-15', note: 'Draft for first', error: '', busy: false, saved: false});
  }
});

test('restoring history closes the dialog even for the same route and invalidates its pending submission', () => {
  const session = new ExploreRequestSession('first');
  draft(session);
  const attempt = session.begin('first');
  session.select('first', true);
  assert.equal(session.getSnapshot().open, false);
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.getSnapshot().note, 'Draft for first', 'a draft may be reopened only for the same route');
  assert.equal(session.accept(attempt, () => assert.fail('old success must not navigate')), false);
  session.succeed(attempt); session.fail(attempt, 'Late failure'); session.finish(attempt);
  assert.equal(session.getSnapshot().saved, false);
  assert.equal(session.getSnapshot().error, '');
});

test('late asynchronous results cannot navigate, open auth or overwrite a different request', async () => {
  for (const reject of [false, true]) {
    const session = new ExploreRequestSession('first'), effects = [];
    draft(session);
    const old = session.begin('first');
    let settle;
    const response = new Promise((resolve, rejectPromise) => {settle = reject ? rejectPromise : resolve;});
    const completion = response.then(() => {
      session.succeed(old);
      session.accept(old, () => effects.push('navigate'));
    }, () => {
      session.fail(old, 'Late failure');
      session.accept(old, () => effects.push('auth'));
    }).finally(() => session.finish(old));
    session.select('second'); draft(session, 'second');
    const current = session.begin('second'), before = session.getSnapshot();
    settle(reject ? new Error('Unauthorized') : {id: 'created'});
    await completion;
    assert.deepEqual(effects, []);
    assert.equal(session.getSnapshot(), before, 'even stale finally must leave the new busy request untouched');
    session.succeed(current); session.finish(current);
    assert.equal(session.getSnapshot().saved, true);
    assert.equal(session.getSnapshot().routeId, 'second');
  }
});

test('leaving and returning to the same route does not revive its earlier submission', () => {
  const session = new ExploreRequestSession('first');
  draft(session);
  const old = session.begin('first');
  session.select('second'); session.select('first'); draft(session);
  const current = session.begin('first'), before = session.getSnapshot();
  session.succeed(old); session.fail(old, 'Old error'); session.finish(old);
  assert.equal(session.accept(old, () => assert.fail('route ID alone must not validate an old attempt')), false);
  assert.equal(session.getSnapshot(), before);
  session.succeed(current); session.finish(current);
  assert.equal(session.getSnapshot().saved, true);
});

test('close and unmount cancellation invalidate pending side effects', () => {
  for (const cancel of ['close', 'cancelPending']) {
    const session = new ExploreRequestSession('first');
    draft(session);
    const attempt = session.begin('first');
    session[cancel]();
    assert.equal(session.accept(attempt, () => assert.fail(`${cancel} allowed a stale navigation`)), false);
    const before = session.getSnapshot();
    session.succeed(attempt); session.fail(attempt, 'Late error'); session.finish(attempt);
    assert.equal(session.getSnapshot(), before);
  }
});

test('submission snapshots fields, rejects duplicate submissions and cannot submit a stale route form', () => {
  const session = new ExploreRequestSession('first');
  assert.equal(session.begin('first'), undefined, 'a closed request cannot be submitted');
  draft(session);
  assert.equal(session.begin('second'), undefined);
  const attempt = session.begin('first');
  assert.deepEqual(attempt, {routeId: 'first', date: '2026-12-15', note: 'Draft for first'});
  assert.equal(session.begin('first'), undefined, 'one active submission per form');
  session.edit('note', 'More detail');
  assert.equal(attempt.note, 'Draft for first', 'network payload belongs to the submitted version');
  session.finish(attempt);
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.accept(attempt, () => assert.fail('finished requests cannot apply twice')), false);
});

test('React store snapshots are stable between changes and subscription cleanup releases the listener', () => {
  const session = new ExploreRequestSession('first');
  let notifications = 0;
  const release = session.subscribe(() => notifications++), before = session.getSnapshot();
  assert.equal(session.getSnapshot(), before);
  session.select('first');
  assert.equal(session.getSnapshot(), before);
  session.open('first');
  assert.equal(notifications, 1);
  assert.notEqual(session.getSnapshot(), before);
  const opened = session.getSnapshot();
  session.select('first');
  assert.equal(session.getSnapshot(), opened, 'same-route map selection must not reset an open form');
  assert.equal(notifications, 1);
  release(); session.close();
  assert.equal(notifications, 1);
});
