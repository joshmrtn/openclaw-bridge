# OpenClaw Bridge — Requirements
R1: Channel Communication
R1.1 A user message sent to a character's bot on any OC-supported channel (Discord, Telegram, etc.) must produce a response from that specific character — not from the base LLM, not from the OC agent, not from a different character.
R1.2 The response must be generated using the character's full SillyTavern context: character card, lorebook, active persona, author's notes, and chat history. Partial context is not acceptable.
R1.3 The system must support multiple characters simultaneously, each with their own channel presence (e.g. separate Discord bots). A message to Frog's bot must never produce a response in Toad's voice and vice versa.
R1.4 Channel messages must be processed without disrupting the user's active SillyTavern session. If she is chatting with Frog in ST's UI and a Discord message arrives for Toad, her active Frog session must remain exactly as it was — no page switches, no interruptions, no chat reloads.
R1.5 If no SillyTavern session is open at all (browser closed, ST running headless), the system must handle this gracefully — either queue the message and process it when a session opens, or return a configurable "unavailable" message to the channel. It must not respond as the ST Assistant or any default character.
R1.6 Response time must be bounded. If generation does not complete within a configurable timeout, the system returns a fallback message to the channel and logs the failure. It does not hang indefinitely.

R2: Character Fidelity
R2.1 The generated response must be indistinguishable in voice and personality from a response generated directly in SillyTavern's UI for the same character. If there is a detectable difference in character fidelity between a Discord response and a direct ST response, the requirement is not met.
R2.2 The system must not require the character to be the "active" character in ST's UI in order to generate a response. Generation must be possible for any character regardless of which character is currently open in the browser.
R2.3 The generation mechanism must not produce responses from the "SillyTavern Assistant" or any default/fallback character under any normal operating condition.

R3: Memory and Continuity
R3.1 Every inbound channel message and its response must be written to that character's SillyTavern chat history. After a Discord conversation, opening that character in ST must show the complete exchange as part of the chat record.
R3.2 Chat history writes must be atomic. A partial write (e.g. the user message was written but the response was not due to a crash) must not corrupt the chat file.
R3.3 History writes must not produce duplicate entries. If a write is retried, the result must be identical to a single successful write.
R3.4 Autonomous actions taken by the OC agent on a character's behalf (posting, creating content, scheduled tasks) must also be recorded in that character's ST chat history, clearly marked as autonomous actions.
R3.5 The chat history written by this system must be in a format fully compatible with ST's native JSONL format. Opening the character in ST must show the history correctly with no errors or malformed entries.

R4: Trust and Security
R4.1 The system must distinguish between the character's owner and other users on any channel. The owner's identity is configured per character and per platform (e.g. discord:USER_ID).
R4.2 Owner messages must be labeled structurally before reaching generation. The label must be injected by code, not inferred by the model.
R4.3 Guest messages must be labeled structurally before reaching generation. A guest must not be able to elevate their trust level to owner through any message content, regardless of what they write.
R4.4 Guest messages must never trigger outbound actions (posting to channels, scheduling tasks, modifying configuration). Only owner messages and autonomous scheduled sessions may trigger actions.
R4.5 The bridge auth token must never be stored in browser localStorage, browser sessionStorage, or any other client-side persistent storage. The extension must not hold the token.
R4.6 The plugin endpoints must reject requests without a valid Bearer token with HTTP 401. No endpoint may be accessible without authentication.
R4.7 OC agent tool policy must structurally deny exec, process, email, calendar, gateway reconfiguration, and cron creation. These denials must be enforced at the OC config layer, not solely by AGENTS.md instructions.

R5: Outbound Actions (Character → OC Body)
R5.1 A character in SillyTavern must be able to instruct the OC agent to perform an action on their behalf (e.g. post a message to Discord, write a file to their workspace).
R5.2 Outbound action requests must originate from the ST character's generation — either through ST's function calling system or through a mechanism triggered by the character's response.
R5.3 Every outbound action must be logged to ST chat history as an autonomous action entry (satisfying R3.4).
R5.4 Outbound actions triggered from a guest conversation must be blocked. Only owner-initiated or scheduled sessions may trigger outbound actions.
R5.5 The OC agent must confirm action completion back to the character's context in some form, so the character's memory reflects whether the action succeeded or failed.

