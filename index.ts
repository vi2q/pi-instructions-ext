/**
 * instructions-ext — keep docs/TASKS.md as the standing record of
 * work instructions and their checklist state.
 *
 * - session_start: inject the standing rule once per session (deduped across
 *   /reload, /resume, /fork), including the session's owner tag used for
 *   per-agent task boundaries in parallel sessions
 * - before_agent_start: append a short per-turn reminder tag (identical
 *   string every turn so provider prompt caches stay valid); switches to a
 *   staleness warning when the file changed on disk since the agent last
 *   touched it (a parallel session or a manual edit)
 * - turn_end: refresh the staleness snapshot so the agent's own writes don't
 *   trigger the warning
 * - /tasks-tidy command and tasks_tidy tool: deterministic formatting —
 *   normalize checkbox syntax and
 *   indentation, normalize "Confirm (user):" prefixes on sub-items, and move
 *   unchecked items to the top of each section (checked items keep their
 *   order at the bottom). Unrecognized lines pass through untouched; if no
 *   checklist items are found the file is left as is.
 * - /tasks-archive: move completed top-level items (with their sub-items) to
 *   docs/TASKS-archive.md under a dated heading
 * - /tasks-clear: clear the file after confirmation and leave a tombstone
 *
 * The extension never rewrites the file automatically; deterministic
 * rewrites happen only inside the explicit commands above.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// --- Configuration -----------------------------------------------------------

const TASKS_PATH = "docs/TASKS.md";
const ARCHIVE_PATH = "docs/TASKS-archive.md";

const TAG = "Auto-message: Please update docs/TASKS.md as needed.";

const TAG_STALE =
	`Auto-message: ${TASKS_PATH} has changed on disk since the agent last touched it — ` +
	`re-read it before updating (a parallel session or the user may have edited it). ` +
	`Merge the changes instead of overwriting them.`;

/** Show the per-turn tag in the TUI. Hidden by default; still stored in the session file. */
const TAG_DISPLAY = false;

const VERIFY_MESSAGE =
	`Auto-message: Walk through every item in ${TASKS_PATH} that needs user confirmation (sub-items marked "Confirm (user)", unfinished items whose completion condition is a user check such as behavior or visual verification, and any explicitly unfinished work). ` +
	`For each item, use the ask_user_question tool to ask the user in their language — one question per item, with the required check described concretely (e.g. what to run and what to look for) and options such as OK / problem / later. ` +
	`If the ask_user_question tool is unavailable, fall back to asking in plain text and waiting for the reply. ` +
	`Reflect each answer in the file immediately: mark confirmed items "[x]" with a "— user-confirmed (date)" note, record problem reports as "— needs-fix: <summary>", and keep deferred items unchecked with "— pending confirmation". ` +
	`Do not mark anything confirmed without an explicit user answer. When the repository is git-tracked, suggest committing the file afterwards.`;

// -----------------------------------------------------------------------------

const INIT_CUSTOM_TYPE = "instructions-ext:init";
const TAG_CUSTOM_TYPE = "instructions-ext:auto-tag";

function buildInitMessage(ownerShort: string): string {
	return (
		`Auto-message: Record the user's work instructions in ${TASKS_PATH} and keep the file up to date as work progresses. ` +
		`Record each new instruction before starting on it, and maintain and update the existing checklist as items are completed. ` +
		`Use GFM checkboxes ("- [ ]" / "- [x]") for checklist items. ` +
		`For items whose completion requires user confirmation (behavior or visual checks, acceptance), add a sub-item prefixed "Confirm (user):" and do not check it off yourself — the user confirms it. ` +
		`When your work on an instruction finishes, use the ask_user_question tool to ask the user about each such pending confirmation item (describe concretely what to check; options like OK / problem / later), and reflect the answers in the file: "[x]" plus "— user-confirmed (date)" when confirmed, "— needs-fix: <summary>" when a problem is reported, "— pending confirmation" when deferred. ` +
		`If ask_user_question is unavailable, ask in plain text instead. Never mark a user-confirmation item complete without an explicit user answer. ` +
		`Parallel-session rules: tag each top-level instruction you record with your session owner tag "(s${ownerShort})" and update only items carrying your own tag unless the user explicitly instructs otherwise; ` +
		`re-read ${TASKS_PATH} before updating it, since parallel sessions may have changed it — merge, don't overwrite. ` +
		`The tasks_tidy tool is available: after updating ${TASKS_PATH}, call it to normalize formatting (checkbox syntax, 2-space nesting, "Confirm (user):" prefixes) and keep unchecked items on top. ` +
		`Pure acknowledgements ("yes", "continue", etc.) need not be recorded. ` +
		`When the repository is git-tracked, suggest committing ${TASKS_PATH} whenever instructions are added or completed. ` +
		`Respond and record in the user's language.`
	);
}

