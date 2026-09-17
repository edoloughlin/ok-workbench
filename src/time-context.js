function currentTimeZone(environment = process.env) {
  const configured = environment.OK_WORKBENCH_TIME_ZONE;
  if (configured) {
    try { return new Intl.DateTimeFormat('en-IE', { timeZone: configured }).resolvedOptions().timeZone; } catch { /* fall back to the server's local zone */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function currentDateTimeContext(now = new Date(), timeZone = currentTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-IE', {
    timeZone, day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value;
  return `Current date and time: ${value('day')} ${value('month')} ${value('year')}, ${value('hour')}:${value('minute')} ${timeZone}`;
}

function withCurrentDateTime(prompt, now, timeZone) {
  return `${prompt}\n\n${currentDateTimeContext(now, timeZone)}`;
}

module.exports = { currentDateTimeContext, currentTimeZone, withCurrentDateTime };