R6: Channel Output Formatting
R6.1 Markup transformation must be toggleable per channel type. Some channels render markdown natively (Discord renders `*text*` as italics, which looks acceptable for action notation). Others do not (Telegram renders asterisks as literal characters, which is ugly). The default for each channel type should reflect how that channel actually renders markdown.
R6.2 When transformation is enabled for a channel, SillyTavern roleplay markup (asterisk action notation, e.g. *Frog claps his hands*) must be converted to natural prose or cleanly removed — not left as raw asterisks.
R6.3 The transformation must preserve semantic content. Removing action descriptions wholesale is not acceptable — the information they contain must be either converted to natural prose or consciously discarded with a documented rationale.
R6.4 Markdown elements that render correctly on the target platform may be preserved. Markdown that does not render (e.g. tables in Discord) must be converted or removed when transformation is enabled.

R7: Multi-Character Isolation
R7.1 Characters must be fully isolated at every layer: OC agent workspace, ST chat history, trust configuration, channel bindings, and session state.
R7.2 A message or action for one character must have zero effect on any other character's state, history, or channel presence.
R7.3 Concurrent messages for different characters must be processed independently and simultaneously without interference.
R7.4 Concurrent messages for the same character must be serialized — processed one at a time in arrival order. No message must be dropped or produce a corrupted response due to concurrency.

R8: Installation and Operation
R8.0 Platform support: macOS is the primary target platform. Linux (Ubuntu) is the secondary target and must be supported at parity. Windows support is planned but deferred to a post-release milestone; no Windows-specific work is required for v1.0. All shell scripts, setup tooling, and runtime behaviour must be verified on macOS and Linux before v1.0 ships.
R8.1 Installation on a supported platform (macOS, Ubuntu) must be completable by following setup.sh and README.md without requiring knowledge of Node.js, Python, or OC internals.
R8.2 Adding a new character must be completable entirely through SillyTavern's UI after initial setup. No terminal commands must be required for routine character management.
R8.3 ~~The system must start reliably via start.sh.~~ *Deleted — not applicable. start.sh originated as a launcher for a Python bridge process that was folded into the ST plugin. The bridge now starts automatically when ST loads the plugin; there is no separate process to launch. Health checks formerly in start.sh are covered by scripts/verify.sh.*
R8.4 The system must continue operating if SillyTavern is restarted. The OC agents and channel connections must reconnect or queue messages appropriately.
R8.5 The system must continue operating if the OC gateway is restarted. The ST plugin and extension must reconnect or handle the unavailability gracefully.

R9: Known Open Problems (Must Be Resolved Before v1.0)
These are requirements where the correct implementation is not yet determined. They are listed explicitly because they represent open technical risk.
R9.1 — Non-active character generation without UI disruption
The current implementation requires a character to be active in ST's UI to generate a response without producing incorrect output. Switching active characters disrupts the user's session. A solution must be found that:

Generates a correct, full-fidelity response for any character
Does not switch the active character in ST's UI
Does not interrupt an in-progress chat session
Does not produce responses from the wrong character or the ST Assistant

Candidate approaches to investigate:

Opening a character's chat in a background/hidden context without affecting the visible UI
Using ST's generateRaw() with a fully assembled prompt constructed from the character's data, bypassing the active character dependency
Running a second headless ST instance for background generation
Finding an ST internal API that accepts a character ID without requiring UI state change

This is the highest priority open problem. R2.2 and R2.3 cannot be met until R9.1 is resolved.

Status: Implemented. `generateForCharacter()` in `st-extension/index.js` passes `force_chid` to `Generate('quiet', ...)`, targeting a specific character by index regardless of which character is active in the ST UI. `characters.findIndex(c => c.name === characterName)` maps name to index. No UI state is changed during generation.

R9.2 — Headless operation
The extension runs in ST's browser UI. If the browser is closed, generation cannot occur. The system must define its behavior when no browser session is active:

