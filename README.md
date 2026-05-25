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
> Only necessary for development or contributors.

Clone with `recurse-submodules`:
```
git clone --recurse-submodules git@github.com:joshmrtn/openclaw-bridge.git
./dev-setup.sh
```
This clones SillyTavern into a subdirectory for development purposes. `dev-setup.sh` sets up the development environment with SillyTavern. 


## Status: Early Development

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
