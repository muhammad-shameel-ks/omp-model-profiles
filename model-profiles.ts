// model-profiles — named model + agent profile snapshots for omp.
//
// Install (project-local): copy to `.omp/extensions/model-profiles.ts`:
//   mkdir -p .omp/extensions && cp model-profiles.ts .omp/extensions/
// Profiles live in `.omp/model-profiles.yml` (project scope, v1).
//
// Commands:
//   /profiles          fullscreen dashboard: apply, snapshot, new, rename, delete,
//                      per-role and per-agent model picking with fuzzy search
//   /profiles <name>   apply a profile by name (Tab completes profile names)
//
// Implementation note: this extension may only import *values* from the
// `@oh-my-pi/pi-tui` package ROOT. In the compiled omp binary every other
// pi-tui subpath (`/keys`, `/mouse`, `/utils`, `/chrome/*`, `/overlays/*`)
// fails to resolve from an extension, so the fullscreen hub below is composed
// from root-barrel primitives (Input, MenuSelection, matchesKey, utils) with a
// local SGR mouse decoder and a local two-pane layout that mirrors the native
// hub chrome. Verified by probe against omp 18.4.3.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	KeybindingsManager,
} from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgModelRoleStorage } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getKnownRoleIds, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Component, Theme, TUI } from "@oh-my-pi/pi-tui";
import { Input, MenuSelection, matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Model } from "@oh-my-pi/pi-ai";

// ─── schema ────────────────────────────────────────────────────────────────

const FILE_NAME = "model-profiles.yml";
const FILE_VERSION = 1;

/** Thinking suffixes for display splitting (`:max`/`:auto` excluded — real model ids collide with them; resolve() owns that ambiguity). */
/** The `auto` level: chosen by omp at request time, not an effort of its own. */
const AUTO_LEVEL = "auto";

const THINKING_SUFFIXES: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
};

interface ProfileData {
	description?: string;
	roles?: Record<string, string>;
	agents?: Record<string, string>;
}

interface ProfilesFile {
	version: number;
	active?: string;
	profiles: Record<string, ProfileData>;
}

// ─── storage ───────────────────────────────────────────────────────────────

function isStrRecord(v: unknown): v is Record<string, string> {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	return Object.values(v).every(x => typeof x === "string");
}

function profilesFile(cwd: string): string {
	return path.join(cwd, ".omp", FILE_NAME);
}

export function loadProfiles(cwd: string): ProfilesFile {
	const empty: ProfilesFile = { version: FILE_VERSION, profiles: {} };
	let raw: string;
	try {
		raw = fs.readFileSync(profilesFile(cwd), "utf-8");
	} catch {
		return empty;
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(raw);
	} catch {
		return empty;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
	const profiles: Record<string, ProfileData> = {};
	const rawProfiles: unknown = (parsed as { profiles?: unknown }).profiles;
	if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
		for (const [name, p] of Object.entries(rawProfiles as Record<string, unknown>)) {
			if (!p || typeof p !== "object" || Array.isArray(p)) continue;
			const rec = p as Record<string, unknown>;
			const clean: ProfileData = {};
			if (typeof rec["description"] === "string") clean.description = rec["description"];
			if (isStrRecord(rec["roles"])) clean.roles = { ...rec["roles"] };
			if (isStrRecord(rec["agents"])) clean.agents = { ...rec["agents"] };
			profiles[name] = clean;
		}
	}
	const out: ProfilesFile = { version: FILE_VERSION, profiles };
	const active: unknown = (parsed as { active?: unknown }).active;
	if (typeof active === "string" && profiles[active]) out.active = active;
	return out;
}

export function saveProfiles(cwd: string, data: ProfilesFile): void {
	const dir = path.join(cwd, ".omp");
	fs.mkdirSync(dir, { recursive: true });
	const target = profilesFile(cwd);
	const text = YAML.stringify({ version: FILE_VERSION, active: data.active, profiles: data.profiles }, null, 2);
	const body = text.endsWith("\n") ? text : `${text}\n`;
	const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(tmp, body, { mode: 0o600 });
		fs.renameSync(tmp, target);
	} catch (err) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
		throw err;
	}
}

// ─── settings + discovery reads ────────────────────────────────────────────

function knownRoles(settings: Settings): string[] {
	try {
		return getKnownRoleIds(settings);
	} catch {
		return ["default", "smol", "slow", "plan", "commit", "task", "advisor"];
	}
}

function liveRoles(settings: Settings): Record<string, string> {
	const out: Record<string, string> = {};
	for (const role of knownRoles(settings)) {
		try {
			const v = settings.getModelRole(role);
			if (typeof v === "string" && v) out[role] = v;
		} catch { /* ignore */ }
	}
	return out;
}

interface AgentRow {
	name: string;
	description: string;
	override?: string;
}

async function agentRows(cwd: string, scope: Settings): Promise<AgentRow[]> {
	let agents: { name: string; description: string }[];
	try {
		agents = (await discoverAgents(cwd, os.homedir(), undefined)).agents;
	} catch {
		return [];
	}
	let overrides: Record<string, string | string[]>;
	try {
		overrides = cfgTaskAgentModelOverrides.get(scope);
	} catch {
		overrides = {};
	}
	return agents.map(a => {
		const raw = overrides[a.name];
		const str = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).trim();
		return { name: a.name, description: a.description ?? "", override: str || undefined };
	});
}

// ─── apply ─────────────────────────────────────────────────────────────────

export interface ApplyResult {
	appliedRoles: string[];
	appliedAgents: string[];
	skipped: { key: string; reason: string }[];
	switchedDefault?: string;
	switchedThinking?: string;
}

/**
 * Split a trailing `:level` thinking selector; unknown tails stay in base.
 *
 * `:max` is ambiguous — real model ids end in it (`glm-4.7:max`) — so it only
 * counts as a thinking level when `isLiteralModel` says no available model
 * matches the whole selector (the same rule core's parser applies).
 */
/**
 * Split a selector into its model base and thinking level. Recognized suffixes are
 * peeled in a loop, so a selector that already carries a chain (`model:auto:auto:high`,
 * as written by versions that did not know `auto`) collapses to its base and the
 * effective level instead of growing on every write.
 */
export function splitSelector(
	selector: string,
	isLiteralModel?: (selector: string) => boolean,
): { base: string; thinking?: string } {
	let base = selector;
	let thinking: string | undefined;
	for (;;) {
		const idx = base.lastIndexOf(":");
		if (idx <= 0) break;
		const tail = base.slice(idx + 1).toLowerCase();
		const known = Object.hasOwn(THINKING_SUFFIXES, tail) || tail === "max" || tail === AUTO_LEVEL;
		if (!known) break;
		// A literal model id may end in `:max` (`zai/glm-4.7:max`) — that is the id, not a level.
		if (tail === "max" && isLiteralModel?.(base) === true) break;
		thinking ??= tail;
		base = base.slice(0, idx);
	}
	return thinking === undefined ? { base } : { base, thinking };
}

