# Getting started

This guide walks through installing openclaw-bridge for the first time. By the end you will have the plugin and extension running inside SillyTavern and the OC gateway plugin loaded, ready to link your first character.

If you want to understand what each component is before installing, read [Architecture](architecture.md) first.

---

## Prerequisites

Before starting, ensure:

- **SillyTavern** is installed and you can open it in a browser (default: `http://localhost:8000`)
- **OpenClaw gateway** is installed and running — `openclaw health` returns ok
- **Node.js 22+** is available — `node -v` to check

> **Back up your ST data first.** Before installing any plugin, copy your `SillyTavern/data/` folder somewhere safe — it holds your character cards, chat histories, lorebooks, and settings. This is good practice for any ST plugin, not specific to openclaw-bridge.

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/joshmrtn/openclaw-bridge.git
cd openclaw-bridge
```

---

## Step 2 — Run setup

```bash
./setup.sh
```

This does five things:

1. Checks your Node.js and OpenClaw versions
2. Installs the plugin's npm dependencies
3. Copies the plugin and extension into your SillyTavern installation — it will find ST automatically, or ask you to confirm the path if it can't
4. Generates a bridge auth token saved to `data/openclaw-bridge/bridge-token.txt`
5. Installs the OC gateway plugin if the `openclaw` CLI is in your PATH

**If you know where SillyTavern is, skip the prompts:**

```bash
./setup.sh --st-path ~/SillyTavern
```

---

## Step 3 — Enable server plugins in SillyTavern

ST doesn't load server plugins by default — you need to turn this on once.

1. Open `SillyTavern/config.yaml` in a text editor
2. Find `enableServerPlugins` and set it to `true`
3. Save and close the file

---

## Step 4 — Restart SillyTavern

Stop SillyTavern and start it again. On startup it will load the bridge plugin and launch a background browser that handles message generation automatically — you don't need to keep a browser tab open for this to work.

---

## Step 5 — Open SillyTavern in your browser

Open or refresh SillyTavern in your browser. The bridge extension loads automatically.

---

## Step 6 — Apply the OpenClaw config

```bash
openclaw gateway restart
```

This picks up the gateway plugin that `setup.sh` installed.

---

## Step 7 — Run the health check

```bash
./scripts/verify.sh
```

This checks the full stack: plugin reachability, bridge token auth, background browser status, and character links. Fix any warnings before continuing.

To also verify a specific character link (once you have one):

```bash
./scripts/verify.sh --character "My Character"
```

If anything is red, see [Troubleshooting](troubleshooting.md).

---

## What's next

Add your first character: [Adding a character](adding-a-character.md)

---

## Uninstalling

```bash
./uninstall.sh
```

This removes the plugin and extension from ST, uninstalls the OC gateway plugin, and cleans up the data symlinks. It will ask whether to delete your bridge token and character links — the default is to keep them so a re-install picks up where you left off.

**Non-interactive:**

```bash
./uninstall.sh --st-path ~/SillyTavern --yes
```

**Also delete bridge data (token + character links):**

```bash
./uninstall.sh --st-path ~/SillyTavern --yes --delete-data
```

Restart SillyTavern after uninstalling to deactivate the plugin and extension.

> **What is NOT removed:** Character cards, ST's `config.yaml` and `settings.json`, and lorebook files. Only the files that `setup.sh` originally installed are touched.
