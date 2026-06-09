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
R6.1 Responses sent to external channels must be formatted appropriately for that channel. SillyTavern roleplay markup (asterisk action notation, e.g. *Frog claps his hands*) must be converted to natural prose or removed before being posted to Discord or Telegram.
R6.2 The formatting transformation must preserve semantic content. Removing action descriptions wholesale is not acceptable — the information they contain must be either converted to natural prose or consciously discarded with a documented rationale.
R6.3 Channel-specific formatting must be configurable per channel type. Discord and Telegram may have different formatting rules.
R6.4 Markdown elements that render correctly on the target platform may be preserved. Markdown that does not render (e.g. tables in Discord) must be converted or removed.

R7: Multi-Character Isolation
R7.1 Characters must be fully isolated at every layer: OC agent workspace, ST chat history, trust configuration, channel bindings, and session state.
R7.2 A message or action for one character must have zero effect on any other character's state, history, or channel presence.
R7.3 Concurrent messages for different characters must be processed independently and simultaneously without interference.
R7.4 Concurrent messages for the same character must be serialized — processed one at a time in arrival order. No message must be dropped or produce a corrupted response due to concurrency.

R8: Installation and Operation
R8.1 Installation on a supported platform (macOS, Ubuntu) must be completable by following setup.sh and README.md without requiring knowledge of Node.js, Python, or OC internals.
R8.2 Adding a new character must be completable entirely through SillyTavern's UI after initial setup. No terminal commands must be required for routine character management.
R8.3 The system must start reliably via start.sh. If a required dependency (Docker, OC gateway) is not running, the script must produce a clear error message identifying what is missing rather than failing silently.
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
R9.2 — Headless operation
The extension runs in ST's browser UI. If the browser is closed, generation cannot occur. The system must define its behavior when no browser session is active:

Queue messages and process when a session opens (requires persistent queue)
Return a configurable unavailable message
Run ST in a headless browser (Playwright/Puppeteer) for background generation

The chosen approach must be documented and implemented. R1.5 depends on this.
R9.3 — Small model tool calling reliability
OC agents using small local models (sub-7B parameters) may not reliably use the generate_response tool and instead respond directly. The system must either:

Document minimum model requirements clearly
Implement a fallback detection mechanism (detect direct responses and re-route)
Or find an OC configuration that enforces tool use structurally rather than relying on model behavior


Out of Scope for v1.0
These are explicitly deferred:

WhatsApp support (scaffold exists, not implemented)
Matrix/Element support
Obsidian workspace integration
Character-to-character communication (multiple characters in one conversation)
Web UI for OC configuration (terminal + ST UI is sufficient for v1)
Automated nightly summarization (manual sync acceptable for v1)