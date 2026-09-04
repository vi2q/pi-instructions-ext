/**
 * instructions-ext — keep docs/TASKS.md as the standing record of
 * work instructions and their checklist state.
 *
 * - session_start: inject a short pointer — when docs/TASKS.md or
 *   docs/RULES.md are missing, tell the model to call the tasks_init tool
 *   and then read docs/RULES.md; when both exist, tell it to read
 *   docs/RULES.md (the recording rules, generated once and user-editable)
 * - before_agent_start: append a short per-turn reminder tag (identical
 *   string every turn so provider prompt caches stay valid); switches to a
 *   staleness warning when the file changed on disk since the agent last
 *   touched it (a parallel session or a manual edit)
 * - turn_end: refresh the staleness snapshot so the agent's own writes don't
 *   trigger the warning
 * - /tasks-tidy command and tasks_tidy tool: deterministic formatting —
 *   normalize checkbox syntax and indentation, normalize "Confirm (user):"
 *   prefixes on sub-items. Item order is preserved (no reordering).
 *   Unrecognized lines pass through untouched; if no checklist items are
 *   found the file is left as is.
 * - /tasks-init command and tasks_init tool: generate docs/TASKS.md (a
 *   minimal skeleton) and docs/RULES.md (the recording rules) if missing.
 *   Existing files are never overwritten.
 * - /tasks-archive: move completed top-level items (with their sub-items) to
 *   docs/TASKS-archive.md under a dated heading
 * - /tasks-clear: clear the file after confirmation and leave a tombstone
 * - /tasks-blocked and /tasks-completed: two-column picker over the checklist
 *   (left: categories, ←/→; right: items, ↑/↓). Enter spawns the item's text
 *   into the editor so the user can pin-point it back to the agent; Esc closes.
 * - session_compact: after context compaction, re-inject a short pointer —
 *   summaries may not preserve item-level checklist state, so the model is
 *   told to re-read docs/TASKS.md (and follow docs/RULES.md).
 *
 * The extension never rewrites the file automatically; deterministic
 * rewrites happen only inside the explicit commands above.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- Configuration -----------------------------------------------------------

const TASKS_PATH = "docs/TASKS.md";
const RULES_PATH = "docs/RULES.md";
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
const COMPACT_CUSTOM_TYPE = "instructions-ext:post-compact";

const RULES_TEMPLATE = `# TASKS recording rules

How this project records work instructions and their state (docs/TASKS.md).

## Recording

- Record each new instruction in docs/TASKS.md **before** starting on it,
  with a checklist of concrete steps as GFM checkboxes (\`- [ ]\` / \`- [x]\`).
- Keep the file up to date as work progresses. Skip pure acknowledgements
  ("yes", "continue") — judge what counts as an instruction.
- Respond and record in the user's language.

## User confirmation

- Items whose completion requires the user (behavior or visual checks,
  acceptance) get a sub-item prefixed "Confirm (user):" — never check it
  off yourself.
- When work finishes, ask the user about each pending confirmation item
  via the ask_user_question tool (one question per item, the concrete
  check described, options like OK / problem / later; plain text if the
  tool is unavailable). Never mark an item confirmed without an explicit
  user answer.
- Reflect answers as: "[x] … — user-confirmed (date)" · "— needs-fix:
  <summary>" · keep deferred items unchecked with "— pending
  confirmation".

## Parallel sessions

- Tag each top-level instruction you record with your session owner tag,
  e.g. "(s01a0)" (provided in the session-start message), and update only
  items carrying your own tag unless the user explicitly instructs
  otherwise.
- Re-read docs/TASKS.md before updating it — parallel sessions may have
  changed it. Merge, don't overwrite.

## Housekeeping

- If docs/TASKS.md accumulates many completed items, suggest that the user
  run /tasks-archive. The archive command is user-invoked — never move
  completed items yourself.
- The user may feed items back into the conversation via /tasks-blocked
  (unfinished / pending-confirmation / needs-fix items) or /tasks-completed
  (checked items, for re-check requests). When the user quotes one of these
  items, find it in docs/TASKS.md and work on exactly that item.

<!-- Generated by pi-instructions-ext. Edit freely; the extension never
     overwrites this file once it exists. -->
`;

const TASKS_TEMPLATE = `# TASKS

<!-- Work-instruction record. See docs/RULES.md for conventions. -->

## Active

## Completed
`;

function sessionPointer(ownerShort: string, filesReady: boolean): string {
	if (filesReady) {
		return (
			`Auto-message: Start by reading ${RULES_PATH} — it defines how work instructions are recorded in ${TASKS_PATH}. ` +
			`Your session owner tag is "(s${ownerShort})".`
		);
	}
	return (
		`Auto-message: ${TASKS_PATH} and ${RULES_PATH} are not set up yet — call the tasks_init tool to generate them (it only creates what is missing), ` +
		`then read ${RULES_PATH} and follow it when recording work instructions. ` +
		`Your session owner tag is "(s${ownerShort})".`
	);
}

/** Create the template files if missing. Never overwrites existing files. */
function ensureTaskFiles(cwd: string): {
	createdTasks: boolean;
	createdRules: boolean;
} {
	const tasksFile = join(cwd, TASKS_PATH);
	const rulesFile = join(cwd, RULES_PATH);
	const createdTasks = !existsSync(tasksFile);
	const createdRules = !existsSync(rulesFile);
	if (createdTasks) writeFileSync(tasksFile, TASKS_TEMPLATE, "utf8");
	if (createdRules) writeFileSync(rulesFile, RULES_TEMPLATE, "utf8");
	return { createdTasks, createdRules };
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

/** Deterministic tidy: normalize structure only, preserve item order. */
function tidyDoc(sections: Section[]): string {
	return serializeDoc(sections);
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
 * nudge sentence appended to the session-start pointer. The record only becomes
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

// --- Checklist pickers (/tasks-blocked, /tasks-completed) ---------------------

interface PickerItem {
	label: string;
	checked: boolean;
	confirm: boolean;
	needsFix: boolean;
	depth: number;
	/** Lines spawned into the editor: ancestor chain + own text + direct children. */
	spawn: string[];
}

/** Flatten every checklist item (any nesting level) into picker entries. */
function flattenSections(sections: Section[]): PickerItem[] {
	const out: PickerItem[] = [];
	const walk = (
		node: ItemNode,
		chain: { depth: number; text: string }[],
		depth: number,
	) => {
		const lines: { depth: number; text: string }[] = [
			...chain,
			{ depth, text: node.text },
		];
		for (const child of node.children) {
			lines.push({ depth: depth + 1, text: child.text });
		}
		out.push({
			label: node.text,
			checked: node.checked,
			confirm: CONFIRM_PREFIX_RE.test(node.text),
			needsFix: /needs-fix/i.test(node.text),
			depth,
			spawn: lines.map((l) => `${"  ".repeat(l.depth)}- ${l.text}`),
		});
		node.children.forEach((child) =>
			walk(child, [...chain, { depth, text: node.text }], depth + 1),
		);
	};
	for (const s of sections) s.roots.forEach((r) => walk(r, [], 0));
	return out;
}

interface PickerCategory {
	name: string;
	items: PickerItem[];
}

const PICKER_LEFT_WIDTH = 22;
const PICKER_ROWS = 14;

/**
 * Two-column picker, in the spirit of the /model dialog: categories on the
 * left (←/→), the selected category's items on the right (↑/↓), Enter
 * returns the selected item's text, Esc cancels.
 */
class TaskPickerComponent implements Component {
	private catIndex = 0;
	private itemIndex = 0;
	private catScroll = 0;
	private itemScroll = 0;
	constructor(
		private categories: PickerCategory[],
		private title: string,
		private tui: TUI,
		private th: Theme,
		private done: (value: string | null) => void,
	) {}

	private static adjustScroll(
		scroll: number,
		index: number,
		max: number,
	): number {
		if (index < scroll) return index;
		if (index >= scroll + max) return index - max + 1;
		return scroll;
	}

	handleInput(data: string): void {
		const lastCat = this.categories.length - 1;
		const cat = this.categories[this.catIndex];
		const lastItem = (cat?.items.length ?? 1) - 1;
		let dirty = false;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "left")) {
			this.catIndex = this.catIndex === 0 ? lastCat : this.catIndex - 1;
			this.itemIndex = 0;
			dirty = true;
		} else if (matchesKey(data, "right")) {
			this.catIndex = this.catIndex === lastCat ? 0 : this.catIndex + 1;
			this.itemIndex = 0;
			dirty = true;
		} else if (matchesKey(data, "up")) {
			this.itemIndex = Math.max(0, this.itemIndex - 1);
			dirty = true;
		} else if (matchesKey(data, "down")) {
			this.itemIndex = Math.min(lastItem, this.itemIndex + 1);
			dirty = true;
		} else if (matchesKey(data, "return")) {
			const item = cat?.items[this.itemIndex];
			this.done(item ? item.spawn.join("\n") : null);
			return;
		}
		if (!dirty) return;
		this.catScroll = TaskPickerComponent.adjustScroll(
			this.catScroll,
			this.catIndex,
			PICKER_ROWS,
		);
		this.itemScroll = TaskPickerComponent.adjustScroll(
			this.itemScroll,
			this.itemIndex,
			PICKER_ROWS,
		);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.th;
		const leftW = Math.min(PICKER_LEFT_WIDTH, Math.max(10, width - 30));
		const rightW = Math.max(20, width - leftW - 3);
		const cat = this.categories[this.catIndex];
		const items = cat?.items ?? [];
		const lines: string[] = [];

		lines.push("");
		lines.push(
			truncateToWidth(` ${th.fg("accent", th.bold(this.title))}`, width),
		);
		const rule = th.fg("borderMuted", "─".repeat(Math.max(0, width - 1)));
		lines.push(truncateToWidth(rule, width));

		for (let r = 0; r < PICKER_ROWS; r++) {
			const cIdx = this.catScroll + r;
			let left = " ".repeat(leftW);
			if (cIdx < this.categories.length) {
				const plain = (" " + this.categories[cIdx].name)
					.slice(0, leftW)
					.padEnd(leftW);
				left =
					cIdx === this.catIndex
						? th.bg("selectedBg", th.fg("text", plain))
						: th.fg("muted", plain);
			}

			const iIdx = this.itemScroll + r;
			let right = "";
			if (items.length === 0) {
				if (r === 0) right = th.fg("dim", "no items");
			} else if (iIdx < items.length) {
				const item = items[iIdx];
				const mark = item.checked ? th.fg("success", "✓") : th.fg("dim", "○");
				const text = truncateToWidth(item.label, rightW - 6);
				const colored = ` ${mark} ${text}`;
				const pad = Math.max(0, rightW - 1 - visibleWidth(colored));
				right =
					iIdx === this.itemIndex
						? th.bg("selectedBg", `${colored}${" ".repeat(pad)}`)
						: colored;
			}

			lines.push(
				truncateToWidth(`${left}${th.fg("borderMuted", " │ ")}${right}`, width),
			);
		}

		lines.push(truncateToWidth(rule, width));
		lines.push(
			` ${th.fg("dim", "←/→ category · ↑/↓ item · Enter: insert into editor · Esc: close")}`,
		);
		return lines;
	}

	invalidate(): void {}
}

