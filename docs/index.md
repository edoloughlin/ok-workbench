# OK Workbench

OK Workbench is a local, multi-project knowledge base where an AI manages the files: it keeps project status, logs, and todos current and uses OKF structure to keep related documents consistent. Read the full [overview](OVERVIEW.md) for the design goals and feature tour.

OK Workbench keeps an LLM-assisted project workflow grounded in a local workspace bundle. The bundle contains structured project knowledge, a versioned workflow, templates, and default assistant instructions; the application and credentials stay outside it.

Core capabilities are document browsing, project-scoped chat, reviewable Git diffs, and isolated workspace tools: Bubblewrap on Linux and Seatbelt through `sandbox-exec` on macOS. Browsing has no provider requirement. Mutation requires the platform sandbox and is deliberately unavailable when isolation cannot be established. See the [macOS sandbox guide](MACOS-SANDBOX.md) for the Seatbelt policy and limits.

Clone the repository, run `npm ci`, `npm run build`, and `npm install --global .`, then initialize with `ok-workbench init ~/workspace --yes` and serve using `ok-workbench serve --root ~/workspace`. See the [README](README.md) and [starter workflow](workflow/index.md).