/** Thinking selector labels, mirroring omp's own metadata. */
const THINKING_LABELS: Record<string, string> = {
	inherit: "inherit",
	off: "off",
	auto: "auto",
	minimal: "min",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** Canonical effort order, least → most intensive (core's THINKING_EFFORTS). */
const THINKING_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Used only when a reasoning model carries no effort list. */
const THINKING_FALLBACK: readonly (string | undefined)[] = [undefined, "off", AUTO_LEVEL, ...THINKING_ORDER];

/** Effort list a model advertises (`thinking.efforts`); empty for non-reasoning models. */
function modelEfforts(model: Model | undefined): string[] {
	const config: unknown = model?.thinking;
	if (!config || typeof config !== "object" || !("efforts" in config)) return [];
	const efforts: unknown = config.efforts;
	if (!Array.isArray(efforts)) return [];
	return efforts.filter((e): e is string => typeof e === "string");
}

/**
 * Thinking levels this model accepts, mirroring the `/models` hub:
 * inherit (no suffix) → off → auto → the model's own efforts.
 */
export function thinkingOptions(model: Model | undefined): (string | undefined)[] {
	if (!model?.reasoning) return [undefined];
	const efforts = modelEfforts(model);
	return efforts.length > 0 ? [undefined, "off", AUTO_LEVEL, ...efforts] : [...THINKING_FALLBACK];
}

/** Next level in `options`; negative `step` walks down. Unknown values start at "inherit". */
export function cycleThinking(
	current: string | undefined,
	step: number,
	options: readonly (string | undefined)[] = THINKING_FALLBACK,
): string | undefined {
	const list = options.length > 0 ? options : [undefined];
	const at = list.indexOf(current);
	const from = at === -1 ? 0 : at;
	return list[(from + step + list.length) % list.length];
}

/** Clamp a level to what the model supports (core's clampThinkingLevelForModel). */
export function clampThinking(
	level: string | undefined,
	model: Model | undefined,
): string | undefined {
	if (!level || !model?.reasoning) return level;
	const options = thinkingOptions(model);
	if (options.includes(level)) return level;
	const index = THINKING_ORDER.indexOf(level);
	if (index === -1) return undefined;
	let clamped: string | undefined;
	for (const effort of modelEfforts(model)) {
		if (THINKING_ORDER.indexOf(effort) > index) break;
		clamped = effort;
	}
	return clamped ?? modelEfforts(model)[0] ?? undefined;
}

/** Re-attach (or drop) a thinking suffix on a selector. */
export function withThinking(
	selector: string,
	level: string | undefined,
	isLiteralModel?: (selector: string) => boolean,
): string {
	const { base } = splitSelector(selector, isLiteralModel);
	return level ? `${base}:${level}` : base;
}

/** Native glyph for a thinking level (omp's `thinkingLevelGlyph`). */
export function thinkingGlyph(theme: Theme, level: string | undefined): string {
	if (!level || level === "inherit") return "";
	if (level === "off") return theme.status.disabled;
	const symbols = theme.thinking;
	if (level === AUTO_LEVEL) return firstToken(symbols.autoPending);
	const key = THINKING_SYMBOL_KEYS[level];
	return key ? firstToken(symbols[key]) : "";
}

const THINKING_SYMBOL_KEYS: Record<string, "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "autoPending"> = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	auto: "autoPending",
};

function firstToken(symbol: string | undefined): string {
	if (typeof symbol !== "string") return "";
	const space = symbol.indexOf(" ");
	return space < 0 ? symbol : symbol.slice(0, space);
}

/**
 * Render one thinking level as omp does: colored glyph + label.
 * `supported: false` marks a level the model does not accept (apply will clamp it).
 */
export function thinkingChip(theme: Theme, level: string | undefined, supported = true): string {
	const name = level ?? "inherit";
	const label = THINKING_LABELS[name] ?? name;
	const glyph = thinkingGlyph(theme, level);
	const paint = theme.getThinkingBorderColor(name);
	const text = glyph ? `${glyph} ${label}` : label;
	return supported ? paint(text) : theme.fg("warning", `${text} !`);
}

function firstPattern(selector: string): string {
	return splitSelector(selector).base.split(",").map(s => s.trim()).filter(Boolean)[0] ?? selector;
}

export async function applyProfile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	scope: Settings,
	profile: ProfileData,
): Promise<ApplyResult> {
	const res: ApplyResult = { appliedRoles: [], appliedAgents: [], skipped: [] };
	const storage = cfgModelRoleStorage.get(scope);

	for (const [role, selector] of Object.entries(profile.roles ?? {})) {
		if (!ctx.models.resolve(firstPattern(selector))) {
			res.skipped.push({ key: `@${role}`, reason: `no match for "${selector}"` });
			continue;
		}
		try {
			if (storage === "project") scope.setProjectModelRole(role, selector);
			else scope.setModelRole(role, selector);
			res.appliedRoles.push(role);
		} catch (err) {
			res.skipped.push({ key: `@${role}`, reason: err instanceof Error ? err.message : String(err) });
		}
	}

	for (const [agent, selector] of Object.entries(profile.agents ?? {})) {
		if (!ctx.models.resolve(firstPattern(selector))) {
			res.skipped.push({ key: agent, reason: `no match for "${selector}"` });
			continue;
		}
		try {
			// Mirror the /agents hub: a session-only Alt+P pick installs a whole-map
			// runtime override that would mask this saved entry. Persist, drop the
			// override for this agent only, then re-apply surviving session picks.
			const active = cfgTaskAgentModelOverrides.get(scope);
			cfgTaskAgentModelOverrides.setEntry(scope, agent, selector);
			cfgTaskAgentModelOverrides.clearOverride(scope);
			const persisted = cfgTaskAgentModelOverrides.get(scope);
			const picks: Record<string, string | string[]> = {};
			for (const [k, v] of Object.entries(active)) {
				if (k !== agent && JSON.stringify(v) !== JSON.stringify(persisted[k])) picks[k] = v;
			}
			if (Object.keys(picks).length > 0) {
				cfgTaskAgentModelOverrides.override(scope, { ...persisted, ...picks });
			}
			res.appliedAgents.push(agent);
		} catch (err) {
			res.skipped.push({ key: agent, reason: err instanceof Error ? err.message : String(err) });
		}
	}

	const defSelector = profile.roles?.["default"];
	if (defSelector) {
		const model = ctx.models.resolve(firstPattern(defSelector));
		if (!model) {
			res.skipped.push({ key: "@default (live)", reason: `no match for "${defSelector}"` });
		} else {
			try {
				const ok = await pi.setModel(model);
				if (ok) {
					res.switchedDefault = `${model.provider}/${model.id}`;
					const level = splitSelector(defSelector).thinking;
					if (level) {
						try {
							pi.setThinkingLevel(level as never);
							res.switchedThinking = level;
						} catch { /* level unsupported by this model — model default applies */ }
					}
				} else {
					res.skipped.push({ key: "@default (live)", reason: "no API key for resolved model" });
				}
			} catch (err) {
				res.skipped.push({ key: "@default (live)", reason: err instanceof Error ? err.message : String(err) });
			}
		}
	}
	return res;
}

export function formatApplyResult(name: string, res: ApplyResult): string {
	const counts: string[] = [];
	if (res.appliedRoles.length > 0) counts.push(`${res.appliedRoles.length} role${res.appliedRoles.length === 1 ? "" : "s"}`);
	if (res.appliedAgents.length > 0) counts.push(`${res.appliedAgents.length} agent${res.appliedAgents.length === 1 ? "" : "s"}`);
	if (res.switchedDefault) counts.push(`live → ${res.switchedDefault}${res.switchedThinking ? `:${res.switchedThinking}` : ""}`);
	let head = `Profile "${name}" applied`;
	if (counts.length > 0) head += ` (${counts.join(", ")})`;
	if (res.skipped.length === 0) return head;
	return `${head}. Skipped: ${res.skipped.map(s => `${s.key} (${s.reason})`).join("; ")}`;
}

// ─── key + mouse helpers (keybinding-matchers is an unresolvable subpath) ──

function bindMatches(kb: KeybindingsManager, id: string, fallback: string): (data: string) => boolean {
	return (data: string) => {
		try {
			if (kb.matches(data, id as never)) return true;
		} catch { /* unbound id */ }
		return matchesKey(data, fallback as never);
	};
}

interface HubKeys {
	up: (data: string) => boolean;
	down: (data: string) => boolean;
	pageUp: (data: string) => boolean;
	pageDown: (data: string) => boolean;
	cancel: (data: string) => boolean;
}

function hubKeys(kb: KeybindingsManager): HubKeys {
	return {
		up: bindMatches(kb, "tui.select.up", "up"),
		down: bindMatches(kb, "tui.select.down", "down"),
		pageUp: bindMatches(kb, "tui.select.pageUp", "pageUp"),
		pageDown: bindMatches(kb, "tui.select.pageDown", "pageDown"),
		cancel: bindMatches(kb, "tui.select.cancel", "escape"),
	};
}

