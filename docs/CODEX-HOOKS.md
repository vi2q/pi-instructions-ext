# Codex hooks reference

This document describes the repository-local Codex integration for the same TASKS/RULES workflow used by `pi-instructions-ext`.

## Configuration

Codex loads the project hook definition from:

```text
.codex/hooks.json
```

The configuration registers three synchronous command hooks:

```text
SessionStart       -> tasks_lifecycle.py
UserPromptSubmit   -> tasks_lifecycle.py
Stop               -> tasks_lifecycle.py
```

The command is resolved from the Git root so that Codex can start in a repository subdirectory without losing the hook script:

```sh
python3 "$(git rev-parse --show-toplevel)/.codex/hooks/tasks_lifecycle.py"
```

## Event mapping

| pi extension behavior | Codex hook implementation |
| --- | --- |
| `session_start` pointer | `SessionStart` for `startup`, `resume`, and `clear` |
| `before_agent_start` reminder | `UserPromptSubmit` |
| TASKS/RULES hash comparison | `UserPromptSubmit` compares the last saved snapshot with the current files |
| `turn_end` snapshot refresh | `Stop` |
| `session_compact` pointer | `SessionStart` with `source: compact` |
| `tasks_init` tool | `tasks_lifecycle.py --init` |
| `tasks_tidy` tool | `tasks_lifecycle.py --tidy` |
| `/tasks-archive` | `--archive`, with `--confirm` required to write |
| `/tasks-clear` | `--clear --confirm` |
| `/tasks-blocked` and `/tasks-completed` pickers | `--list-blocked` and `--list-completed` |
| `/tasks-verify` | Prompt guidance emitted when the user submits `/tasks-verify` |

The owner tag uses the first four characters of SHA-1 over the full Codex session id, matching the pi extension's current derivation. The hash snapshot includes both `docs/TASKS.md` and `docs/RULES.md`. A missing file is represented as `null`; creating a previously missing file is reported as a change, while deletion is not reported as a stale warning.

## Hook input and output

Each command receives one JSON object on stdin. The implementation uses:

- `cwd` to locate `docs/TASKS.md` and `docs/RULES.md`;
- `session_id` to isolate state between sessions;
- `hook_event_name` to select the event behavior;
- `source` on `SessionStart` to distinguish normal startup from compaction;
- `prompt` on `UserPromptSubmit` to provide guidance for `/tasks-*` requests.

For `SessionStart` and `UserPromptSubmit`, short plain-text stdout is added to Codex's developer context. The `Stop` hook intentionally produces no output. State files are kept below the system temporary directory and are keyed by the project path and session id.

## Trust and matching behavior

Codex requires non-managed hooks to be reviewed and trusted before execution. Trust is associated with the current hook definition, so changing `.codex/hooks.json` or the referenced command definition requires another review.

The repository uses a synchronous `UserPromptSubmit` hook because the reminder and stale warning must be available before the next model request. The hook does not use `async`, and it does not block prompts or rewrite tool calls.

The current implementation intentionally does not register `PreToolUse` or `PostToolUse` policies. The pi extension's workflow is advisory: it asks the model to maintain a Markdown record and leaves the user as the final gate. The Codex hook layer keeps that same boundary.

## Differences from pi

Codex hooks cannot add a custom tool or a pi TUI picker. The companion script provides explicit, non-interactive equivalents for file operations and item listing. User confirmation remains a conversation step; archive and clear additionally require `--confirm` on the command that performs the write.

The hook layer is therefore a project-local Codex adapter, not a replacement for the pi extension package. Keeping both filesets in the repository lets either harness use the same `docs/RULES.md` and `docs/TASKS.md` conventions.

## Official reference

See the [official Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks) for the current list of events, configuration locations, matcher rules, trust behavior, stdin schema, and stdout output contract.
