# Public release audit

Audited 2026-08-17 against the release acceptance criteria.

## Verified in this checkout

- [x] Application source is under `src/`; `npm run build` recreates ignored `dist/`.
- [x] The package has a CLI, explicit npm files allowlist, Node `>=22.19.0`, clean tarball content checks, and a clean-install/init smoke gate.
- [x] `init` is non-destructive, rejects dangerous and symlinked targets, supports explicit Git initialization, and reports merge conflicts.
- [x] The packaged seed contains an OKF 0.2 root, default instructions, workflow, templates, valid example project, hashes, and link/manifest validation.
- [x] Workspace root, state, application install, legacy migration, and `/agents/` compatibility are separate.
- [x] Docs, license, NOTICE, contribution/support/security/release/threat-model material, Linux CI, Pages workflow, SBOM, package audit, and test coverage are present.
- [x] Tests cover seed initialization, root selection, worker containment, served symlinks, scoped Git review/revert, and fake-provider chat streaming.

## Not proven or not deliverable from this checkout

- [!] **Public Git history and repository:** this directory is a subdirectory of `/home/ed/agents`, whose configured origin is an internal SSH remote. It must be extracted into a clean standalone public repository after a history and content review; publishing the current parent history would violate the plan's isolation requirement.
- [!] **Publication:** the approved identity is `ok-workbench` at the intended `edoloughlin/ok-workbench` repository, but the repository security contact and trademark/domain review still need completion. See [NAME-REVIEW.md](NAME-REVIEW.md).
- [!] **Private workflow/template inventory:** no existing deployable private workflow/template collection was available in this checkout. The included seed is intentionally minimal and original; it cannot substitute for a reviewed owner-provided collection.
- [!] **Release-host verification:** GitHub Pages/Actions and npm publication cannot be verified until the public repository and publisher exist.
- [!] **Security acceptance:** Bubblewrap is tested for presence and the worker fails closed, but host-specific user namespaces, cgroup supervision, full TOCTOU adversarial testing, and a formal external threat/security review remain release gates.

These blockers are material. Do not label a public 1.0.0 release complete until each is resolved with evidence in the designated public repository.
