# HTTP and Browser Security

Covers:

- SEC-01 — DNS rebinding;
- SEC-04 — same-origin active SVG;
- SEC-07 — unbounded file reads;
- SEC-10 — broken IPv6 Host parsing.

Primary code area: `src/server.js`, plus browser rendering code in `src/public/app.js`.

---

# SEC-01 — Enforce loopback Host validation globally

## Problem

The server binds to `127.0.0.1`, but several information-bearing GET routes do not perform the same Host validation as chat/mutation routes.

Relevant routes observed during review included:

- `/api/project`
- `/api/document`
- `/asset/workspace/...`
- `/workspace/...`
- static UI routes

Binding to loopback does not prevent DNS rebinding. A hostile website can retain its browser origin while its DNS name later resolves to `127.0.0.1`.

## Required invariant

> No request reaches any Workbench route unless the HTTP authority is an explicitly allowed local authority.

This is a server-wide security property. It must not be implemented only in chat/mutation handlers.

## Implementation

Move Host/authority validation to the earliest common HTTP request path, before URL route dispatch.

Conceptually:

```js
function handleRequest(req, res) {
  if (!isAllowedLocalAuthority(req.headers.host)) {
    return reject(res);
  }

  const url = parseUrl(req);
  return route(req, res, url);
}
```

Do not use:

```js
String(req.headers.host || '').split(':')[0]
```

because it does not parse bracketed IPv6 authorities correctly.

Use a proper URL/authority parser or a small strict parser that recognises only expected forms.

Suggested accepted forms:

```text
localhost
localhost:<port>
127.0.0.1
127.0.0.1:<port>
[::1]
[::1]:<port>
```

Decide explicitly whether other loopback IPv4 addresses such as `127.0.0.2` should be accepted. A strict allowlist is preferable unless there is a requirement for them.

Do not accept an arbitrary hostname merely because DNS currently resolves it to loopback. That would reintroduce the rebinding problem.

## Defence in depth

Consider rejecting cross-site browser requests based on Fetch Metadata:

```text
Sec-Fetch-Site: cross-site
```

This is supplementary. Do not replace Host validation with Fetch Metadata because non-browser clients may omit these headers.

Consider adding:

```http
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

globally.

## Tests

At minimum:

```text
GET / with Host: attacker.invalid -> rejected
GET /api/project with Host: attacker.invalid -> rejected
GET /api/document?... with Host: attacker.invalid -> rejected
GET /asset/workspace/... with Host: attacker.invalid -> rejected
GET /api/chat/session with Host: attacker.invalid -> rejected

Host: localhost:<port> -> accepted
Host: 127.0.0.1:<port> -> accepted
Host: [::1]:<port> -> accepted if IPv6 operation is supported
```

The regression test should enumerate all registered routes if practical, so a new endpoint does not accidentally bypass the global check.

---

# SEC-04 — Do not serve active workspace content from the privileged origin

## Problem

SVG is classified as an image because MIME detection occurs before the code-extension classification.

The browser UI links image previews to the asset URL using `target="_blank"`.

A top-level SVG document can contain JavaScript. If the SVG is served from:

```text
http://localhost:<port>/asset/workspace/...
```

its script executes with the same origin as the Workbench application and can call the local API.

CSRF does not protect against script already running in the trusted origin.

## Immediate fix

Treat `.svg` as source text instead of a directly renderable image, or force it to download.

Preferred short-term behaviour:

```text
.svg -> text/source preview
```

Alternative:

```http
Content-Disposition: attachment
```

for SVG.

Do not rely on the fact that script normally does not execute when an SVG is embedded in `<img>`. The dangerous case is top-level navigation or another active embedding path.

## Preferred architectural fix

Split trusted application content from untrusted workspace content.

Example:

```text
http://localhost:3477
    application
    privileged API

http://localhost:3478
    untrusted workspace assets
    no privileged API
    strict CSP
```

If a separate origin is not practical, do not render active formats inline.

## Response policy for untrusted assets

Where applicable:

```http
Content-Security-Policy:
  default-src 'none';
  script-src 'none';
  object-src 'none';
  connect-src 'none';
  frame-ancestors 'none';
  sandbox

X-Content-Type-Options: nosniff
```

Be careful with `sandbox` and image/media compatibility. Test each supported document type.

## HTML and PDF

Audit any direct rendering or iframe behaviour for:

- HTML;
- SVG;
- XML/XHTML;
- PDF;
- other browser-active formats.

The earlier review did not establish a concrete exploitable PDF path, but an unsandboxed PDF iframe belongs in the same trust-boundary review.

## Tests

Create a malicious test SVG containing JavaScript that attempts to call an application API.

Acceptance criterion:

```text
Opening or previewing the workspace SVG cannot execute script with Workbench API authority.
```

Also test MIME confusion:

- file extension and MIME disagree;
- SVG renamed to another extension;
- XML-based active content;
- browser sniffing attempts.

---

# SEC-07 — Bound document and asset memory use

## Problem

The reviewed document path performs roughly:

```js
const stat = await fs.stat(target);
const buffer = await fs.readFile(target);
```

and applies some preview decisions after reading the complete file.

The asset path similarly buffers complete files before returning them.

A large file therefore becomes a server memory allocation before size policy is applied.

## Required invariant

> File size policy is checked before complete file allocation.

## Implementation

### Text/code/Markdown previews

1. `stat()` first.
2. Check file size against a configured maximum.
3. Read at most the allowed prefix.
4. Return metadata indicating truncation where appropriate.

Suggested limits should be constants and tested.

For example:

```js
MAX_MARKDOWN_PREVIEW_BYTES
MAX_CODE_PREVIEW_BYTES
MAX_TEXT_PREVIEW_BYTES
```

Do not choose values silently inside handlers.

### Media/assets

Use streams:

```js
fs.createReadStream(...)
```

instead of `fs.readFile()`.

Where useful, implement HTTP byte ranges for PDFs/video/audio.

Ensure stream errors are handled without leaving the response hanging.

### Classification

If classification needs magic bytes, read only a small fixed prefix rather than the whole file.

## Tests

- very large Markdown;
- very large code file;
- very large binary asset;
- repeated concurrent requests;
- truncated preview marker;
- streaming error behaviour.

A regression test should verify that a file above the preview threshold is not passed to `fs.readFile()` in full.

---

# SEC-10 — Correct IPv6 authority parsing

This should be fixed as part of SEC-01.

Tests must include:

```text
[::1]
[::1]:3477
```

If the server never binds IPv6, either:

- remove `::1` from the documented/implemented accepted authority set; or
- add explicit IPv6 listening support and test it.

Do not retain an allowlist entry that can never be parsed correctly.

---

# Completion criteria

This work is complete when:

- every route is behind global local-authority validation;
- DNS-rebinding-style Host headers are rejected before routing;
- malicious workspace SVG cannot run with application-origin authority;
- active content policy is explicit for SVG/HTML/PDF/XML;
- large files are capped or streamed before full allocation;
- IPv4 and IPv6 Host parsing has regression tests;
- security headers are applied consistently where useful.