// --- Staleness snapshot (parallel-session change detection) -------------------

interface FileSnapshot {
	mtimeMs: number;
	hash: string;
}

let lastKnown: FileSnapshot | null = null;

function snapshotFile(cwd: string): FileSnapshot | null {
	const file = join(cwd, TASKS_PATH);
	try {
		const st = statSync(file);
		const hash = createHash("sha1").update(readFileSync(file)).digest("hex");
		return { mtimeMs: st.mtimeMs, hash };
	} catch {
		return null;
	}
}

// --- Checklist parsing / formatting -------------------------------------------

const CHECKBOX_RE = /^([ \t]*)[-*+][ \t]*\[([ xX])\][ \t]*(.*)$/;
const CONFIRM_PREFIX_RE = /^confirm\s*\(\s*user\s*\)?\s*[:：\-—]*\s*/i;

interface ItemNode {
	level: number;
	checked: boolean;
	text: string;
	children: ItemNode[];
	/** Raw non-checkbox lines that follow this item (continuations, blank separators). */
	trailing: string[];
}

interface Section {
	/** Raw heading line, or null for the preamble before the first heading. */
	heading: string | null;
	/** Prose lines before the first checkbox item. */
	pre: string[];
	roots: ItemNode[];
}

function indentWidth(raw: string): number {
	let n = 0;
	for (const ch of raw) n += ch === "\t" ? 2 : 1;
	return n;
}

function parseDoc(text: string): Section[] {
	const sections: Section[] = [];
	let current: Section = { heading: null, pre: [], roots: [] };
	sections.push(current);
	let stack: ItemNode[] = [];

	for (const rawLine of text.split("\n")) {
		if (/^#{1,6} /.test(rawLine)) {
			current = { heading: rawLine, pre: [], roots: [] };
			sections.push(current);
			stack = [];
			continue;
		}
		const cb = rawLine.match(CHECKBOX_RE);
		if (cb) {
			const level = Math.floor(indentWidth(cb[1]) / 2);
			while (stack.length > 0 && stack[stack.length - 1].level >= level) {
				stack.pop();
			}
			const node: ItemNode = {
				level,
				checked: cb[2].toLowerCase() === "x",
				text: cb[3].trimEnd(),
				children: [],
				trailing: [],
			};
			if (stack.length > 0) stack[stack.length - 1].children.push(node);
			else current.roots.push(node);
			stack.push(node);
			continue;
		}
		// Non-checkbox line: attach to the innermost open item so it travels
		// with it; before any item in the section, it is leading prose.
		if (stack.length > 0) stack[stack.length - 1].trailing.push(rawLine);
		else if (current.roots.length > 0) {
			current.roots[current.roots.length - 1].trailing.push(rawLine);
		} else current.pre.push(rawLine);
	}
	return sections;
}

function countItems(sections: Section[]): number {
	let n = 0;
	const walk = (node: ItemNode) => {
		n++;
		node.children.forEach(walk);
	};
	for (const s of sections) s.roots.forEach(walk);
	return n;
}

function renderNode(node: ItemNode, depth: number, out: string[]): void {
	const pad = "  ".repeat(depth);
	let text = node.text;
	// Normalize "Confirm (user):" prefixes on sub-items (common variants).
	if (depth > 0 && CONFIRM_PREFIX_RE.test(text)) {
		text = text.replace(CONFIRM_PREFIX_RE, "Confirm (user): ");
	}
	out.push(`${pad}- ${node.checked ? "[x]" : "[ ]"} ${text}`.trimEnd());
	for (const line of node.trailing) out.push(line);
	for (const child of node.children) renderNode(child, depth + 1, out);
}

function serializeDoc(sections: Section[]): string {
	const out: string[] = [];
	for (const s of sections) {
		if (s.heading !== null) out.push(s.heading);
		for (const line of s.pre) out.push(line);
		for (const root of s.roots) renderNode(root, 0, out);
	}
	return out.join("\n");
}