/** Open the picker; return the spawned text, or null when cancelled. */
async function openTaskPicker(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionCommandContext,
	categories: PickerCategory[],
	title: string,
): Promise<string | null> {
	return ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) =>
			new TaskPickerComponent(categories, title, tui, theme, done),
	);
}

function spawnIntoEditor(
	ctx: { ui: { getEditorText(): string; setEditorText(text: string): void } },
	text: string,
): void {
	const prev = ctx.ui.getEditorText();
	if (prev.trim() === "") {
		ctx.ui.setEditorText(text);
	} else {
		ctx.ui.setEditorText(`${prev}${prev.endsWith("\n") ? "" : "\n"}${text}`);
	}
}

// --- Extension ----------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// One-time injection of the session pointer. session_start re-fires on
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

		const filesReady =
			existsSync(join(ctx.cwd, TASKS_PATH)) &&
			existsSync(join(ctx.cwd, RULES_PATH));

		pi.sendMessage({
			customType: INIT_CUSTOM_TYPE,
			content: sessionPointer(ownerShort(ctx), filesReady) + gitNudge(ctx.cwd),
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

	// After context compaction the summary may not preserve item-level
	// checklist state — re-inject a short pointer so the model re-reads the
	// file instead of trusting the summary.
	pi.on("session_compact", async (_event, ctx) => {
		if (!existsSync(join(ctx.cwd, TASKS_PATH))) return;
		pi.sendMessage({
			customType: COMPACT_CUSTOM_TYPE,
			content:
				`Auto-message: The context was just compacted. The summary may not preserve item-level checklist state — ` +
				`re-read ${TASKS_PATH} to restore the current state before updating the record, ` +
				`and keep following ${RULES_PATH}.`,
			display: false,
		});
	});

	// tasks_tidy — agent-invocable tool: the model can tidy the file itself
	// after checklist updates (no dialog; the call and result show in the
	// transcript). Same deterministic rewrite as /tasks-tidy.
	pi.registerTool({
		name: "tasks_tidy",
		label: "Tidy tasks file",
		description: `Normalize ${TASKS_PATH}: fix checkbox syntax, indentation and "Confirm (user):" prefixes. Order-preserving: no reordering. Non-destructive: unrecognized lines pass through untouched.`,
		promptSnippet: `Tidy ${TASKS_PATH}: normalize checklist formatting (no reordering)`,
		promptGuidelines: [
			`After updating ${TASKS_PATH}, call tasks_tidy to keep the format normalized (checkbox syntax, 2-space nesting, "Confirm (user):" prefixes). Item order is preserved.`,
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
					content: [
						{
							type: "text",
							text: `No checklist items in ${TASKS_PATH} — nothing to tidy.`,
						},
					],
					details: outcome,
				};
			}
			if (outcome.status === "unchanged") {
				return {
					content: [
						{
							type: "text",
							text: `${TASKS_PATH} is already tidy (${outcome.items} items).`,
						},
					],
					details: outcome,
				};
			}
			writeTidied(ctx.cwd, outcome.tidied!);
			return {
				content: [
					{
						type: "text",
						text: `Tidied ${TASKS_PATH}: ${outcome.items} item(s) reformatted (checkbox syntax, indentation, "Confirm (user):" prefixes). Item order preserved.`,
					},
				],
				details: outcome,
			};
		},
	});

	// /tasks-tidy — user command: same rewrite, behind a confirmation dialog.
	pi.registerCommand("tasks-tidy", {
		description: `Tidy ${TASKS_PATH}: normalize format (order-preserving, no reordering)`,
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
				`${outcome.items} checklist item(s) will be reformatted (checkbox syntax, indentation, "Confirm (user):" prefixes). Item order is preserved — no reordering. Unrecognized lines pass through untouched. See git diff if tracked.`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}

			writeTidied(ctx.cwd, outcome.tidied!);
			ctx.ui.notify(`${TASKS_PATH} tidied.`, "info");
		},
	});

	// tasks_init — agent-invocable tool: generate the template files if
	// missing, then have the model read the rules. Never overwrites.
	pi.registerTool({
		name: "tasks_init",
		label: "Initialize tasks files",
		description: `Create ${TASKS_PATH} (a minimal skeleton) and ${RULES_PATH} (the recording rules) if they are missing. Never overwrites existing files. Read ${RULES_PATH} afterwards and follow it.`,
		promptSnippet: `Generate ${TASKS_PATH} and ${RULES_PATH} if missing`,
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const { createdTasks, createdRules } = ensureTaskFiles(ctx.cwd);
			if (!createdTasks && !createdRules) {
				return {
					content: [
						{
							type: "text",
							text: `${TASKS_PATH} and ${RULES_PATH} already exist — read ${RULES_PATH} and follow it.`,
						},
					],
					details: { createdTasks, createdRules },
				};
			}
			const parts: string[] = [];
			if (createdTasks) parts.push(`created ${TASKS_PATH} (skeleton)`);
			if (createdRules) parts.push(`created ${RULES_PATH} (recording rules)`);
			return {
				content: [
					{
						type: "text",
						text:
							parts.join(", ") +
							`. Read ${RULES_PATH} and follow it when recording work instructions.`,
					},
				],
				details: { createdTasks, createdRules },
			};
		},
	});

	// /tasks-init — user command: same generation, with a notification.
	pi.registerCommand("tasks-init", {
		description: `Generate ${TASKS_PATH} and ${RULES_PATH} if missing (never overwrites)`,
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}
			const { createdTasks, createdRules } = ensureTaskFiles(ctx.cwd);
			if (!createdTasks && !createdRules) {
				ctx.ui.notify(
					`${TASKS_PATH} and ${RULES_PATH} already exist — nothing to generate.`,
					"info",
				);
				return;
			}
			if (createdTasks) ctx.ui.notify(`Created ${TASKS_PATH} (skeleton).`, "info");
			if (createdRules)
				ctx.ui.notify(`Created ${RULES_PATH} (recording rules).`, "info");
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

	// /tasks-blocked — pick an unfinished item and spawn its text into the
	// editor, so the user can pin-point it back to the agent ("this one —
	// get on with it") without retyping it.
	pi.registerCommand("tasks-blocked", {
		description: `Pick an unfinished item from ${TASKS_PATH} into the editor (categories: unfinished / pending confirmation / needs-fix)`,
		handler: async (_args, ctx) => {
			const file = join(ctx.cwd, TASKS_PATH);
			if (!existsSync(file)) {
				ctx.ui.notify(
					`${TASKS_PATH} does not exist — it is created when the first instruction is recorded.`,
					"warning",
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("tasks-blocked needs the interactive UI.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}

			const all = flattenSections(parseDoc(readFileSync(file, "utf8")));
			const categories: PickerCategory[] = [
				{
					name: "Unfinished",
					items: all.filter(
						(i) => i.depth === 0 && !i.checked && !i.confirm && !i.needsFix,
					),
				},
				{
					name: "Pending confirm",
					items: all.filter((i) => !i.checked && i.confirm),
				},
				{ name: "needs-fix", items: all.filter((i) => i.needsFix) },
			].filter((c) => c.items.length > 0);
			if (categories.length === 0) {
				ctx.ui.notify(`No unfinished items in ${TASKS_PATH}.`, "info");
				return;
			}

			const picked = await openTaskPicker(ctx, categories, TASKS_PATH);
			if (picked !== null) spawnIntoEditor(ctx, picked);
		},
	});

	// /tasks-completed — same picker over checked items, for re-check
	// requests ("this one — double-check it again").
	pi.registerCommand("tasks-completed", {
		description: `Pick a completed item from ${TASKS_PATH} into the editor (for re-check requests)`,
		handler: async (_args, ctx) => {
			const file = join(ctx.cwd, TASKS_PATH);
			if (!existsSync(file)) {
				ctx.ui.notify(
					`${TASKS_PATH} does not exist — it is created when the first instruction is recorded.`,
					"warning",
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("tasks-completed needs the interactive UI.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is running. Try again after it settles.", "warning");
				return;
			}

			const all = flattenSections(parseDoc(readFileSync(file, "utf8")));
			const categories: PickerCategory[] = [
				{ name: "Completed", items: all.filter((i) => i.checked) },
			];
			if (categories[0].items.length === 0) {
				ctx.ui.notify(`No completed items in ${TASKS_PATH}.`, "info");
				return;
			}

			const picked = await openTaskPicker(ctx, categories, TASKS_PATH);
			if (picked !== null) spawnIntoEditor(ctx, picked);
		},
	});

	// /tasks-info — command cheat sheet.
	pi.registerCommand("tasks-info", {
		description: `Show /tasks-* commands for ${TASKS_PATH}`,
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Usage: /tasks-init — generate ${TASKS_PATH}/${RULES_PATH} if missing · /tasks-blocked — pick an unfinished item into the editor · /tasks-completed — pick a completed item into the editor · /tasks-tidy — normalize format (order-preserving) · /tasks-archive — move completed items to ${ARCHIVE_PATH} · /tasks-verify — walk pending confirmations with the user · /tasks-clear — clear ${TASKS_PATH} and write a tombstone note.`,
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
