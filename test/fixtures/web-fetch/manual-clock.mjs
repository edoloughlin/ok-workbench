// Native AbortSignal.timeout uses internal timers, which node:test cannot advance.
// Route it through mocked setTimeout so queue, extraction and abort deadlines all
// advance together. Tests in a file must remain sequential while this is active.
export function manualClock(t) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const performanceMock = t.mock.method(performance, 'now', () => now);
  const abortMock = t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    t.mock.timers.reset();
    performanceMock.mock.restore();
    abortMock.mock.restore();
  };
  t.after(restore);
  return {
    advance(milliseconds) { now += milliseconds; t.mock.timers.tick(milliseconds); },
    restore,
  };
}

// Drain promise continuations without sleeping or advancing deadline timers.
export const settle = () => new Promise(resolve => setImmediate(resolve));