/** Deterministic tidy: normalize structure, unchecked items first per section. */
function tidyDoc(sections: Section[]): string {
	const sorted: Section[] = sections.map((s) => ({
		...s,
		roots: [
			...s.roots.filter((r) => !r.checked),
			...s.roots.filter((r) => r.checked),
		],
	}));
	return serializeDoc(sorted);
}

function timestamp(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Move completed top-level items (with their sub-items) out of the sections.
 * Returns the remaining sections and the rendered text of moved items.
 * A heading is dropped only when its section becomes completely empty.
 */
function extractCompleted(sections: Section[]): {
	remaining: Section[];
	movedText: string;
	movedCount: number;
} {
	const remaining: Section[] = [];
	const moved: ItemNode[] = [];
	for (const s of sections) {
		const keep = s.roots.filter((r) => !r.checked);
		moved.push(...s.roots.filter((r) => r.checked));
		if (
			s.heading === null ||
			keep.length > 0 ||
			s.pre.some((l) => l.trim() !== "")
		) {
			remaining.push({ heading: s.heading, pre: s.pre, roots: keep });
		}
	}
	const out: string[] = [];
	for (const node of moved) renderNode(node, 0, out);
	return {
		remaining,
		movedText: out.join("\n"),
		movedCount: moved.length,
	};
}

// --- Tidy core (shared by /tasks-tidy command and the tasks_tidy tool) --------

interface TidyOutcome {
	status: "missing" | "no-items" | "unchanged" | "changed";
	items: number;
	/** The tidied text, when status is "changed". */
	tidied?: string;
}

function computeTidy(cwd: string): TidyOutcome {
	const file = join(cwd, TASKS_PATH);
	if (!existsSync(file)) return { status: "missing", items: 0 };
	const original = readFileSync(file, "utf8");
	const sections = parseDoc(original);
	const items = countItems(sections);
	if (items === 0) return { status: "no-items", items };
	const tidied = tidyDoc(sections);
	if (tidied === original) return { status: "unchanged", items };
	return { status: "changed", items, tidied };
}

function writeTidied(cwd: string, tidied: string): void {
	writeFileSync(join(cwd, TASKS_PATH), tidied, "utf8");
	lastKnown = snapshotFile(cwd);
}

// --- Owner tag ----------------------------------------------------------------

function ownerShort(ctx: {
	sessionManager: { getSessionId(): string };
}): string {
	try {
		return ctx.sessionManager.getSessionId().slice(0, 4);
	} catch {
		return "sess";
	}
}

// --- Git nudge ----------------------------------------------------------------

/**
 * If the instructions file exists but is not yet tracked by git, return a
 * nudge sentence appended to the standing rule. The record only becomes
 * durable once it's in history, so untracked files deserve a one-time hint.
 */
function gitNudge(cwd: string): string {
	if (!existsSync(join(cwd, ".git"))) return "";
	try {
		const status = execSync(`git status --porcelain -- "${TASKS_PATH}"`, {
			cwd,
			stdio: "pipe",
		})
			.toString()
			.trim();
		if (status === "") return "";
		return ` ${TASKS_PATH} is not committed to git yet — suggest the user commit it so the record stays in history.`;
	} catch {
		// git unavailable or not a repo — skip the nudge
		return "";
	}
}

// --- Extension ----------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// One-time injection of the standing rule. session_start re-fires on
	// /reload, /resume, and /fork — dedup by scanning for our custom message.
	pi.on("session_start", async (_event, ctx) => {
		const alreadyInjected = ctx.sessionManager
			.getEntries()
			.some(
				(e) => e.type === "custom_message" && e.customType === INIT_CUSTOM_TYPE,
			);
		if (alreadyInjected) {
			lastKnown = snapshotFile(ctx.cwd);
			return;
		}

		pi.sendMessage({
			customType: INIT_CUSTOM_TYPE,
			content: buildInitMessage(ownerShort(ctx)) + gitNudge(ctx.cwd),
			display: true,
		});

		// Baseline for staleness detection — don't flag the state we just saw.
		lastKnown = snapshotFile(ctx.cwd);

		if (ctx.hasUI) {
			ctx.ui.notify(`Tasks mode: ${TASKS_PATH}`, "info");
		}
	});

	// Per-turn reminder. Returned as a custom message riding next to the user's
	// prompt; identical text every turn so provider prompt caches stay valid.
	// Switches to a staleness warning when the file changed on disk since the
	// agent last touched it.
	pi.on("before_agent_start", async (_event, ctx) => {
		const current = snapshotFile(ctx.cwd);
		let stale = false;
		if (current && lastKnown) {
			if (current.hash === lastKnown.hash) {
				lastKnown = current; // touched but identical content
			} else {
				stale = true;
				lastKnown = current;
			}
		} else if (current) {
			lastKnown = current;
		}
		return {
			message: {
				customType: TAG_CUSTOM_TYPE,
				content: stale ? TAG_STALE : TAG,
				display: TAG_DISPLAY,
			},
		};
	});

	// Refresh the snapshot at the end of every turn so the agent's own writes
	// to the file never trigger the staleness warning on the next turn.
	pi.on("turn_end", async (_event, ctx) => {
		lastKnown = snapshotFile(ctx.cwd);
	});

	// tasks_tidy — agent-invocable tool: the model can tidy the file itself
	// after checklist updates (no dialog; the call and result show in the
	// transcript). Same deterministic rewrite as /tasks-tidy.
	pi.registerTool({
		name: "tasks_tidy",
		label: "Tidy tasks file",
		description: `Normalize ${TASKS_PATH}: fix checkbox syntax, indentation and "Confirm (user):" prefixes, and reorder items unchecked-first within each section. Non-destructive: unrecognized lines pass through untouched.`,
		promptSnippet: `Tidy ${TASKS_PATH}: normalize checklist formatting and move unchecked items to the top`,
		promptGuidelines: [
			`After updating ${TASKS_PATH}, call tasks_tidy to keep the format normalized (checkbox syntax, 2-space nesting, "Confirm (user):" prefixes, unchecked items first).`,
		],
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const outcome = computeTidy(ctx.cwd);
			if (outcome.status === "missing") {
				return {
					content: [{ type: "text", text: `${TASKS_PATH} does not exist.` }],
					details: outcome,
				};
			}
			if (outcome.status === "no-items") {
				return {
					content: [{ type: "text", text: `No checklist items in ${TASKS_PATH} — nothing to tidy.` }],
					details: outcome,
				};
			}
			if (outcome.status === "unchanged") {
				return {
					content: [{ type: "text", text: `${TASKS_PATH} is already tidy (${outcome.items} items).` }],
					details: outcome,
				};
			}
			writeTidied(ctx.cwd, outcome.tidied!);
			return {
				content: [
					{ type: "text", text: `Tidied ${TASKS_PATH}: ${outcome.items} item(s) reformatted (checkbox syntax, indentation, "Confirm (user):" prefixes) and reordered with unchecked items first.` },
				],
				details: outcome,
			};
		},
	});

	// /tasks-tidy — user command: same rewrite, behind a confirmation dialog.
	pi.registerCommand("tasks-tidy", {
		description: `Tidy ${TASKS_PATH}: normalize format and move unchecked items to the top`,
		handler: async (_args, ctx) => {
			const outcome = computeTidy(ctx.cwd);
			if (outcome.status === "missing") {
				ctx.ui.notify(`${TASKS_PATH} does not exist.`, "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}
			if (outcome.status === "no-items") {
				ctx.ui.notify(
					`No checklist items found in ${TASKS_PATH} — nothing to tidy.`,
					"info",
				);
				return;
			}
			if (outcome.status === "unchanged") {
				ctx.ui.notify(`${TASKS_PATH} is already tidy.`, "info");
				return;
			}

			const ok = await ctx.ui.confirm(
				"Tidy tasks?",
				`${outcome.items} checklist item(s) will be reformatted (checkbox syntax, indentation, "Confirm (user):" prefixes) and reordered with unchecked items first. Unrecognized lines pass through untouched. See git diff if tracked.`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			writeTidied(ctx.cwd, outcome.tidied!);
			ctx.ui.notify(`${TASKS_PATH} tidied.`, "info");
		},
	});

	// /tasks-archive — move completed items to the archive file.
	pi.registerCommand("tasks-archive", {
		description: `Move completed items from ${TASKS_PATH} to ${ARCHIVE_PATH}`,
		handler: async (_args, ctx) => {
			const file = join(ctx.cwd, TASKS_PATH);
			if (!existsSync(file)) {
				ctx.ui.notify(`${TASKS_PATH} does not exist.`, "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}

			const original = readFileSync(file, "utf8");
			const { remaining, movedText, movedCount } = extractCompleted(
				parseDoc(original),
			);
			if (movedCount === 0) {
				ctx.ui.notify(
					`No completed items in ${TASKS_PATH} — nothing to archive.`,
					"info",
				);
				return;
			}

			const ok = await ctx.ui.confirm(
				"Archive completed items?",
				`${movedCount} completed item(s) (with sub-items) will be moved to ${ARCHIVE_PATH} under a dated heading. See git diff if tracked.`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			const stamp = timestamp();
			const block = `## Archived ${stamp}\n\n${movedText.trimEnd()}\n`;
			if (existsSync(join(ctx.cwd, ARCHIVE_PATH))) {
				const prev = readFileSync(join(ctx.cwd, ARCHIVE_PATH), "utf8");
				writeFileSync(
					join(ctx.cwd, ARCHIVE_PATH),
					(prev.endsWith("\n") ? prev : prev + "\n") + "\n" + block,
					"utf8",
				);
			} else {
				writeFileSync(
					join(ctx.cwd, ARCHIVE_PATH),
					`# TASKS archive\n\n${block}`,
					"utf8",
				);
			}

			writeFileSync(file, serializeDoc(remaining), "utf8");
			lastKnown = snapshotFile(ctx.cwd);
			ctx.ui.notify(
				`${movedCount} item(s) archived to ${ARCHIVE_PATH}. When git-tracked, suggest committing both files.`,
				"info",
			);
		},
	});

	// /tasks-verify — inject a user message that starts the verification
	// walkthrough. The model asks the user per-item questions via
	// ask_user_question and reflects the answers in the checklist file.
	pi.registerCommand("tasks-verify", {
		description: `Verify pending items in ${TASKS_PATH} with the user (asks per-item questions, then updates the file)`,
		handler: async (_args, ctx) => {
			const file = join(ctx.cwd, TASKS_PATH);
			if (!existsSync(file)) {
				ctx.ui.notify(
					`${TASKS_PATH} does not exist — nothing to verify. It is created when the first instruction is recorded.`,
					"warning",
				);
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}

			await pi.sendUserMessage(VERIFY_MESSAGE);
			ctx.ui.notify(
				`Verification request sent — the agent will ask about each item needing user confirmation.`,
				"info",
			);
		},
	});

	// /tasks — show usage for all subcommands.
	pi.registerCommand("tasks", {
		description: `Manage ${TASKS_PATH} (see also: /tasks-tidy, /tasks-archive, /tasks-verify, /tasks-clear)`,
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Usage: /tasks-tidy — normalize format, unchecked items first · /tasks-archive — move completed items to ${ARCHIVE_PATH} · /tasks-verify — walk pending confirmations with the user · /tasks-clear — clear ${TASKS_PATH} and write a tombstone note.`,
				"info",
			);
		},
	});

	// /tasks-clear — clear the file and write a tombstone note.
	pi.registerCommand("tasks-clear", {
		handler: async (_args, ctx) => {
			const file = join(ctx.cwd, TASKS_PATH);
			if (!existsSync(file)) {
				ctx.ui.notify(`${TASKS_PATH} does not exist.`, "warning");
				return;
			}

			const current = readFileSync(file, "utf8");
			if (current.trim() === "") {
				ctx.ui.notify(`${TASKS_PATH} is already empty.`, "info");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}

			const ok = await ctx.ui.confirm(
				"Clear tasks?",
				`${TASKS_PATH} will be cleared and a tombstone note written. This cannot be undone (see git history if tracked).`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			const tombstone =
				`<!-- Cleared via /tasks-clear on ${timestamp()}. ` +
				`Previous contents were intentionally removed by the user. ` +
				`Do not reconstruct them from memory.` +
				(existsSync(join(ctx.cwd, ".git"))
					? " See git history if this file is tracked."
					: "") +
				` -->\n`;

			writeFileSync(file, tombstone, "utf8");
			lastKnown = snapshotFile(ctx.cwd);
			ctx.ui.notify(`${TASKS_PATH} cleared.`, "info");
		},
	});
}
