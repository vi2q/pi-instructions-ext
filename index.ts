/**
 * instructions-ext — keep docs/INSTRUCTIONS.md as the standing record of
 * work instructions and their checklist state.
 *
 * - session_start: inject the standing rule once per session (deduped across /reload, /resume, /fork)
 * - before_agent_start: append a short per-turn reminder tag (identical string every turn)
 * - /instr clean: clear the file after confirmation and leave a tombstone note
 *
 * The extension never parses or rewrites the file except in /instr clean;
 * format is up to the model (GFM checkboxes are suggested in the injected rule).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Configuration -----------------------------------------------------------

const INSTRUCTIONS_PATH = "docs/INSTRUCTIONS.md";

const TAG = "Auto-message: Please update docs/INSTRUCTIONS.md as needed.";

/** Show the per-turn tag in the TUI. Hidden by default; still stored in the session file. */
const TAG_DISPLAY = false;

// -----------------------------------------------------------------------------

const INIT_CUSTOM_TYPE = "instructions-ext:init";
const TAG_CUSTOM_TYPE = "instructions-ext:auto-tag";

const INIT_MESSAGE =
	`Auto-message: Record the user's work instructions in ${INSTRUCTIONS_PATH} and keep the file up to date as work progresses. ` +
	`Record each new instruction before starting on it, and maintain and update the existing checklist as items are completed. ` +
	`Use GFM checkboxes ("- [ ]" / "- [x]") for checklist items. ` +
	`Pure acknowledgements ("yes", "continue", etc.) need not be recorded. ` +
	`When the repository is git-tracked, suggest committing ${INSTRUCTIONS_PATH} whenever instructions are added or completed. ` +
	`Respond and record in the user's language.`;

/**
 * If the instructions file exists but is not yet tracked by git, return a
 * nudge sentence appended to the standing rule. The record only becomes
 * durable once it's in history, so untracked files deserve a one-time hint.
 */
function gitNudge(cwd: string): string {
	if (!existsSync(join(cwd, ".git"))) return "";
	try {
		const status = execSync(`git status --porcelain -- "${INSTRUCTIONS_PATH}"`, {
			cwd,
			stdio: "pipe",
		})
			.toString()
			.trim();
		if (status === "") return "";
		return ` ${INSTRUCTIONS_PATH} is not committed to git yet — suggest the user commit it so the record stays in history.`;
	} catch {
		// git unavailable or not a repo — skip the nudge
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	// One-time injection of the standing rule. session_start re-fires on
	// /reload, /resume, and /fork — dedup by scanning for our custom message.
	pi.on("session_start", async (_event, ctx) => {
		const alreadyInjected = ctx.sessionManager
			.getEntries()
			.some(
				(e) => e.type === "custom_message" && e.customType === INIT_CUSTOM_TYPE,
			);
		if (alreadyInjected) return;

		pi.sendMessage({
			customType: INIT_CUSTOM_TYPE,
			content: INIT_MESSAGE + gitNudge(ctx.cwd),
			display: true,
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Instructions mode: ${INSTRUCTIONS_PATH}`, "info");
		}
	});

	// Per-turn reminder. Returned as a custom message riding next to the user's
	// prompt; identical text every turn, so provider prompt caches stay valid.
	pi.on("before_agent_start", async (_event, _ctx) => {
		return {
			message: {
				customType: TAG_CUSTOM_TYPE,
				content: TAG,
				display: TAG_DISPLAY,
			},
		};
	});

	// /instr clean — clear the file and write a tombstone note.
	pi.registerCommand("instr", {
		description: `Manage ${INSTRUCTIONS_PATH} (usage: /instr clean)`,
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub !== "clean") {
				ctx.ui.notify(
					`Usage: /instr clean — clears ${INSTRUCTIONS_PATH} and writes a tombstone note.`,
					"info",
				);
				return;
			}

			const file = join(ctx.cwd, INSTRUCTIONS_PATH);
			if (!existsSync(file)) {
				ctx.ui.notify(`${INSTRUCTIONS_PATH} does not exist.`, "warning");
				return;
			}

			const current = readFileSync(file, "utf8");
			if (current.trim() === "") {
				ctx.ui.notify(`${INSTRUCTIONS_PATH} is already empty.`, "info");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}

			const ok = await ctx.ui.confirm(
				"Clear instructions?",
				`${INSTRUCTIONS_PATH} will be cleared and a tombstone note written. This cannot be undone (see git history if tracked).`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			const now = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
			const gitLine = existsSync(join(ctx.cwd, ".git"))
				? " See git history if this file is tracked."
				: "";
			const tombstone =
				`<!-- Cleared via /instr clean on ${stamp}. ` +
				`Previous contents were intentionally removed by the user. ` +
				`Do not reconstruct them from memory.${gitLine} -->\n`;

			writeFileSync(file, tombstone, "utf8");
			ctx.ui.notify(`${INSTRUCTIONS_PATH} cleared.`, "info");
		},
	});
}
