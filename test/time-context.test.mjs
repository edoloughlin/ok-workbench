import assert from 'node:assert/strict';
import test from 'node:test';
import timeContext from '../src/time-context.js';

const { currentDateTimeContext, currentTimeZone, withCurrentDateTime } = timeContext;

test('current date and time context uses the supplied timezone', () => {
  const now = new Date('2026-09-17T13:30:00.000Z');
  assert.equal(currentDateTimeContext(now, 'Europe/Dublin'), 'Current date and time: 17 September 2026, 14:30 Europe/Dublin');
  assert.equal(withCurrentDateTime('Prompt', now, 'Europe/Dublin'), 'Prompt\n\nCurrent date and time: 17 September 2026, 14:30 Europe/Dublin');
  assert.equal(currentDateTimeContext(new Date('2026-01-02T00:30:00.000Z'), 'America/New_York'), 'Current date and time: 1 January 2026, 19:30 America/New_York');
});

test('the server local timezone is used unless an explicit valid override is configured', () => {
  assert.equal(currentTimeZone({ OK_WORKBENCH_TIME_ZONE: 'Europe/Dublin' }), 'Europe/Dublin');
  assert.equal(currentTimeZone({ OK_WORKBENCH_TIME_ZONE: 'not/a-timezone' }), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
});