Queue messages and process when a session opens (requires persistent queue)
Return a configurable unavailable message
Run ST in a headless browser (Playwright/Puppeteer) for background generation

The chosen approach must be documented and implemented. R1.5 depends on this.

Status: Implemented. `st-plugin/headless-service.js` launches a Chromium browser via Playwright on ST startup, loads ST in a background tab, and runs the extension there. The session manager always prefers the headless WS client over the user's browser tab. If the headless service is unavailable, generation falls back to HTTP polling (the extension polls `/http-message` and POSTs responses to `/http-response`). Set `OPENCLAW_BRIDGE_ENABLE_HEADLESS=false` to disable the headless service entirely.
R9.3 — OC agent must not be in the inbound message path
Spike result (2026-06-09): internal `message:received` hooks are additive — the OC agent LLM runs regardless of what the hook pushes to `event.messages`. There is no OC config option to force exclusive tool use. Typed plugin hooks with cancel/claim semantics are required.

The inbound message path must bypass the OC agent LLM entirely. The solution is an OC typed plugin hook using `before_dispatch`, which intercepts the message before agent routing and returns a synthetic reply, preventing the agent from running at all.

Implementation: an OC plugin (`oc-plugin/`) registers `before_dispatch`. When a message arrives for an agent that has an active linked ST character (per `character-links.json`), the plugin:
1. Intercepts the message by returning `{ handled: true, text }` — preventing agent routing and LLM invocation
2. Calls the ST plugin `/generate` endpoint and awaits the response
3. Returns the ST-generated response as a synthetic reply delivered to the channel
4. If ST is unavailable or generation fails, returns `undefined` — the agent handles it with its character-bridge skill as a fallback

Status: Implemented in `oc-plugin/src/index.ts`.

The OC agent LLM is only involved for outbound character actions (R5.x), where it receives instructions from ST and uses the character-bridge skill to act on them. Minimum model requirements for that surface are a separate concern documented under R5.x implementation.


R10: Autonomous Presence (Heartbeat)
The character must be able to maintain a persistent presence — acting on its own initiative on a schedule, not only in response to inbound messages. OC's scheduler is the clock; ST's generation pipeline is the brain; the existing outbound action tools (R5.x) are the hands.

R10.1 Each character link may be configured with a heartbeat schedule (e.g. "every 2 hours", "daily at 9am"). When the schedule fires, the OC plugin calls ST's /generate endpoint with an autonomous trigger — not a user message.
R10.2 The trigger payload must carry a clear signal that this is a scheduled wake, not an inbound user message. The character must be able to distinguish a heartbeat session from a conversation in its prompt context.
R10.3 Heartbeat sessions are autonomous: they may trigger outbound actions (R5.x) without an owner user_id present. Guest-message action blocking (R4.4, R5.4) must not apply to heartbeat sessions.
R10.4 If the character returns an empty response during a heartbeat, nothing is posted to any channel and no history entry is written. A non-empty response follows normal outbound delivery and history rules.
R10.5 The most recent N messages of the character's chat history must be injected into the heartbeat context so the character has a sense of recent events when it wakes. N is configurable; default is enough to cover roughly the last day of conversation.
R10.6 Heartbeat activity must be logged to ST chat history as an autonomous action entry (satisfying R3.4), including what the character said and which actions it took.
R10.7 A second heartbeat trigger — conversation idle detection — must fire when a conversation goes quiet after an active exchange (configurable threshold, default 2 hours of no messages). This lets the character summarize what just happened while the context is still fresh, rather than waiting for the next scheduled interval.

Design note: Do not use OC's built-in agent heartbeat mechanism (heartbeat_prompt_contribution hook) — that still runs the OC agent LLM, which conflicts with R9.3. The OC plugin must schedule and execute the heartbeat call directly, bypassing the agent entirely.

R11: Character Memory Management
Characters must be able to create and maintain their own persistent memories. The goal is a character that accumulates knowledge over time — facts about users, decisions it has made, summaries of past conversations — without the owner having to manage any of it manually.

Two tiers of lorebook memory are supported, plus a secondary file-based store:

