// Public errors carry only explicitly selected, safe messages and optional HTTP
// status. Native errors must never be exposed in activity events or results.
export class WebFetchError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'WebFetchError';
    this.code = code;
    if (typeof status === 'number') this.status = status;
  }
}