interface HubMouse {
	wheel: -1 | 1 | null;
	motion: boolean;
	leftClick: boolean;
	col: number;
	row: number;
}

/** Minimal SGR decoder (pi-tui/mouse subpath is unresolvable from extensions). */
function decodeMouse(data: string): HubMouse | null {
	const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!m) return null;
	const b = Number(m[1]);
	const release = m[4] === "m";
	const wheel = b & 64 && !(b & 2) ? ((b & 1 ? 1 : -1) as -1 | 1) : null;
	return {
		wheel,
		motion: (b & 32) !== 0 && wheel === null,
		leftClick: !release && wheel === null && (b & 32) === 0 && (b & 3) === 0,
		col: Number(m[2]) - 1,
		row: Number(m[3]) - 1,
	};
}

// ─── fullscreen dashboard ──────────────────────────────────────────────────

type HubView = "profiles" | "roles" | "agents" | "models";
type HubPane = "side" | "main";

interface RoleRow {
	role: string;
	current: string;
	profile: string;
	stale: boolean;
}

interface PendingInput {
	title: string;
	input: Input;
	resolve: (value: string | undefined) => void;
}

const SIDEBAR_WIDTH = 26;
const ACTIONS = ["Apply", "Save current as…", "Rename", "Delete"] as const;

/**
 * Sidebar row that creates a profile. It lives in the menu as a real item so
 * every navigation path (arrows, wheel, click) reaches it; a NUL-led string
 * cannot collide with a typed profile name.
 */
export const NEW_PROFILE_ITEM = "\u0000new-profile";

/** Sidebar menu entries: saved profiles, then the create row. */
export function profileMenuItems(names: readonly string[]): string[] {
	return [...names, NEW_PROFILE_ITEM];
}

/** Profile a sidebar row names, or `undefined` when the create row is selected. */
export function profileNameOf(item: string | undefined): string | undefined {
	return !item || item === NEW_PROFILE_ITEM ? undefined : item;
}

/** First index of a `maxList`-row window centered on `selectedIndex`. */
export function windowStart(selectedIndex: number, total: number, maxList: number): number {
	return Math.max(0, Math.min(selectedIndex - Math.floor(maxList / 2), Math.max(0, total - maxList)));
}

export class ProfilesHub implements Component {
	focused = true;
	#done: (result: { applied?: string; error?: string } | undefined) => void;
	#tui: TUI;
	#theme: Theme;
	#ctx: ExtensionCommandContext;
	#pi: ExtensionAPI;
	#scope: Settings;
	#keys: HubKeys;
	#profiles: ProfilesFile;
	#view: HubView = "profiles";
	#pane: HubPane = "side";
	#profileNames: string[];
	#profilesMenu: MenuSelection<string>;
	#profileHover: string | null = null;
	#sideWindowStart = 0;
	#rolesWindowStart = 0;
	#agentsWindowStart = 0;
	#pickerWindowStart = 0;
	#actionIndex = 0;
	#roleRows: RoleRow[] = [];
	#rolesMenu: MenuSelection<string>;
	#agentRows: AgentRow[] = [];
	#agentsMenu: MenuSelection<string>;
	#picker: MenuSelection<PickerItem> | null = null;
	#pickerQuery = new Input();
	#pickerThinking: string | undefined;
	#pickerTarget: { kind: "role" | "agent"; key: string } | null = null;
	#currentSelector: string;

	/** True when the whole selector names an available model (`glm-4.7:max`), so `:max` is not a thinking level. */
	#isLiteralSelector(selector: string): boolean {
		return (this.#ctx.models.list() as Model[]).some(m => `${m.provider}/${m.id}` === selector);
	}

	/** The model a stored selector (or live role value) points at, for per-model thinking options. */
	#modelFor(selector: string | undefined): Model | undefined {
		if (!selector) return undefined;
		const { base } = splitSelector(selector, sel => this.#isLiteralSelector(sel));
		return this.#ctx.models.resolve(firstPattern(base));
	}

