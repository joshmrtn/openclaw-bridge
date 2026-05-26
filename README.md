# openclaw-bridge

Bridging the gap between SillyTavern and OpenClaw.

## Install

When setup script is complete, installation will work like:
```
git clone https://github.com/joshmrtn/openclaw-bridge.git
./setup.sh
```

## Install for development
> [!IMPORTANT]  
> Use this workflow for active development. Do not rely on the ST plugin installer for a working tree that changes often.

If SillyTavern is checked out in this repo at `./sillytavern`, run:
```
bash ./dev-setup.sh
```

If ST lives somewhere else, point the script at it:
```
ST_DIR=/path/to/SillyTavern bash ./dev-setup.sh
```

The script symlinks `./st-plugin` into ST's `plugins/openclaw-bridge` directory. That means you can edit this repo, restart ST, and immediately test the new code without reinstalling the plugin from Git each time.

Run SillyTavern from the `./sillytavern` directory, not from the repo root. That keeps ST's active `config.yaml` inside the SillyTavern checkout instead of creating one at the bridge repo root.


## Status: Early Development

Testing note: the maintained Playwright suite covers the mocked plugin/extension contract and same-character serialization. The live Gemini-backed path is best kept as a gated smoke test that only runs when ST is already configured and the API key is present.

Planned repository layout:

```
openclaw-bridge/
├── README.md
├── setup.sh              # one-time setup: installs deps, symlinks plugin dirs
├── dev-setup.sh          # `git submodule update --init` update sillytavern submodule, runs npm install
├── start.sh              # launcher: checks Docker, starts OC + ST + bridge
├── characters.yaml       # her character registry (gitignored)
│
├── st-plugin/            # server plugin → symlinked into ST/plugins/
│   ├── package.json
│   ├── index.js
│   ├── generator.js
│   ├── character-loader.js
│   ├── session-manager.js
│   └── ws-server.js
│
├── st-extension/         # UI extension → symlinked into ST/.../third-party/
│   ├── manifest.json
│   ├── index.js
│   └── index.html
│
└── bridge/               # Python bridge — runs standalone
    ├── requirements.txt
    ├── bridge.py
    ├── adapters/
    │   ├── discord.py
    │   └── whatsapp.py   # future
    └── lib/
        ├── registry.py
        ├── queue_manager.py
        └── st_client.py
```