Core facts entry (always-active, Tier 1): A single designated lorebook entry per character that is always injected regardless of keywords. Contains the character's current model of its world — facts about users, key relationship details, standing decisions. Updated deliberately when new information is learned, not frequently. Because it changes slowly, it sits stably in the LLM's prompt cache prefix and has minimal cost impact.

Event memories (keyword-triggered, Tier 2): Specific episodes and context — "the conversation about the bridge project", "when Josh was frustrated with the deploy". These only fire when their keywords appear in context, making them lower-cost than always-active entries.

File memory (secondary): Files written to the OC workspace via the existing file_write action (R5.x). Useful for content too large or irregular for lorebook entries, or for a scratchpad that spans multiple characters.

R11.1 A character must be able to write or update a lorebook memory entry during generation by calling a memory tool. The tool takes an entry_key to target a specific named entry. The entry persists immediately and is available for subsequent generations.
R11.2 Memory writes must update existing entries in place, not append new ones. A write to an existing entry_key replaces its content. This prevents lorebook bloat and keeps the prompt prefix stable — a character that appends a new entry every session will degrade its own cache hit rate.
R11.3 A character must not be able to modify lorebook entries not created by the memory tool (author-written entries). Auto-written entries are identified by a consistent namespace prefix (e.g. [auto-memory]) and a programmatic marker field in the lorebook entry metadata.
R11.4 The Tier 1 always-active entry must be designated as such at creation time and must not require keyword matches to inject. One always-active entry per character is the intended design; additional always-active entries should be strongly discouraged to contain cost.
R11.5 During a heartbeat or idle-detection session (R10), a character must be able to summarize recent chat history and write the summary as a memory entry, compressing old context into persistent knowledge rather than losing it to context pruning.
R11.6 The memory write mechanism must work in both connected (extension live) and headless operation. In headless mode, the OC plugin calls a dedicated ST plugin endpoint to write the lorebook entry directly to the lorebook file.
R11.7 File memory: the existing file_write and file_read (R5.x) actions satisfy the secondary store requirement. No additional mechanism is needed for files.

Status: Implemented. `write_memory` is defined in `shared/tool-defs.js` as an ST-side tool (`ST_SIDE_TOOL_DEFS`). On the ST UI path, the browser extension registers it via `registerFunctionTool()`; the character's response may call it and the result is returned as a `st_side_action`. On the OC path, `<action>` blocks are parsed from generated text using the same injection/parsing treatment as R5; `write_memory` actions are classified as ST-side and routed to the plugin rather than returned to OC. In both cases, the ST plugin processes the write synchronously via `lorebook.upsertMemoryEntry()` before returning its response, satisfying R11.6. `lorebook.js` enforces the `[auto-memory]` namespace (R11.3), handles tier 1/2 designation (R11.4), and updates entries in place rather than appending (R11.2).

Design note — lorebook write path: Writing a lorebook entry during generation is most naturally done from within the browser extension (direct access to SillyTavern.getContext() world_info APIs). The extension queues the write as a st_side action; unlike outbound channel actions, st_side actions are executed by the ST plugin before the response is returned to the OC plugin, so the entry is persisted synchronously as part of the same generation cycle.

Design note — core facts entry format: The recommended format for the Tier 1 always-active entry is one subject per line, with facts as a short comma-separated list. This is terse enough for context efficiency, natural enough that the LLM writes and reads it reliably, and easy to update in place without a parser:

  Josh: software engineer, working on openclaw-bridge, has a goose t-shirt, likes frogs and toads
  Last active: 2026-06-11

Structured triple formats (entity-relationship-entity) were considered and rejected: they require a collation pipeline to produce readable output and LLMs reliably drift from strict format constraints over time. The per-subject line format achieves comparable terseness without any parsing infrastructure. If the memory system grows to require cross-character aggregation or programmatic querying, revisiting a structured format would make sense at that point.

Out of Scope for v1.0
These are explicitly deferred:

WhatsApp support (scaffold exists, not implemented)
Matrix/Element support
Character-to-character communication (multiple characters in one conversation)
Web UI for OC configuration (terminal + ST UI is sufficient for v1)