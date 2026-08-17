# OK Workbench

OK Workbench keeps an LLM-assisted project workflow grounded in a local workspace bundle. The bundle contains structured project knowledge, a versioned workflow, templates, and default assistant instructions; the application and credentials stay outside it.

Core capabilities are document browsing, project-scoped chat, reviewable Git diffs, and Bubblewrap-isolated workspace tools on Linux. Browsing has no provider requirement. Mutation requires Bubblewrap and is deliberately unavailable when isolation cannot be established.

Install with `npm install --global ok-workbench`, initialize with `ok-workbench init ~/workspace --yes`, then serve using `ok-workbench serve --root ~/workspace`. See the [README](README.md) and [starter workflow](workflow/index.md).
