# Contributing

Thanks for your interest. This is a small personal project, but pull requests and issues are welcome.

---

## Before you open a PR

- Check the open issues first — your idea may already be tracked.
- For anything beyond a small bug fix, open an issue first so we can discuss the approach before you write code.
- Read [Development](docs/development.md) to understand the architecture constraints (especially why generation must stay in the browser and why trust labels must be code-enforced).

---

## Development setup

```bash
git clone --recurse-submodules https://github.com/joshmrtn/openclaw-bridge.git
cd openclaw-bridge
npm install
bash ./dev-setup.sh
```

See [Development](docs/development.md) for the full workflow.

---

## Running tests

```bash
# Unit tests (no ST required)
OPENCLAW_BRIDGE_ENABLE_HEADLESS=false npm test -- --forceExit

# E2E tests (requires ST running)
npm run test:e2e
```

All tests must pass before a PR will be reviewed.

---

## Pull request guidelines

- Keep PRs focused — one thing per PR.
- Match the existing code style. There is no linter config; just keep it consistent with what's already there.
- Tests: unit-test new route handlers and state logic. Browser-side changes (extension) are tested manually via `fake-extension.js` and `mock-openclaw.js`.
- Do not add comments that explain *what* the code does. Only add comments for non-obvious *why* — hidden constraints, workarounds, subtle invariants.
- Do not modify anything under `sillytavern/` — that is a vendor submodule.

---

## Reporting bugs

Open an issue with:
- What you expected to happen
- What actually happened
- The relevant section of the ST server log
- Your setup: OS, Node.js version, ST version, OC version

---

## Security issues

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not open a public issue for security bugs.
