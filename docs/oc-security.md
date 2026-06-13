# OpenClaw security configuration

OpenClaw ships with essentially no restrictions. Out of the box, every agent can read and write any file your user account can access, execute arbitrary shell commands, browse the web, send email, and reconfigure OC itself. None of this requires deliberate action — it is all available on first run.

This guide covers how to lock down OC before connecting any character agents. It is not exhaustive: consult [OpenClaw's own security documentation](https://docs.openclaw.ai/security) for the full picture. What follows is specific to how openclaw-bridge uses OC and the threat model relevant to running AI companion characters.

---

## What openclaw-bridge agents actually need

A character agent doing its job needs exactly three things:

1. **Call the ST plugin** — HTTP POST to `http://localhost:8000` (handled by the character-bridge skill, not a general tool)
2. **Read workspace files** — `MEMORY.md`, skill definitions, etc.
3. **Write workspace files** — for memory and skill state

That is it. An agent that can also execute shell commands, browse the web, send email, or modify OC's configuration has far more power than it needs, and that excess power is a liability.

---

## The `profile: "minimal"` approach (what setup.sh configures)

openclaw-bridge uses OC's `profile` setting to enforce a tight tool baseline. In each agent's `openclaw.json` entry:

```json
{
  "id": "frog",
  "name": "Frog",
  "workspace": "~/.openclaw/workspace-frog",
  "skills": ["character-bridge"],
  "tools": {
    "profile": "minimal",
    "allow": ["read", "write"]
  }
}
```

`profile: "minimal"` gives the agent only `session_status` as its built-in tool set. This structurally denies exec, cron, browser, gateway, calendar, and email tools at the config layer — they cannot be granted back by a prompt or a skill.

`allow: ["read", "write"]` then adds workspace file access on top of the minimal baseline, which the character-bridge skill needs for memory.

The bridge's own `generate_response` and `log_action` tools are HTTP-defined skill tools, not built-in OC tools, so they are unaffected by the profile.

---

## Additional hardening layers

The minimal profile is the most important control. These layers add defence in depth.

### Deny exec explicitly

Even with a minimal profile, set an explicit exec deny as belt-and-suspenders:

```json
{
  "tools": {
    "deny": ["exec", "process", "sandbox_exec", "sandbox_process"],
    "exec": {
      "security": "deny"
    }
  }
}
```

Set this at the top-level `tools` key (applies globally) and additionally per-agent. The two code paths are slightly different and both should be set.

### Docker sandbox per agent

Docker sandboxing runs each agent in an isolated container where the host filesystem is not mounted. This is the hard enforcement layer — tool policy stops the capability at the OC level; Docker stops it at the OS level.

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": {
          "network": "bridge"
        }
      }
    }
  }
}
```

`mode: "all"` sandboxes everything. `scope: "agent"` gives each agent its own container — Frog cannot access Toad's workspace. `network: "bridge"` allows outbound HTTP (needed for the ST plugin call); use `"none"` to block networking entirely if you don't need it.

> **Note:** Do not use `network: "host"`. That gives the container the same network access as your host machine.

### Hard blocks in AGENTS.md

Tool policy is enforced by OC's runtime. What you write in the agent's instructions (AGENTS.md or the skill's system prompt) shapes whether the model even tries to use capabilities it technically has. Write prohibitions as direct statements, not soft guidelines:

```markdown
## Hard blocks

- You cannot execute shell commands.
- You cannot read files outside your workspace directory.
- You cannot write files outside your workspace directory.
- You cannot send emails or access calendar or contact data.
- You cannot modify OpenClaw configuration or create scheduled tasks.
- You cannot spawn sub-agents.
- If asked to do any of the above, refuse and log the attempt in your workspace.
```

"You cannot" is stronger than "you should not" — the latter implies exceptions might exist.

### Exec approval prompts (catch-all)

Even with exec denied, enable approval prompts globally as a last-resort safety net:

```json
{
  "tools": {
    "exec": {
      "security": "ask"
    }
  }
}
```

This pops up a confirmation if anything attempts execution, regardless of the deny policy. Redundant by design — the deny should stop execution attempts; the approval prompt is the catch if something slips through.

---

## What each character agent can and cannot do

| Capability | Allowed | How enforced |
|---|---|---|
| Call the ST plugin (`generate_response`, `log_action`) | ✅ | HTTP skill — unaffected by profile |
| Read workspace files | ✅ | `allow: ["read"]` |
| Write workspace files | ✅ | `allow: ["write"]` |
| Execute shell commands | ❌ | `profile: "minimal"` + explicit deny |
| Read host filesystem | ❌ | Docker sandbox (host not mounted) |
| Browse the web | ❌ | `profile: "minimal"` excludes browser |
| Send email | ❌ | `profile: "minimal"` excludes email |
| Access calendar / contacts | ❌ | `profile: "minimal"` excludes calendar |
| Reconfigure OpenClaw | ❌ | `profile: "minimal"` excludes gateway |
| Create cron jobs | ❌ | `profile: "minimal"` excludes cron |
| Spawn sub-agents | ❌ | `profile: "minimal"` excludes gateway |

---

## Known gap: no path-based filesystem restrictions in OC

OC's `read` and `write` tools do not currently support path-based access control. With `read` in the allow list, an agent can technically attempt to read any path accessible inside its container. In practice, Docker sandbox mode limits what paths are even available — the host filesystem is not mounted — but this relies on Docker isolation rather than OC's own controls.

Do not store sensitive files (SSH keys, API credentials, other characters' tokens) anywhere that could be mounted into an agent's sandbox. Keep them on the host, outside any OC workspace directory.

---

## Verifying the configuration

After setting this up, use OC's built-in tools to confirm restrictions are actually in effect:

```bash
openclaw doctor
openclaw sandbox explain --agent frog
```

`openclaw doctor` checks for common configuration problems. `openclaw sandbox explain` shows exactly which tools are available to a specific agent after all policy layers are resolved.

---

## Complete example: two-character setup

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "REPLACE_WITH_STRONG_RANDOM_TOKEN"
    }
  },

  "tools": {
    "deny": ["exec", "process", "sandbox_exec", "sandbox_process"],
    "exec": { "security": "deny" }
  },

  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "docker": { "network": "bridge" }
      }
    },
    "list": [
      {
        "id": "frog",
        "name": "Frog",
        "workspace": "~/.openclaw/workspace-frog",
        "skills": ["character-bridge"],
        "tools": {
          "profile": "minimal",
          "allow": ["read", "write"]
        },
        "env": {
          "OPENCLAW_BRIDGE_URL": "http://localhost:8000",
          "OPENCLAW_BRIDGE_TOKEN": "YOUR_BRIDGE_TOKEN"
        }
      },
      {
        "id": "toad",
        "name": "Toad",
        "workspace": "~/.openclaw/workspace-toad",
        "skills": ["character-bridge"],
        "tools": {
          "profile": "minimal",
          "allow": ["read", "write"]
        },
        "env": {
          "OPENCLAW_BRIDGE_URL": "http://localhost:8000",
          "OPENCLAW_BRIDGE_TOKEN": "YOUR_BRIDGE_TOKEN"
        }
      }
    ]
  }
}
```