	/**
	 * Cycle thinking for a selector within its model's supported levels.
	 * An out-of-range stored level (deepseek has no `xhigh`) starts from its
	 * clamped equivalent, so cycling moves into the supported set instead of
	 * jumping to the head of the list.
	 */
	#cycleLevelFor(selector: string | undefined, step: number): string | undefined {
		const model = this.#modelFor(selector);
		const options = thinkingOptions(model);
		const level = this.#levelOf(selector);
		const effective = level !== undefined && !options.includes(level) ? clampThinking(level, model) : level;
		return cycleThinking(effective, step, options);
	}
	#pendingInput: PendingInput | null = null;
	#pendingDelete: string | null = null;
	#deleteIndex = 0;
	#status = "";
	#statusKind: "info" | "warning" | "error" = "info";
	#disposed = false;

	constructor(args: {
		done: (result: { applied?: string; error?: string } | undefined) => void;
		tui: TUI;
		theme: Theme;
		ctx: ExtensionCommandContext;
		pi: ExtensionAPI;
		scope: Settings;
		keys: KeybindingsManager;
		profiles: ProfilesFile;
		initialProfile?: string;
	}) {
		this.#done = args.done;
		this.#tui = args.tui;
		this.#theme = args.theme;
		this.#ctx = args.ctx;
		this.#pi = args.pi;
		this.#scope = args.scope;
		this.#keys = hubKeys(args.keys);
		this.#profiles = args.profiles;
		this.#profileNames = Object.keys(args.profiles.profiles).sort();
		this.#profilesMenu = new MenuSelection(profileMenuItems(this.#profileNames), { getKey: s => s, getSearchText: s => s });
		this.#rolesMenu = new MenuSelection<string>([], { getKey: s => s, getSearchText: s => s });
		this.#agentsMenu = new MenuSelection<string>([], { getKey: s => s, getSearchText: s => s });
		const current = this.#ctx.models.current();
		this.#currentSelector = current ? `${current.provider}/${current.id}` : "";
		if (args.initialProfile) this.#profilesMenu.setSelectedKey(args.initialProfile);
		this.#refreshRoleRows();
		void this.#refreshAgents();
	}

	get #selectedName(): string | undefined {
		return profileNameOf(this.#profilesMenu.selectedItem);
	}

	get #selectedData(): ProfileData | undefined {
		const name = this.#selectedName;
		return name ? this.#profiles.profiles[name] : undefined;
	}

	#refreshRoleRows(): void {
		const live = liveRoles(this.#scope);
		const prof = this.#selectedData?.roles ?? {};
		const roles = [...new Set([...knownRoles(this.#scope), ...Object.keys(prof)])];
		const keep = this.#rolesMenu.selectedItem;
		this.#roleRows = roles.map(role => {
			const p = prof[role] ?? "";
			const cur = live[role] ?? "";
			return { role, current: cur, profile: p, stale: p !== "" && cur !== "" && p !== cur };
		});
		this.#rolesMenu.setItems(this.#roleRows.map(r => r.role), keep);
	}

	async #refreshAgents(): Promise<void> {
		const keep = this.#agentsMenu.selectedItem;
		this.#agentRows = await agentRows(this.#ctx.cwd, this.#scope);
		this.#agentsMenu.setItems(this.#agentRows.map(a => a.name), keep);
		this.#tui.requestRender();
	}

	#persist(): void {
		try {
			saveProfiles(this.#ctx.cwd, this.#profiles);
			this.#setStatus(`Saved ${FILE_NAME}`, "info");
		} catch (err) {
			this.#setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	#setStatus(text: string, kind: "info" | "warning" | "error"): void {
		this.#status = text;
		this.#statusKind = kind;
	}

	async #applySelected(): Promise<void> {
		const name = this.#selectedName;
		const data = this.#selectedData;
		if (!name || !data) {
			this.#setStatus("No profile selected — press n to create one.", "warning");
			return;
		}
		const res = await applyProfile(this.#pi, this.#ctx, this.#scope, data);
		this.#profiles.active = name;
		this.#persist();
		this.#refreshRoleRows();
		void this.#refreshAgents();
		const summary = formatApplyResult(name, res);
		this.#setStatus(summary, res.skipped.length > 0 ? "warning" : "info");
		this.#ctx.ui.notify(summary, res.skipped.length > 0 ? "warning" : "info");
	}

	// ── layout ──

	render(width: number): readonly string[] {
		const theme = this.#theme;
		const height = Math.max(16, this.#tui.terminal?.rows ?? process.stdout.rows ?? 40);
		const sidebarW = Math.min(SIDEBAR_WIDTH, Math.max(18, width - 40));
		const bodyW = Math.max(20, width - sidebarW - 5);
		const contentRows = Math.max(10, height - 4);
		const side = this.#renderSidebar(sidebarW, contentRows);
		const body = this.#renderBody(bodyW, contentRows);
		const rows: string[] = [this.#borderTop(width, sidebarW)];
		for (let i = 0; i < contentRows; i++) {
			rows.push(this.#borderRow(side[i] ?? "", body[i] ?? "", width, sidebarW));
		}
		rows.push(theme.fg("border", `├${"─".repeat(sidebarW + 2)}┴${"─".repeat(Math.max(0, width - sidebarW - 4 - 1))}┤`));
		rows.push(this.#borderRow("", this.#footer(bodyW), width, sidebarW));
		rows.push(theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
		return rows;
	}

	#borderTop(width: number, sidebarW: number): string {
		const theme = this.#theme;
		const title = " Model Profiles ";
		const rail = sidebarW + 2;
		if (rail + 2 >= width) return theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`);
		return theme.fg("border", `╭─${title}${"─".repeat(Math.max(0, rail - title.length - 1))}┬${"─".repeat(Math.max(0, width - rail - 3))}╮`);
	}

	#borderRow(side: string, body: string, width: number, sidebarW: number): string {
		const theme = this.#theme;
		const v = theme.fg("border", "│");
		const s = truncateToWidth(side, sidebarW + 1);
		const b = truncateToWidth(body, Math.max(0, width - sidebarW - 5));
		return `${v} ${s}${" ".repeat(Math.max(0, sidebarW + 1 - visibleWidth(s)))}${v} ${b}`;
	}

	#renderSidebar(width: number, rows: number): string[] {
		const theme = this.#theme;
		const out: string[] = [];
		const items = this.#profilesMenu.visibleItems;
		const selectedItem = this.#profilesMenu.selectedItem;
		const focused = this.#pane === "side" && this.#view === "profiles" && !this.#pendingInput && this.#pendingDelete === null;
		// Window the list so the selection stays on screen; also required for the
		// trailing create row to be reachable once profiles outnumber rows.
		// Reserve the last row for the scroll counter when the list overflows.
		const listRows = items.length > rows ? Math.max(1, rows - 1) : rows;
		const start = windowStart(this.#profilesMenu.selectedIndex, items.length, Math.max(1, listRows));
		this.#sideWindowStart = start;
		const visible = items.slice(start, start + listRows);
		for (let i = 0; i < visible.length; i++) {
			const item = visible[i]!;
			const hovered = this.#profileHover === item;
			if (item === NEW_PROFILE_ITEM) {
				const selected = item === selectedItem;
				const cursor = selected && focused ? theme.fg("accent", "▸ ") : "  ";
				const label = selected && focused ? theme.bg("selectedBg", "＋ New profile") : theme.fg("dim", "＋ New profile");
				out.push(`${cursor}${hovered ? theme.bg("selectedBg", label) : label}`);
				continue;
			}
			const selected = item === selectedItem;
			const cursor = selected && focused ? theme.fg("accent", "▸ ") : "  ";
			const dot = item === this.#profiles.active ? theme.fg("success", "● ") : theme.fg("dim", "○ ");
			const bold = selected ? theme.bold(theme.fg("accent", item)) : item;
			out.push(`${cursor}${dot}${truncateToWidth(hovered ? theme.bg("selectedBg", bold) : bold, Math.max(6, width - 5))}`);
		}
		if (items.length > visible.length) {
			const above = start > 0 ? "↑" : " ";
			const below = start + visible.length < items.length ? "↓" : " ";
			const range = `${start + 1}-${start + visible.length}/${items.length}`;
			out.push(theme.fg("dim", `  ${above}${below} ${range}`));
		}
		return out.slice(0, rows);
	}

	#renderBody(width: number, rows: number): string[] {
		if (this.#pendingInput) return this.#renderInput(rows);
		if (this.#view === "models") return this.#renderPicker(width, rows);
		if (this.#view === "roles") return this.#renderRoles(rows);
		if (this.#view === "agents") return this.#renderAgents(rows);
		return this.#renderDetail(rows);
	}

	#statusRow(): string {
		const theme = this.#theme;
		const name = this.#selectedName;
		const head = name
			? `${theme.fg("accent", name)}${this.#profiles.active === name ? theme.fg("success", " ●") : ""}`
			: theme.fg("dim", this.#profilesMenu.selectedItem === NEW_PROFILE_ITEM ? "new profile" : "no profiles");
		const tab = (view: HubView, label: string) =>
			this.#view === view ? theme.fg("accent", `[${label}]`) : theme.fg("dim", ` ${label} `);
		return `${head}  ${tab("profiles", "profiles")}${tab("roles", "roles")}${tab("agents", "agents")}`;
	}

	#renderDetail(rows: number): string[] {
		const theme = this.#theme;
		const out: string[] = [this.#statusRow(), ""];
		const name = this.#selectedName;
		const data = this.#selectedData;
		if (!name || !data) {
			const count = Object.keys(this.#profiles.profiles).length;
			out.push(theme.fg("accent", "New profile"));
			out.push(theme.fg("dim", count === 0 ? "No profiles yet." : `${count} profile${count === 1 ? "" : "s"} saved.`));
			out.push("");
			out.push(`  ${theme.bold(theme.fg("text", "n"))} ${theme.fg("text", "create an empty profile, then assign models")}`);
			out.push(`  ${theme.bold(theme.fg("text", "s"))} ${theme.fg("text", "snapshot your current models as the starting point")}`);
			return out.slice(0, rows);
		}
		if (data.description) out.push(theme.fg("text", data.description));
		out.push(theme.fg("muted", `ROLES (${Object.keys(data.roles ?? {}).length})   tab → edit`));
		for (const [role, sel] of Object.entries(data.roles ?? {})) {
			const level = this.#levelOf(sel);
			const chip = thinkingChip(theme, level, thinkingOptions(this.#modelFor(sel)).includes(level));
			out.push(`  ${theme.fg("accent", `@${role}`.padEnd(12))} ${truncateToWidth(splitSelector(sel, s => this.#isLiteralSelector(s)).base, 34)} ${chip}`);
		}
		if (Object.keys(data.roles ?? {}).length === 0) out.push(theme.fg("dim", "  (empty — tab to roles, enter to assign)"));
		out.push("");
		out.push(theme.fg("muted", `AGENTS (${Object.keys(data.agents ?? {}).length})   tab ×2 → edit`));
		for (const [agent, sel] of Object.entries(data.agents ?? {})) {
			const level = this.#levelOf(sel);
			const chip = thinkingChip(theme, level, thinkingOptions(this.#modelFor(sel)).includes(level));
			out.push(`  ${theme.fg("accent", agent.padEnd(12))} ${truncateToWidth(splitSelector(sel, s => this.#isLiteralSelector(s)).base, 34)} ${chip}`);
		}
		if (Object.keys(data.agents ?? {}).length === 0) out.push(theme.fg("dim", "  (none)"));
		out.push("");
		out.push(this.#renderActions());
		if (this.#status) {
			out.push("");
			out.push(truncateToWidth(this.#theme.fg(this.#statusKind === "error" ? "error" : "warning", this.#status), 200));
		}
		return out.slice(0, rows);
	}

	#renderActions(): string {
		const theme = this.#theme;
		const focused = this.#pane === "main" && this.#view === "profiles";
		return ACTIONS.map((a, i) => {
			const selected = focused && i === this.#actionIndex;
			return selected ? theme.bg("selectedBg", `[${a}]`) : theme.fg("dim", ` ${a} `);
		}).join(" ");
	}

	#renderRoles(rows: number): string[] {
		const theme = this.#theme;
		const cursor = theme.fg("accent", "▸ ");
		const focused = this.#pane === "main" && this.#view === "roles";
		const out: string[] = [
			this.#statusRow(),
			theme.fg("muted", "ROLE        PROFILE (model · thinking) → LIVE   ←→ thinking · enter pick · ⌫ clear · esc back"),
		];
		const maxList = Math.max(1, rows - 2);
		const start = windowStart(this.#rolesMenu.selectedIndex, this.#roleRows.length, maxList);
		this.#rolesWindowStart = start;
		for (let i = start; i < Math.min(this.#roleRows.length, start + maxList); i++) {
			const r = this.#roleRows[i]!;
			const mark = i === this.#rolesMenu.selectedIndex && focused ? cursor : "  ";
			const stale = r.stale ? theme.fg("warning", "≠") : " ";
			const model = this.#modelFor(r.profile || r.current);
			const profModel = r.profile
				? theme.fg("accent", truncateToWidth(splitSelector(r.profile, sel => this.#isLiteralSelector(sel)).base, 26))
				: theme.fg("dim", "(unset)");
			const profLevel = r.profile
				? thinkingChip(theme, this.#levelOf(r.profile), thinkingOptions(model).includes(this.#levelOf(r.profile)))
				: theme.fg("dim", "—");
			const liveLevel = thinkingChip(theme, this.#levelOf(r.current), true);
			const liveModel = truncateToWidth(
				r.current ? splitSelector(r.current, sel => this.#isLiteralSelector(sel)).base : "(auto)",
				22,
			);
			out.push(
				`${mark}${theme.bold(theme.fg("text", r.role.padEnd(11)))} ${profModel} ${profLevel} ${theme.fg("dim", "→")} ${theme.fg("dim", liveModel)} ${liveLevel} ${stale}`,
			);
		}
		return out.slice(0, rows);
	}

	/** Thinking level carried by a selector, if any. */
	#levelOf(selector: string | undefined): string | undefined {
		if (!selector) return undefined;
		return splitSelector(selector, sel => this.#isLiteralSelector(sel)).thinking;
	}

	#renderAgents(rows: number): string[] {
		const theme = this.#theme;
		const cursor = theme.fg("accent", "▸ ");
		const focused = this.#pane === "main" && this.#view === "agents";
		const prof = this.#selectedData?.agents ?? {};
		const out: string[] = [this.#statusRow(), theme.fg("muted", "AGENT         PROFILE (model · thinking) → OVERRIDE   ←→ thinking · enter pick · ⌫ clear · esc back")];
		const maxList = Math.max(1, rows - 2);
		const start = windowStart(this.#agentsMenu.selectedIndex, this.#agentRows.length, maxList);
		this.#agentsWindowStart = start;
		for (let i = start; i < Math.min(this.#agentRows.length, start + maxList); i++) {
			const a = this.#agentRows[i]!;
			const mark = i === this.#agentsMenu.selectedIndex && focused ? cursor : "  ";
			const p = prof[a.name];
			const stale = p !== undefined && p !== (a.override ?? "") ? theme.fg("warning", "≠") : " ";
			const model = this.#modelFor(p ?? a.override);
			const pModel = p
				? theme.fg("accent", truncateToWidth(splitSelector(p, sel => this.#isLiteralSelector(sel)).base, 26))
				: theme.fg("dim", "(inherit)");
			const pLevel = p
				? thinkingChip(theme, this.#levelOf(p), thinkingOptions(model).includes(this.#levelOf(p)))
				: theme.fg("dim", "—");
			const oLevel = thinkingChip(theme, this.#levelOf(a.override), true);
			const oModel = truncateToWidth(
				a.override ? splitSelector(a.override, sel => this.#isLiteralSelector(sel)).base : "(none)",
				22,
			);
			out.push(
				`${mark}${theme.bold(theme.fg("text", truncateToWidth(a.name, 12).padEnd(13)))} ${pModel} ${pLevel} ${theme.fg("dim", "→")} ${theme.fg("dim", oModel)} ${oLevel} ${stale}`,
			);
		}
		if (this.#agentRows.length === 0) out.push(theme.fg("dim", "No agents discovered."));
		return out.slice(0, rows);
	}

	#renderPicker(width: number, rows: number): string[] {
		const theme = this.#theme;
		const target = this.#pickerTarget;
		const label = target ? (target.kind === "role" ? `@${target.key}` : target.key) : "";
		const highlighted = this.#picker?.selectedItem?.model;
		const options = thinkingOptions(highlighted);
		const chip = thinkingChip(theme, this.#pickerThinking, options.includes(this.#pickerThinking));
		const out: string[] = [
			this.#statusRow(),
			`${theme.fg("accent", label)} ${theme.fg("dim", "thinking")} ${chip} ${theme.fg("dim", "←→")} ${theme.fg("dim", `· ${this.#supportedHint(options)} · type to filter · enter pick · esc back`)}`,
		];
		this.#pickerQuery.focused = true;
		out.push(...this.#pickerQuery.render(Math.max(16, width - 4)).map(l => `  ${l}`));
		const items = this.#picker?.visibleItems ?? [];
		const selIdx = this.#picker?.selectedIndex ?? -1;
		const maxList = Math.max(3, rows - 6);
		const start = windowStart(selIdx, items.length, maxList);
		this.#pickerWindowStart = start;
		for (let i = start; i < Math.min(items.length, start + maxList); i++) {
			const item = items[i]!;
			const selected = i === selIdx;
			const mark = selected ? theme.fg("accent", "▸ ") : "  ";
			const current = item.selector === this.#currentSelector ? theme.fg("success", " ●") : "";
			const text = `${item.provider}/${item.id}`;
			const levels = item.model.reasoning ? theme.fg("dim", `  ${this.#supportedHint(thinkingOptions(item.model))}`) : "";
			out.push(`${mark}${truncateToWidth(selected ? theme.fg("accent", text) : text, Math.max(12, width - 26))}${current}${levels}`);
		}
		if (items.length === 0) out.push(theme.fg("dim", "  No matches."));
		return out.slice(0, rows);
	}

	#renderInput(rows: number): string[] {
		const theme = this.#theme;
		const p = this.#pendingInput;
		if (!p) return [];
		p.input.focused = true;
		return [
			this.#statusRow(),
			"",
			`  ${theme.fg("accent", p.title)}`,
			"",
			...p.input.render(48).map(l => `  ${l}`),
			"",
			theme.fg("dim", "  enter confirm · esc cancel"),
		].slice(0, rows);
	}

	#footer(width: number): string {
		const theme = this.#theme;
		if (this.#pendingDelete !== null) {
			const no = this.#deleteIndex === 0 ? theme.bg("selectedBg", "[No]") : theme.fg("dim", " No ");
			const yes = this.#deleteIndex === 1 ? theme.bg("selectedBg", "[Yes]") : theme.fg("dim", " Yes ");
			return truncateToWidth(`Delete "${this.#pendingDelete}"?  ${no} ${yes}    y/n · ←→ · enter`, width);
		}
		let hint = "↑↓ profile · ←→ pane · enter apply · r roles · a agents · s snapshot · n new · tab view · esc close";
		if (this.#view === "models") hint = "←→ thinking · type filter · ↑↓ navigate · enter pick · esc back";
		else if (this.#view === "roles") hint = "↑↓ role · ←→ thinking · enter pick model · ⌫ clear · tab agents · esc back";
		else if (this.#view === "agents") hint = "↑↓ agent · ←→ thinking · enter pick model · ⌫ clear · tab profiles · esc back";
		return truncateToWidth(theme.fg("dim", hint), width);
	}

	// ── input ──

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (data.startsWith("\x1b[<")) {
			const ev = decodeMouse(data);
			if (ev) this.#handleMouse(ev);
			return;
		}
		if (this.#pendingInput) {
			this.#pendingInput.input.handleInput(data);
			return;
		}
		if (this.#pendingDelete !== null) {
			this.#deleteInput(data);
			return;
		}
		if (this.#view === "models") {
			this.#pickerInput(data);
			return;
		}
		if (matchesKey(data, "tab")) {
			this.#cycleView();
			return;
		}
		if (this.#keys.cancel(data)) {
			if (this.#view === "profiles") this.#close();
			else {
				this.#view = "profiles";
				this.#pane = "side";
			}
			return;
		}
		if (this.#view === "roles") {
			this.#rolesInput(data);
			return;
		}
		if (this.#view === "agents") {
			this.#agentsInput(data);
			return;
		}
		if (matchesKey(data, "left")) {
			this.#pane = "side";
			return;
		}
		if (matchesKey(data, "right")) {
			this.#pane = "main";
			return;
		}
		if (this.#pane === "side") {
			this.#sidebarInput(data);
			return;
		}
		this.#bodyInput(data);
	}

	#cycleView(): void {
		if (this.#view === "profiles") {
			this.#view = "roles";
			this.#pane = "main";
			this.#refreshRoleRows();
		} else if (this.#view === "roles") {
			this.#view = "agents";
			this.#pane = "main";
			void this.#refreshAgents();
		} else {
			this.#view = "profiles";
			this.#pane = "side";
		}
	}

	#sidebarInput(data: string): void {
		if (this.#keys.up(data)) {
			this.#profilesMenu.move(-1, true);
			this.#refreshRoleRows();
			void this.#refreshAgents();
			return;
		}
		if (this.#keys.down(data)) {
			this.#profilesMenu.move(1, true);
			this.#refreshRoleRows();
			void this.#refreshAgents();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.#selectedName) void this.#applySelected();
			else void this.#newProfileFlow();
			return;
		}
		if (matchesKey(data, "s")) { void this.#saveCurrentFlow(); return; }
		if (matchesKey(data, "n")) { void this.#newProfileFlow(); }
	}

	#bodyInput(data: string): void {
		if (matchesKey(data, "left") || this.#keys.up(data)) {
			this.#actionIndex = (this.#actionIndex - 1 + ACTIONS.length) % ACTIONS.length;
			return;
		}
		if (matchesKey(data, "right") || this.#keys.down(data)) {
			this.#actionIndex = (this.#actionIndex + 1) % ACTIONS.length;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.#activateAction(ACTIONS[this.#actionIndex] ?? "Apply");
			return;
		}
		if (matchesKey(data, "r")) { this.#view = "roles"; this.#refreshRoleRows(); return; }
		if (matchesKey(data, "a")) { this.#view = "agents"; void this.#refreshAgents(); return; }
		if (matchesKey(data, "s")) { void this.#saveCurrentFlow(); return; }
		if (matchesKey(data, "n")) { void this.#newProfileFlow(); }
	}

	#activateAction(action: string): void {
		if (action === "Apply") {
			if (this.#selectedName) void this.#applySelected();
			else void this.#newProfileFlow();
		} else if (action.startsWith("Save")) {
			void this.#saveCurrentFlow();
		} else if (action === "Rename") {
			void this.#renameFlow();
		} else {
			void this.#deleteFlow();
		}
	}

	#rolesInput(data: string): void {
		if (this.#keys.up(data)) { this.#rolesMenu.move(-1, true); return; }
		if (this.#keys.down(data)) { this.#rolesMenu.move(1, true); return; }
		if (this.#keys.pageUp(data)) {
			for (let i = 0; i < 10; i++) this.#rolesMenu.move(-1, false);
			return;
		}
		if (this.#keys.pageDown(data)) {
			for (let i = 0; i < 10; i++) this.#rolesMenu.move(1, false);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const role = this.#rolesMenu.selectedItem;
			if (role) this.#openModelPicker({ kind: "role", key: role });
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const role = this.#rolesMenu.selectedItem;
			if (role) this.#cycleRoleThinking(role, matchesKey(data, "right") ? 1 : -1);
			return;
		}
		if (matchesKey(data, "backspace")) {
			const role = this.#rolesMenu.selectedItem;
			const name = this.#selectedName;
			const roles = name ? this.#profiles.profiles[name]?.roles : undefined;
			if (role && name && roles?.[role] !== undefined) {
				delete roles[role];
				this.#persist();
				this.#refreshRoleRows();
				this.#setStatus(`@${role} cleared from "${name}"`, "info");
			}
		}
	}

	#agentsInput(data: string): void {
		if (this.#keys.up(data)) { this.#agentsMenu.move(-1, true); return; }
		if (this.#keys.down(data)) { this.#agentsMenu.move(1, true); return; }
		if (this.#keys.pageUp(data)) {
			for (let i = 0; i < 10; i++) this.#agentsMenu.move(-1, false);
			return;
		}
		if (this.#keys.pageDown(data)) {
			for (let i = 0; i < 10; i++) this.#agentsMenu.move(1, false);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const agent = this.#agentsMenu.selectedItem;
			if (agent) this.#openModelPicker({ kind: "agent", key: agent });
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const agent = this.#agentsMenu.selectedItem;
			if (agent) this.#cycleAgentThinking(agent, matchesKey(data, "right") ? 1 : -1);
			return;
		}
		if (matchesKey(data, "backspace")) {
			const agent = this.#agentsMenu.selectedItem;
			const name = this.#selectedName;
			const agents = name ? this.#profiles.profiles[name]?.agents : undefined;
			if (agent && name && agents?.[agent] !== undefined) {
				delete agents[agent];
				this.#persist();
				this.#setStatus(`${agent} cleared from "${name}"`, "info");
			}
		}
	}

	#pickerInput(data: string): void {
		if (this.#keys.cancel(data)) {
			if (this.#pickerQuery.getValue().length > 0) {
				this.#pickerQuery.setValue("");
				this.#applyPickerFilter();
				return;
			}
			this.#closeModelPicker();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const item = this.#picker?.selectedItem;
			if (item) this.#commitModelPick(item);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const model = this.#picker?.selectedItem?.model;
			const options = thinkingOptions(model);
			this.#pickerThinking = cycleThinking(
				clampThinking(this.#pickerThinking, model),
				matchesKey(data, "right") ? 1 : -1,
				options,
			);
			this.#setStatus(
				`thinking ${this.#pickerThinking ?? "inherit"} — supported: ${this.#supportedHint(options)}`,
				"info",
			);
			return;
		}
		if (this.#keys.up(data)) {
			this.#picker?.move(-1, true);
			this.#clampPickerThinking();
			return;
		}
		if (this.#keys.down(data)) {
			this.#picker?.move(1, true);
			this.#clampPickerThinking();
			return;
		}
		if (this.#keys.pageUp(data)) {
			for (let i = 0; i < 10; i++) this.#picker?.move(-1, false);
			return;
		}
		if (this.#keys.pageDown(data)) {
			for (let i = 0; i < 10; i++) this.#picker?.move(1, false);
			return;
		}
		const before = this.#pickerQuery.getValue();
		this.#pickerQuery.handleInput(data);
		if (this.#pickerQuery.getValue() !== before) this.#applyPickerFilter();
	}

	/** Rotate a role's thinking suffix in the profile (no model re-pick needed). */
	#cycleRoleThinking(role: string, step: number): void {
		const name = this.#selectedName;
		if (!name) {
			this.#setStatus("Save a profile first (s).", "warning");
			return;
		}
		const profiles = this.#profiles.profiles;
		const p = profiles[name] ?? (profiles[name] = {});
		p.roles ??= {};
		const current = p.roles[role] ?? liveRoles(this.#scope)[role] ?? "";
		if (!current) {
			this.#setStatus(`@${role} has no model yet — enter to pick one.`, "warning");
			return;
		}
		p.roles[role] = withThinking(current, this.#cycleLevelFor(current, step), sel => this.#isLiteralSelector(sel));
		this.#persist();
		this.#refreshRoleRows();
		this.#setStatus(`@${role} → ${p.roles[role]}`, "info");
	}

	/** Rotate an agent override's thinking suffix in the profile. */
	#cycleAgentThinking(agent: string, step: number): void {
		const name = this.#selectedName;
		if (!name) {
			this.#setStatus("Save a profile first (s).", "warning");
			return;
		}
		const profiles = this.#profiles.profiles;
		const p = profiles[name] ?? (profiles[name] = {});
		p.agents ??= {};
		const current = p.agents[agent] ?? this.#agentRows.find(r => r.name === agent)?.override ?? "";
		if (!current) {
			this.#setStatus(`${agent} has no override yet — enter to pick a model.`, "warning");
			return;
		}
		p.agents[agent] = withThinking(current, this.#cycleLevelFor(current, step), sel => this.#isLiteralSelector(sel));
		this.#persist();
		this.#setStatus(`${agent} → ${p.agents[agent]}`, "info");
	}

	#deleteInput(data: string): void {
		if (this.#keys.cancel(data) || matchesKey(data, "n")) {
			this.#pendingDelete = null;
			return;
		}
		if (matchesKey(data, "y")) {
			this.#commitDelete();
			return;
		}
		if (matchesKey(data, "left")) { this.#deleteIndex = 0; return; }
		if (matchesKey(data, "right")) { this.#deleteIndex = 1; return; }
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.#deleteIndex === 1) this.#commitDelete();
			else this.#pendingDelete = null;
		}
	}

	#handleMouse(ev: HubMouse): void {
		if (this.#pendingInput) return;
		if (ev.motion) {
			if (ev.col < SIDEBAR_WIDTH + 2 && this.#view !== "models") {
				const items = this.#profilesMenu.visibleItems;
				const idx = ev.row - 1 + this.#sideWindowStart;
				this.#profileHover = idx >= 0 && idx < items.length ? items[idx]! : null;
			} else {
				this.#profileHover = null;
			}
			return;
		}
		if (ev.wheel !== null) {
			if (this.#pendingDelete !== null) return;
			if (this.#view === "models") { this.#picker?.move(ev.wheel, false); return; }
			if (this.#view === "roles") { this.#rolesMenu.move(ev.wheel, false); return; }
			if (this.#view === "agents") { this.#agentsMenu.move(ev.wheel, false); return; }
			this.#profilesMenu.setSelectedIndex(this.#profilesMenu.selectedIndex + ev.wheel);
			this.#refreshRoleRows();
			void this.#refreshAgents();
			return;
		}
		if (!ev.leftClick) return;
		if (this.#pendingDelete !== null) {
			if (ev.col > 0) this.#commitDelete();
			return;
		}
		if (this.#view === "models") {
			const idx = ev.row - 4 + this.#pickerWindowStart;
			if (idx >= 0) {
				const item = this.#picker?.visibleItems[idx];
				if (item) {
					if (this.#picker?.selectedItem === item) this.#commitModelPick(item);
					else this.#picker?.setSelectedKey(item.selector);
				}
			}
			return;
		}
		const onSidebar = ev.col < SIDEBAR_WIDTH + 2;
		if (onSidebar) {
			const items = this.#profilesMenu.visibleItems;
			const idx = ev.row - 1 + this.#sideWindowStart;
			const item = idx >= 0 ? items[idx] : undefined;
			if (item === NEW_PROFILE_ITEM) {
				void this.#newProfileFlow();
			} else if (item !== undefined) {
				if (item === this.#selectedName && this.#view === "profiles") void this.#applySelected();
				else {
					this.#profilesMenu.setSelectedKey(item);
					this.#pane = "side";
					this.#view = "profiles";
					this.#refreshRoleRows();
					void this.#refreshAgents();
				}
			}
			return;
		}
		if (this.#view === "roles") {
			const idx = ev.row - 3 + this.#rolesWindowStart;
			const role = idx >= 0 ? this.#roleRows[idx]?.role : undefined;
			if (role) {
				if (this.#rolesMenu.selectedItem === role) this.#openModelPicker({ kind: "role", key: role });
				else this.#rolesMenu.setSelectedKey(role);
			}
		} else if (this.#view === "agents") {
			const idx = ev.row - 3 + this.#agentsWindowStart;
			const agent = idx >= 0 ? this.#agentRows[idx]?.name : undefined;
			if (agent) {
				if (this.#agentsMenu.selectedItem === agent) this.#openModelPicker({ kind: "agent", key: agent });
				else this.#agentsMenu.setSelectedKey(agent);
			}
		}
	}

	/** Clamp the pending thinking level to the highlighted model's supported set. */
	#clampPickerThinking(): void {
		const model = this.#picker?.selectedItem?.model;
		const options = thinkingOptions(model);
		if (this.#pickerThinking !== undefined && !options.includes(this.#pickerThinking)) {
			this.#pickerThinking = clampThinking(this.#pickerThinking, model);
		}
	}

	/** Human hint of a model's supported efforts for the picker header. */
	#supportedHint(options: readonly (string | undefined)[]): string {
		const concrete = options.filter((o): o is string => o !== undefined && o !== "off" && o !== AUTO_LEVEL);
		return concrete.length > 0 ? concrete.join(" · ") : "no levels";
	}

	// ── model picker ──

	#pickerModels(target: { kind: "role" | "agent"; key: string }): PickerItem[] {
		const all: PickerItem[] = (this.#ctx.models.list() as Model[]).map(m => ({
			selector: `${m.provider}/${m.id}`,
			provider: m.provider,
			id: m.id,
			model: m,
		}));
		try {
			const info = getRoleInfo(target.key, this.#scope);
			const filtered = all.filter(item => {
				const model = (this.#ctx.models.list() as Model[]).find(m => `${m.provider}/${m.id}` === item.selector);
				if (!model) return true;
				try {
					return info.accepts(model);
				} catch {
					return true;
				}
			});
			if (filtered.length > 0) return filtered;
		} catch { /* keep unfiltered */ }
		return all;
	}

	#openModelPicker(target: { kind: "role" | "agent"; key: string }): void {
		const name = this.#selectedName;
		if (!name) {
			this.#setStatus("Save a profile first (s).", "warning");
			return;
		}
		this.#picker = new MenuSelection(this.#pickerModels(target), {
			getKey: item => item.selector,
			getSearchText: item => `${item.provider}/${item.id}`,
		});
		this.#pickerQuery.setValue("");
		this.#pickerTarget = target;
		this.#view = "models";
		this.#pane = "main";
		const stored = target.kind === "role"
			? (this.#profiles.profiles[name]?.roles?.[target.key] ?? liveRoles(this.#scope)[target.key] ?? "")
			: (this.#profiles.profiles[name]?.agents?.[target.key]
				?? this.#agentRows.find(r => r.name === target.key)?.override
				?? "");
		const parsed = splitSelector(stored, sel => this.#isLiteralSelector(sel));
		this.#pickerThinking = parsed.thinking;
		if (stored) this.#picker.setSelectedKey(parsed.base);
		this.#setStatus(stored ? `editing ${target.kind === "role" ? `@${target.key}` : target.key} — ←→ thinking` : "", "info");
	}

	#applyPickerFilter(): void {
		const picker = this.#picker;
		const target = this.#pickerTarget;
		if (!picker || !target) return;
		picker.setItems(this.#pickerModels(target));
		picker.setQuery(this.#pickerQuery.getValue());
	}

	#commitModelPick(item: PickerItem): void {
		const name = this.#selectedName;
		const target = this.#pickerTarget;
		if (!name || !target) return;
		const profiles = this.#profiles.profiles;
		const p = profiles[name] ?? (profiles[name] = {});
		const selector = item.selector;
		if (target.kind === "role") {
			p.roles ??= {};
			p.roles[target.key] = withThinking(selector, this.#pickerThinking, sel => this.#isLiteralSelector(sel));
			this.#setStatus(`@${target.key} → ${p.roles[target.key]}`, "info");
		} else {
			p.agents ??= {};
			p.agents[target.key] = withThinking(selector, this.#pickerThinking, sel => this.#isLiteralSelector(sel));
			this.#setStatus(`${target.key} → ${p.agents[target.key]}`, "info");
		}
		this.#persist();
		this.#closeModelPicker();
		this.#refreshRoleRows();
	}

	#closeModelPicker(): void {
		const wasAgent = this.#pickerTarget?.kind === "agent";
		this.#picker = null;
		this.#pickerQuery.setValue("");
		this.#pickerTarget = null;
		this.#view = wasAgent ? "agents" : "roles";
		this.#pane = "main";
	}

	// ── inline prompts ──

	#askInput(title: string, prefill?: string): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const input = new Input();
		if (prefill) input.setValue(prefill);
		input.onSubmit = value => this.#resolveInput(value);
		input.onEscape = () => this.#resolveInput(undefined);
		this.#pendingInput = { title, input, resolve };
		this.#tui.requestRender();
		return promise;
	}

	#resolveInput(value: string | undefined): void {
		const p = this.#pendingInput;
		this.#pendingInput = null;
		p?.resolve(value);
	}

	async #saveCurrentFlow(): Promise<void> {
		const live = liveRoles(this.#scope);
		if (Object.keys(live).length === 0) {
			this.#setStatus("No configured roles to snapshot.", "warning");
			return;
		}
		const name = await this.#askInput("Snapshot current models as profile", this.#selectedName ?? "");
		if (!name?.trim()) return;
		const key = name.trim();
		const prev = this.#profiles.profiles[key] ?? {};
		this.#profiles.profiles[key] = { ...prev, roles: { ...live } };
		this.#syncNames(key);
		this.#persist();
		this.#setStatus(`Snapshotted ${Object.keys(live).length} roles as "${key}"`, "info");
	}

	async #newProfileFlow(): Promise<void> {
		const name = await this.#askInput("New profile name");
		if (!name?.trim()) return;
		const key = name.trim();
		if (/[\u0000-\u001f]/.test(key)) {
			this.#setStatus("Profile names cannot contain control characters.", "warning");
			return;
		}
		if (this.#profiles.profiles[key]) {
			this.#setStatus(`Profile "${key}" already exists.`, "warning");
			return;
		}
		this.#profiles.profiles[key] = { roles: { ...liveRoles(this.#scope) } };
		this.#syncNames(key);
		this.#persist();
	}

	async #renameFlow(): Promise<void> {
		const old = this.#selectedName;
		if (!old) {
			this.#setStatus("No profile selected.", "warning");
			return;
		}
		const name = await this.#askInput("Rename profile", old);
		if (!name?.trim() || name.trim() === old) return;
		const key = name.trim();
		if (this.#profiles.profiles[key]) {
			this.#setStatus(`Profile "${key}" already exists.`, "warning");
			return;
		}
		this.#profiles.profiles[key] = this.#profiles.profiles[old]!;
		delete this.#profiles.profiles[old];
		if (this.#profiles.active === old) this.#profiles.active = key;
		this.#syncNames(key);
		this.#persist();
	}

	async #deleteFlow(): Promise<void> {
		const name = this.#selectedName;
		if (!name) {
			this.#setStatus("No profile selected.", "warning");
			return;
		}
		this.#pendingDelete = name;
		this.#deleteIndex = 0;
		this.#tui.requestRender();
	}

	#commitDelete(): void {
		const name = this.#pendingDelete;
		this.#pendingDelete = null;
		if (!name) return;
		delete this.#profiles.profiles[name];
		if (this.#profiles.active === name) delete this.#profiles.active;
		this.#syncNames();
		this.#persist();
		this.#setStatus(`Deleted "${name}"`, "info");
	}

	#syncNames(select?: string): void {
		this.#profileNames = Object.keys(this.#profiles.profiles).sort();
		this.#profilesMenu.setItems(profileMenuItems(this.#profileNames), select ?? this.#profilesMenu.selectedKey);
		this.#refreshRoleRows();
		void this.#refreshAgents();
	}

	#close(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.dispose();
		this.#done(undefined);
	}

	dispose(): void {
		this.#picker = null;
	}
}

interface PickerItem {
	selector: string;
	provider: string;
	id: string;
	model: Model;
}

// ─── commands ──────────────────────────────────────────────────────────────

async function openHub(pi: ExtensionAPI, ctx: ExtensionCommandContext, initialProfile?: string): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		await headlessFlow(pi, ctx, initialProfile);
		return;
	}
	const scope = pi.pi.settings as Settings;
	const profiles = loadProfiles(ctx.cwd);
	try {
		await ctx.ui.custom<{ applied?: string; error?: string } | undefined>(
			(tui, theme, kb, done) =>
				new ProfilesHub({
					done,
					tui,
					theme,
					ctx,
					pi,
					scope,
					keys: kb,
					profiles,
					initialProfile,
				}),
			{
				overlay: true,
				overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true },
			},
		);
	} catch (err) {
		ctx.ui.notify(`Model profiles failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function headlessFlow(pi: ExtensionAPI, ctx: ExtensionCommandContext, initialProfile?: string): Promise<void> {
	const scope = pi.pi.settings as Settings;
	const profiles = loadProfiles(ctx.cwd);
	const names = Object.keys(profiles.profiles);
	if (names.length === 0) {
		ctx.ui.notify(
			"No profiles yet. Open the dashboard in the TUI (/profiles) and press s to snapshot your current models.",
			"warning",
		);
		return;
	}
	let name = initialProfile;
	if (!name) {
		name = await ctx.ui.select("Apply profile", names);
		if (!name) return;
	}
	await applyNamed(pi, ctx, scope, profiles, name);
}

async function applyNamed(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	scope: Settings,
	profiles: ProfilesFile,
	name: string,
): Promise<void> {
	const data = profiles.profiles[name];
	if (!data) {
		const known = Object.keys(profiles.profiles);
		ctx.ui.notify(`Unknown profile "${name}". Known: ${known.join(", ") || "(none)"}`, "error");
		return;
	}
	const res = await applyProfile(pi, ctx, scope, data);
	profiles.active = name;
	try {
		saveProfiles(ctx.cwd, profiles);
	} catch (err) {
		ctx.ui.notify(`Profile applied but could not be saved: ${err instanceof Error ? err.message : String(err)}`, "warning");
	}
	ctx.ui.notify(formatApplyResult(name, res), res.skipped.length > 0 ? "warning" : "info");
}

async function applyByName(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	const scope = pi.pi.settings as Settings;
	const profiles = loadProfiles(ctx.cwd);
	const names = Object.keys(profiles.profiles);
	const want = args.trim();
	if (want) {
		await applyNamed(pi, ctx, scope, profiles, want);
		return;
	}
	if (names.length === 0) {
		ctx.ui.notify(
			"No profiles yet. Open the dashboard in the TUI (/profiles) and press s to snapshot your current models.",
			"warning",
		);
		return;
	}
	const picked = await ctx.ui.select("Apply profile", names);
	if (!picked) return;
	await applyNamed(pi, ctx, scope, profiles, picked);
}

// ─── extension entry ───────────────────────────────────────────────────────

export default function modelProfiles(pi: ExtensionAPI): void {
	pi.setLabel("Model Profiles");

	pi.registerCommand("profiles", {
		description: "Model profiles: no args opens the dashboard; /profiles <name> applies a profile",
		getArgumentCompletions: prefix => {
			let profiles: ProfilesFile;
			try {
				profiles = loadProfiles(process.cwd());
			} catch {
				return null;
			}
			const items = Object.keys(profiles.profiles)
				.filter(name => name.startsWith(prefix))
				.map(name => ({
					value: name,
					label: name === profiles.active ? `${name} ●` : name,
					description: profiles.profiles[name]?.description,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const want = args.trim();
			if (want) await applyByName(pi, ctx, want);
			else await openHub(pi, ctx);
		},
	});
}
