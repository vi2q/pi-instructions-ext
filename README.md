# pi-instructions-ext

A [pi](https://pi.dev) extension that keeps `docs/INSTRUCTIONS.md` as the standing record of your work instructions and their checklist state.

Every session, the agent is instructed to record your work instructions in `docs/INSTRUCTIONS.md` — the instruction itself, a checklist of the concrete steps, and their completion status as GFM checkboxes (`- [ ]` / `- [x]`). Items whose completion requires the user (behavior or visual checks, acceptance) are recorded as confirmation sub-items and verified through structured questions instead of being self-checked by the model. The file is ordinary markdown in your repository: you can read it, diff it, commit it, and start a fresh session pointing at it as a handoff document.

## Why

Session todo lists live and die inside the harness. This extension moves the record to a plain file in the repo instead:

- **Survives the session.** The checklist outlives compaction, `/new`, and the terminal window. A follow-up session can pick it up from the file.
- **Handoff-ready.** The markdown is directly usable as a handoff document for a new session or another person.
- **Auditable.** Instructions and their completion state are diffable in git, next to the code they produced.
- **Cache-friendly.** Context injection is minimal: one standing rule per session and a short reminder tag per turn. No structured state blocks are rewritten into the prompt each turn.

## Install

```bash
pi install git:github.com/vi2q/pi-instructions-ext
```

Or try it without installing:

```bash
pi -e git:github.com/vi2q/pi-instructions-ext
```

To scope it to one project, add the package to the project's `.pi/settings.json` instead of global settings (`pi install -l ...`).

## What it does

**On session start** (once per session), a standing rule is injected into context:

> Auto-message: Record the user's work instructions in docs/INSTRUCTIONS.md and keep the file up to date as work progresses. Record each new instruction before starting on it, and maintain and update the existing checklist as items are completed. Use GFM checkboxes ("- [ ]" / "- [x]") for checklist items. For items whose completion requires user confirmation (behavior or visual checks, acceptance), add a sub-item prefixed "Confirm (user):" and do not check it off yourself — the user confirms it. When your work on an instruction finishes, use the ask_user_question tool to ask the user about each such pending confirmation item …

Short acknowledgements like "yes" or "go ahead" are left out of the record by design; the model judges what counts as an instruction.

**User confirmation flow.** The model never self-checks items that need the user's eyes. When work finishes, it asks per-item structured questions via the `ask_user_question` tool ([@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-ask-user-question), or any equivalent tool) — with the concrete check described and OK / problem / later options — and reflects the answers in the file:

```markdown
- [ ] Add CSV export to the report page
  - [x] Implement the export button and file download
  - [x] Confirm (user): exported file opens and columns match the report — user-confirmed (2026-08-31)
  - [ ] Confirm (user): export works with 10k-row data — pending confirmation
```

If the `ask_user_question` tool is not installed, the flow degrades gracefully to plain-text questions.

**On every turn**, a short reminder rides along with your prompt:

> Auto-message: Please update docs/INSTRUCTIONS.md as needed.

The tag is hidden in the TUI by default. It is stored in the session file either way, so transcripts stay complete.

**`/instr-verify`** starts a verification walkthrough: a user message is injected asking the model to go through every item that needs user confirmation — one `ask_user_question` per item — and update the checklist from the answers. Use it when the model finished work without asking, or to re-verify deferred items. Nothing is marked confirmed without an explicit user answer.

**Parallel sessions.** The standing rule includes the session's owner tag (a short id derived from the pi session id, e.g. `(s01a0)`): the model tags every instruction it records with it, updates only items carrying its own tag, and re-reads the file before writing so parallel sessions merge instead of overwriting. On top of that convention, the extension watches the file's content between turns: if it changed on disk since the agent last touched it (another session, or a manual edit), the per-turn reminder switches to a staleness warning telling the model to re-read and merge. The agent's own writes never trigger the warning.

**`/instr-tidy`** deterministically normalizes the file: checkbox syntax (`* [X]`, `-[x]` → `- [x]`), indentation (2 spaces per nesting level), and `Confirm (user):` prefixes on sub-items, then moves unchecked items to the top of each section (checked items keep their order at the bottom). Lines the parser doesn't recognize pass through untouched; if no checklist items are found, nothing is written. A confirmation dialog shows the item count before anything changes.

**`/instr-archive`** moves completed top-level items (with their sub-items) from the active file to `docs/INSTRUCTIONS-archive.md` under a dated `## Archived …` heading, keeping the archive in a single searchable file. A section heading is dropped only when its section becomes completely empty. A confirmation dialog shows the item count first.

**`/instr clean`** clears the file after a confirmation dialog and writes a tombstone comment stating when and how it was cleared, so a later session doesn't mistake the empty file for lost work. If the repo is git-tracked, the tombstone points at history. `/instr` without a subcommand lists all of them.

## What it deliberately doesn't do

- The extension never rewrites `docs/INSTRUCTIONS.md` automatically. The file's format beyond the checkbox suggestion is up to the model, and you can edit the file freely at any time. The confirmation questions and checklist updates are done by the model; deterministic rewrites happen only inside the explicit commands (`/instr-tidy`, `/instr-archive`, `/instr clean`) and only after a confirmation dialog.
- No hard requirement on `@juicesharp/rpiv-ask-user-question`: if the tool is missing, questions fall back to plain text.
- No file is created until the model first records an instruction. Quiet sessions leave the repo untouched.
- There is no hard enforcement; the standing rule plus the per-turn tag keep the file current, and you remain the final gate.

## Requirements

- [pi](https://pi.dev)
- Git (to install the package and to get history pointers in tombstones)
