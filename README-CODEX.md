# Using pi-instructions-ext with Codex

This repository includes a Codex App hook layer that keeps the same durable work record used by the pi extension:

- `docs/RULES.md` contains the recording rules.
- `docs/TASKS.md` contains instructions and GFM checklist state.
- changes that need the user's eyes stay pending until the user confirms them.
- parallel sessions use a short owner tag and re-read the file before merging updates.

The pi extension source is unchanged. The Codex integration lives under `.codex/`.

## Quick start

Open this repository in Codex App. Codex discovers the repository-local hook definition at `.codex/hooks.json`. On first use, open the hooks review UI and trust the hook definition before expecting it to run. Codex records trust for the current hook definition, so review is required again after the definition changes.

If the project does not have the two record files yet, run:

```sh
python3 .codex/hooks/tasks_lifecycle.py --init
```

Then read `docs/RULES.md` before recording work. `--init` creates only missing files and never overwrites an existing `TASKS.md` or `RULES.md`.

## What the hooks do

| Codex event | Behavior |
| --- | --- |
| `SessionStart` (`startup`, `resume`, `clear`) | Points Codex at `docs/RULES.md`, supplies a per-session owner tag, and records the initial file hashes. |
| `SessionStart` (`compact`) | Tells Codex to re-read `docs/TASKS.md` before changing the checklist. |
| `UserPromptSubmit` | Adds the short TASKS reminder. If either file changed since the previous turn, emits a one-shot warning; a RULES change takes priority over a TASKS change. |
| `Stop` | Refreshes the file-hash baseline so writes made by Codex during the turn are not reported as external edits on the next turn. |

The hook receives Codex's JSON event on stdin and writes short developer context to stdout. Hook state is stored under the system temporary directory, not in the repository.

## Command equivalents

Codex hooks cannot register pi-style custom tools or interactive TUI commands. The same deterministic file operations are available as explicit commands through the companion script:

| Operation | Command |
| --- | --- |
| Initialize missing files | `python3 .codex/hooks/tasks_lifecycle.py --init` |
| Normalize checklist syntax and indentation | `python3 .codex/hooks/tasks_lifecycle.py --tidy` |
| List unfinished, pending-confirmation, and needs-fix items | `python3 .codex/hooks/tasks_lifecycle.py --list-blocked` |
| List checked items for re-check requests | `python3 .codex/hooks/tasks_lifecycle.py --list-completed` |
| Preview completed-item archive | `python3 .codex/hooks/tasks_lifecycle.py --archive` |
| Write the archive after confirmation | `python3 .codex/hooks/tasks_lifecycle.py --archive --confirm` |
| Clear and re-initialize after confirmation | `python3 .codex/hooks/tasks_lifecycle.py --clear --confirm` |

Archive previews the items before writing. Clear refuses to write until `--confirm` is supplied after the destructive action has been confirmed.

`/tasks-verify` remains prompt-driven in Codex. Ask one concrete question for each pending user confirmation and update the checklist only from explicit answers. If the current Codex environment provides an ask-user tool, use it; otherwise ask in plain text.

The two pi picker commands have no direct Codex UI equivalent. `--list-blocked` and `--list-completed` print quoted item references that can be pasted into the next prompt.

## Files to review

- [`.codex/hooks.json`](.codex/hooks.json) — lifecycle event registration and command paths.
- [`.codex/hooks/tasks_lifecycle.py`](.codex/hooks/tasks_lifecycle.py) — hook behavior and explicit command equivalents.
- [`docs/CODEX-HOOKS.md`](docs/CODEX-HOOKS.md) — implementation reference and mapping to pi behavior.
- [`docs/RULES.md`](docs/RULES.md) — project-specific recording rules, generated when needed.

## Trust and limitations

Repository-local hooks are not an enforcement boundary until they have been reviewed and trusted in Codex. The hook is designed to add context and detect stale files; it does not prevent a model or user from editing `docs/TASKS.md` outside the conventions.

The hook definition uses `git rev-parse --show-toplevel` to resolve the script path, so the project must be opened as a Git repository. The task files themselves can remain local according to the project's `.gitignore` policy.

See the [official Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks) for the current event schema, trust flow, output contract, and supported hook locations.
