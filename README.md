# openclaw-bridge

Bridging the gap between SillyTavern and OpenClaw.

## Install

1. Clone the repository:

```bash
git clone https://github.com/joshmrtn/openclaw-bridge.git
cd openclaw-bridge
```

2. Run the setup script to wire the plugin into a local SillyTavern checkout,
   install plugin dependencies, and generate a bridge auth token:

```bash
./setup.sh
```

3. Follow `AGENT-SETUP.md` to install the `character-bridge` skill into
   an OpenClaw agent and configure `OPENCLAW_BRIDGE_URL` and
   `OPENCLAW_BRIDGE_TOKEN` in the agent's environment.

## Development workflow

If SillyTavern is checked out in this repo at `./sillytavern`, run:

```bash
bash ./dev-setup.sh
```

This will symlink `./st-plugin` into ST's plugins directory so you can
edit plugin code and test immediately by restarting SillyTavern.

## Status: Early Development

The Playwright test suite covers plugin/extension contracts and
character serialization. Run tests with `npm test` under `st-plugin`.

## Repository layout

```
openclaw-bridge/
├── README.md
├── setup.sh
├── dev-setup.sh
├── start.sh
├── AGENT-SETUP.md
├── skills/character-bridge/
│   ├── SKILL.md
│   └── README.md
├── st-plugin/
└── st-extension/
```
