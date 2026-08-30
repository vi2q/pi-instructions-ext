# pi-instructions-ext

A [pi](https://pi.dev) extension that keeps `docs/INSTRUCTIONS.md` as the standing record of your work instructions and their checklist state.

Every session, the agent is instructed to record your work instructions in `docs/INSTRUCTIONS.md` — the instruction itself, a checklist of the concrete steps, and their completion status as GFM checkboxes (`- [ ]` / `- [x]`). The file is ordinary markdown in your repository: you can read it, diff it, commit it, and start a fresh session pointing at it as a handoff document.

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

> Auto-message: Record the user's work instructions in docs/INSTRUCTIONS.md and keep the file up to date as work progresses. Record each new instruction before starting on it, and maintain and update the existing checklist as items are completed. Use GFM checkboxes ("- [ ]" / "- [x]") for checklist items. Pure acknowledgements ("yes", "continue", etc.) need not be recorded. Respond and record in the user's language.

Short acknowledgements like "yes" or "go ahead" are left out of the record by design; the model judges what counts as an instruction.

**On every turn**, a short reminder rides along with your prompt:

> Auto-message: Please update docs/INSTRUCTIONS.md as needed.

The tag is hidden in the TUI by default. It is stored in the session file either way, so transcripts stay complete.

**`/instr clean`** clears the file after a confirmation dialog and writes a tombstone comment stating when and how it was cleared, so a later session doesn't mistake the empty file for lost work. If the repo is git-tracked, the tombstone points at history.

## What it deliberately doesn't do

- The extension never parses or rewrites `docs/INSTRUCTIONS.md`. The file's format beyond the checkbox suggestion is up to the model, and you can edit the file freely at any time.
- No file is created until the model first records an instruction. Quiet sessions leave the repo untouched.
- There is no hard enforcement; the standing rule plus the per-turn tag keep the file current, and you remain the final gate.

## Requirements

- [pi](https://pi.dev)
- Git (to install the package and to get history pointers in tombstones)
