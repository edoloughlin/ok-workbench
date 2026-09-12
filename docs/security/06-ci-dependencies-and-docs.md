# CI, Dependency and Security Documentation Hardening

Covers:

- SEC-09 — GitHub Actions supply-chain hardening;
- SEC-12 — documentation mismatch;
- additional dependency hygiene.

Primary code areas: `.github/workflows/*.yml`, `SECURITY.md`, `docs/THREAT-MODEL.md`, README/security sections.

---

# GitHub Actions permissions

Set explicit least-privilege permissions at workflow or job level.

For ordinary CI:

```yaml
permissions:
  contents: read
```

Grant additional permissions only to jobs that require them.

Do not rely on repository defaults.

---

# Pin actions by full commit SHA

Current major-version tags such as:

```yaml
actions/checkout@v4
actions/setup-node@v4
anchore/sbom-action@v0
```

are mutable references.

Pin each action to a reviewed full commit SHA.

Keep a comment with the human-readable version:

```yaml
- uses: actions/checkout@<full-sha> # v4.x.x
```

Use a dependency-update service or scheduled maintenance process to update these pins.

Third-party actions deserve particular attention.

---

# Dependency checks

Retain:

```bash
npm ci
npm audit --omit=dev
```

and SBOM generation.

Also consider:

```text
CodeQL
Dependabot/Renovate
lockfile review
licence policy if relevant
```

Do not treat `npm audit` as proof that the dependency tree is secure. It is one signal.

Before release, document any ignored vulnerability with:

```text
package
advisory
affected path
why not exploitable / accepted risk
planned resolution
review date
```

---

# Pi coding-agent dependency

The earlier review did not identify a known direct vulnerability in the declared current Pi coding-agent version.

Still:

- keep the version pinned through the lockfile;
- review new versions before upgrade;
- retain Workbench's explicit disabling of Pi extensions/skills/templates/themes/context features unless each capability is deliberately brought into the threat model.

Do not assume a CLI agent framework's default trust model is appropriate for an embedded application.

---

# Mermaid

Retain the stricter rendering configuration:

```text
securityLevel: strict
htmlLabels: false
```

Add a regression test if possible so a future refactor does not silently weaken it.

Treat diagram input as untrusted.

---

# Python package execution

If `run_python` permits package names without fixed versions, consider changing the package allowlist into a version map.

Example:

```json
{
  "numpy": "2.3.2",
  "pandas": "2.3.1"
}
```

For higher assurance, store package hashes or use an internal package cache.

This is lower priority than the capability and browser-origin issues.

---

# Security documentation

The security documentation must describe the same model as the code.

Resolve the current inconsistency between statements equivalent to:

```text
no security boundary without Bubblewrap
```

and documentation/code that treats macOS Seatbelt as a real, although weaker, isolation layer.

Use explicit language.

Suggested structure:

## Linux

```text
Bubblewrap is an enforced sandbox boundary for filesystem namespaces and default network isolation, subject to the privileges explicitly mounted/injected by Workbench and to kernel/Bubblewrap vulnerabilities.
```

## macOS

```text
Seatbelt/sandbox-exec applies an OS sandbox policy but provides different and generally weaker guarantees than the Linux Bubblewrap configuration. Document the exact policy and known limitations.
```

## Unsupported/no-sandbox platforms

```text
If neither supported sandbox is available, workspace-tool execution must fail closed unless the user deliberately opts into an explicitly unsafe development mode.
```

Do not silently run tools unsandboxed.

---

# Threat model updates

After the capability redesign, explicitly document these trust assumptions.

## Treat as untrusted

- workspace files;
- imported projects;
- `AGENTS.md`;
- Markdown;
- SVG/HTML/XML/PDF content;
- workspace tools;
- workspace tool manifests;
- model output;
- tool output.

## Trusted components

- Workbench application code;
- external approval/state store;
- OS sandbox implementation, within its documented guarantees;
- user actions that explicitly grant capabilities.

## Model compromise assumption

Assume prompt injection can fully control model tool choices.

Then state the desired property:

> A compromised model can misuse capabilities already granted to the current turn but cannot enlarge its own authority.

This should be the central agent-security statement.

---

# Release checklist

Before release:

```text
[ ] GitHub Actions permissions explicit
[ ] actions pinned to full SHAs
[ ] npm ci passes
[ ] production npm audit reviewed
[ ] SBOM generated
[ ] CodeQL or equivalent static analysis reviewed
[ ] Linux sandbox tests pass
[ ] macOS sandbox tests pass
[ ] documentation matches actual platform guarantees
[ ] unsafe/no-sandbox behaviour fails closed
[ ] threat model includes prompt-injected model assumption
```
