import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	hyperlink,
	Key,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
type SessionWithUsage = ExtensionContext["sessionManager"] & {
	appendUsage?: (kind: string, provider: string, model: string, usage: Usage) => unknown;
};
type Light = "green" | "amber" | "red";
type Phase = "idle" | "working" | "failed";
type Outcome = "completed" | "aborted" | "error";
interface AndonData {
	title?: string;
	titleSource?: "auto" | "user" | "model";
	summary?: string;
	overrideState?: Light;
	visible?: boolean;
}
interface AndonState {
	v: 1;
	light: Light;
	word: string;
	pulsing: boolean;
	objective?: string;
	title?: string;
	waitUntil?: string;
}
interface Resolved {
	light: Light;
	word: string;
	pulsing: boolean;
}
interface SupervisorUpdate {
	sessionId?: string;
	state?: Light;
	objective?: string;
	note?: string;
	label?: string;
}
interface SupervisorState {
	state: Light;
	objective?: string;
	note?: string;
	label: string;
	at: number;
}
interface PullRequest {
	number: number;
	title: string;
	url: string;
	draft: boolean;
}
interface RepoRef {
	root: string;
	headPath: string;
}
const PULSE_FRAMES = ["●", "◉"];
const LIGHT_EMOJI: Record<Light, string> = { green: "🟢", amber: "🟠", red: "🔴" };
const LIGHT_TOKEN: Record<Light, "success" | "warning" | "error"> = {
	green: "success",
	amber: "warning",
	red: "error",
};
const AUTO_WAIT_MS = 3 * 60000;
const WAIT_AMBER_FRACTION = 0.8;
const WAIT_AMBER_MIN_MS = 30000;
const CLEAR_WAIT = new Set(["0", "off", "none", "clear", "stop"]);
const SUPERVISOR_FRESH_MS = 10 * 60000;
const SUMMARY_GRACE_MS = 3 * 60000;
const TPS_WINDOW_MS = 2000;
const TPS_STALE_MS = 3000;
const TPS_MIN_SPAN_MS = 300;
const TPS_TICK_MS = 200;
const CHARS_PER_TOKEN = 3.8;
const PR_MAX_AGE_MS = 5 * 60000;
const PR_TIMEOUT_MS = 8000;
const PR_COMMAND = /\b(?:gh\s+pr|git\s+(?:checkout|switch|worktree))\b/;
class AndonCard {
	constructor(
		private readonly getTheme: () => Theme,
		private readonly draw: (theme: Theme, width: number) => string[],
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.draw(this.getTheme(), width);
	}
}
function truncatePlain(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) {
		const seconds = total % 60;
		return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
function plainText(text: string, max: number): string {
	return truncatePlain(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "), max);
}
function parseDuration(input: string): number | undefined {
	const match = input.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
	if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2] ?? 0);
	const seconds = Number(match[3] ?? 0);
	return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}
function findRepo(cwd: string): RepoRef | undefined {
	let dir = cwd;
	for (;;) {
		const dotGit = join(dir, ".git");
		try {
			if (statSync(dotGit).isDirectory()) return { root: dir, headPath: join(dotGit, "HEAD") };
			const match = /^gitdir:\s*(.+)$/.exec(readFileSync(dotGit, "utf8").trim());
			if (match) return { root: dir, headPath: join(resolve(dir, match[1]), "HEAD") };
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
function readBranch(headPath: string): string | undefined {
	try {
		return /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(headPath, "utf8").trim())?.[1];
	} catch {
		return undefined;
	}
}
function toolCommand(args: unknown): string | undefined {
	const command = (
		args as
			| {
					command?: unknown;
			  }
			| undefined
	)?.command;
	return typeof command === "string" ? command : undefined;
}
async function summarisePrompt(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
	if (!ctx.model) return undefined;
	try {
		const stream = ctx.modelRegistry.streamSimple(
			ctx.model,
			{
				systemPrompt:
					"You write very short session titles. Reply with only 3-6 words, no quotes, no trailing punctuation.",
				messages: [
					{
						role: "user",
						content: `Title for this coding task:\n\n${prompt.slice(0, 4000)}`,
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: 32, temperature: 0 },
		);
		const message = await stream.result();
		(ctx.sessionManager as SessionWithUsage).appendUsage?.(
			"gemba",
			message.provider,
			message.responseModel ?? message.model,
			message.usage,
		);
		const text = message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join(" ")
			.trim();
		const cleaned = text
			.split("\n")[0]
			?.replace(/^["'`*\s]+/, "")
			.replace(/["'`*.\s]+$/, "")
			.trim();
		return cleaned ? truncatePlain(cleaned, 60) : undefined;
	} catch {
		return undefined;
	}
}
export default function andonExtension(pi: ExtensionAPI): void {
	let title: string | undefined;
	let titleSource: "auto" | "user" | "model" = "auto";
	let summary: string | undefined;
	let overrideState: Light | undefined;
	let visible = true;
	let phase: Phase = "idle";
	let lastOutcome: Outcome | undefined;
	let activeTools = new Map<
		string,
		{
			name: string;
			startedAt: number;
			command?: string;
		}
	>();
	let wait:
		| {
				startedAt: number;
				expectedMs: number;
				toolCallId?: string;
		  }
		| undefined;
	let uiPrompt:
		| {
				kind: string;
				title?: string;
		  }
		| undefined;
	let contextPercent: number | undefined;
	let summaryAt = 0;
	let supervisor: SupervisorState | undefined;
	let pullRequest: PullRequest | undefined;
	let prBranch: string | undefined;
	let prCheckedAt = 0;
	let prLooking = false;
	let deltas: {
		at: number;
		chars: number;
	}[] = [];
	let pulseTps:
		| {
				value: number;
				at: number;
		  }
		| undefined;
	let tpsShown:
		| {
				value: number;
				at: number;
		  }
		| undefined;
	let frame = 0;
	let generation = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;
	let lastBroadcast = "";
	let lastRecorded = "";
	let widgetShown = false;
	let cardTui: TUI | undefined;
	let lastTitleText: string | undefined;
	function displayName(): string {
		return title ?? summary ?? pi.getSessionName() ?? "";
	}
	function waitTarget(): string | undefined {
		return [...activeTools.entries()].filter(([, tool]) => tool.name !== "set_andon").at(-1)?.[0];
	}
	function waitAmberElapsed(): number | undefined {
		if (!wait) return undefined;
		const elapsed = Date.now() - wait.startedAt;
		const threshold = Math.max(wait.expectedMs * WAIT_AMBER_FRACTION, WAIT_AMBER_MIN_MS);
		return elapsed >= threshold ? elapsed : undefined;
	}
	function slowToolElapsed(): number | undefined {
		if (wait) return undefined;
		for (const tool of activeTools.values()) {
			const elapsed = Date.now() - tool.startedAt;
			if (elapsed >= AUTO_WAIT_MS) return elapsed;
		}
		return undefined;
	}
	function baseLight(): Resolved {
		if (uiPrompt) return { light: "red", word: "needs you", pulsing: true };
		if (phase === "failed") {
			return { light: "red", word: lastOutcome === "aborted" ? "stopped" : "broken", pulsing: true };
		}
		if (overrideState === "red") return { light: "red", word: "needs you", pulsing: true };
		if (waitAmberElapsed() !== undefined) return { light: "amber", word: "waiting", pulsing: false };
		if (slowToolElapsed() !== undefined) return { light: "amber", word: "slow", pulsing: false };
		if (overrideState === "amber") return { light: "amber", word: "waiting", pulsing: false };
		if (phase === "working") return { light: "green", word: "working", pulsing: true };
		return { light: "green", word: "ready", pulsing: false };
	}
	function supervisorFresh(): SupervisorState | undefined {
		if (!supervisor) return undefined;
		return Date.now() - supervisor.at <= SUPERVISOR_FRESH_MS ? supervisor : undefined;
	}
	function supervisorEscalation(): SupervisorState | undefined {
		const update = supervisorFresh();
		if (!update || overrideState !== undefined) return undefined;
		if (phase !== "working" && wait === undefined) return undefined;
		const base = baseLight();
		if (update.state === "red" && base.light !== "red") return update;
		if (update.state === "amber" && base.light === "green") return update;
		return undefined;
	}
	function resolveLight(): Resolved {
		const base = baseLight();
		const escalation = supervisorEscalation();
		if (!escalation) return base;
		if (escalation.state === "red") return { light: "red", word: "flagged", pulsing: true };
		return { light: "amber", word: "stalled", pulsing: false };
	}
	function currentObjective(): string | undefined {
		if (summary && Date.now() - summaryAt <= SUMMARY_GRACE_MS) return summary;
		return supervisorFresh()?.objective ?? summary;
	}
	async function refreshPullRequest(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || prLooking) return;
		prCheckedAt = Date.now();
		const repo = findRepo(ctx.cwd);
		const branch = repo ? readBranch(repo.headPath) : undefined;
		prBranch = branch;
		if (!repo || !branch) {
			pullRequest = undefined;
			render();
			return;
		}
		const started = generation;
		prLooking = true;
		try {
			const result = await pi.exec("gh", ["pr", "view", "--json", "number,title,url,state,isDraft"], {
				cwd: repo.root,
				timeout: PR_TIMEOUT_MS,
			});
			if (started !== generation) return;
			const raw =
				result.code === 0
					? (JSON.parse(result.stdout) as {
							number?: unknown;
							title?: unknown;
							url?: unknown;
							state?: unknown;
							isDraft?: unknown;
						})
					: undefined;
			pullRequest =
				raw?.state === "OPEN" &&
				typeof raw.number === "number" &&
				typeof raw.url === "string" &&
				/^https:\/\/\S+$/.test(raw.url)
					? {
							number: raw.number,
							title: plainText(String(raw.title ?? ""), 100),
							url: raw.url,
							draft: raw.isDraft === true,
						}
					: undefined;
		} catch {
			if (started === generation) pullRequest = undefined;
		} finally {
			prLooking = false;
			if (started === generation) render();
		}
	}
	function refreshPullRequestIfStale(ctx: ExtensionContext): void {
		const repo = findRepo(ctx.cwd);
		const branch = repo ? readBranch(repo.headPath) : undefined;
		if (branch !== prBranch || Date.now() - prCheckedAt > PR_MAX_AGE_MS) void refreshPullRequest(ctx);
	}
	function prLine(theme: Theme, width: number): string | undefined {
		const pr = pullRequest;
		if (!pr) return undefined;
		const label = truncateToWidth(`↗ PR #${pr.number}${pr.draft ? " draft" : ""} · ${pr.title}`, width);
		const styled = theme.fg("mdLink", theme.underline(label));
		return getCapabilities().hyperlinks ? hyperlink(styled, pr.url) : styled;
	}
	function activityText(): string {
		const bits: string[] = [];
		if (uiPrompt) {
			bits.push(`waiting on ${uiPrompt.kind}${uiPrompt.title ? `: ${uiPrompt.title}` : ""}`);
		}
		if (phase === "working" && !uiPrompt) {
			const objective = currentObjective();
			if (objective) bits.push(objective);
			const tool = [...activeTools.values()].at(-1);
			if (tool) {
				const elapsed = Date.now() - tool.startedAt;
				bits.push(elapsed >= 2000 ? `${tool.name} ${formatDuration(elapsed)}` : tool.name);
			} else if (!objective) {
				bits.push("thinking");
			}
		}
		if (phase === "failed") bits.push(lastOutcome === "aborted" ? "run aborted" : "run ended with an error");
		if (wait) {
			const elapsed = Date.now() - wait.startedAt;
			const prefix = elapsed > wait.expectedMs ? "overdue " : "";
			bits.push(`${prefix}${formatDuration(elapsed)}/${formatDuration(wait.expectedMs)}`);
		}
		const escalation = supervisorEscalation();
		if (escalation?.note) bits.push(`${escalation.label}: ${escalation.note}`);
		if (contextPercent !== undefined && contextPercent >= 80) bits.push(`context ${Math.round(contextPercent)}%`);
		if (bits.length === 0) bits.push(currentObjective() ?? "idle");
		return bits.join(" · ");
	}
	function gaugeTps(): number | undefined {
		if (pulseTps) {
			if (Date.now() - pulseTps.at <= TPS_STALE_MS) return pulseTps.value;
			pulseTps = undefined;
		}
		return liveTps();
	}
	function liveTps(): number | undefined {
		const now = Date.now();
		while (deltas.length > 0 && now - deltas[0].at > TPS_STALE_MS) deltas.shift();
		if (deltas.length < 2) {
			tpsShown = undefined;
			return undefined;
		}
		if (tpsShown && now - tpsShown.at < TPS_TICK_MS) return tpsShown.value;
		const recent = deltas.filter((d) => now - d.at <= TPS_WINDOW_MS);
		const span = recent.length >= 2 ? recent[recent.length - 1].at - recent[0].at : 0;
		if (span < TPS_MIN_SPAN_MS) return tpsShown?.value;
		const chars = recent.reduce((sum, d) => sum + d.chars, 0);
		tpsShown = { value: chars / CHARS_PER_TOKEN / (span / 1000), at: now };
		return tpsShown.value;
	}
	function cardLines(theme: Theme, width: number): string[] {
		const resolved = resolveLight();
		const glyph = resolved.pulsing ? PULSE_FRAMES[frame % PULSE_FRAMES.length] : "●";
		const dot = theme.fg(LIGHT_TOKEN[resolved.light], glyph);
		const right = `${dot} ${theme.fg("dim", resolved.word)}`;
		const left = truncateToWidth(
			theme.fg("text", theme.bold(displayName() || "andon")),
			Math.max(0, width - visibleWidth(right) - 1),
		);
		const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		const pr = prLine(theme, width);
		const tps = gaugeTps();
		const gaugeText = tps === undefined ? undefined : `~${Math.round(tps)} tok/s`;
		const gaugeWidth = gaugeText === undefined ? 0 : visibleWidth(gaugeText);
		const activity = wrapTextWithAnsi(activityText(), Math.max(1, width - gaugeWidth - 1)).map((line) =>
			theme.fg("dim", line),
		);
		if (gaugeText !== undefined && activity.length > 0) {
			const first = activity[0];
			const gaugePad = Math.max(1, width - visibleWidth(first) - gaugeWidth);
			activity[0] = first + " ".repeat(gaugePad) + theme.fg("dim", gaugeText);
		}
		return [truncateToWidth(left + " ".repeat(pad) + right, width), ...activity, ...(pr ? [pr] : [])];
	}
	function titleLine(): string {
		const resolved = resolveLight();
		const name = displayName();
		const line = name ? `${LIGHT_EMOJI[resolved.light]} π · ${name}` : `${LIGHT_EMOJI[resolved.light]} π`;
		const objective = currentObjective();
		return truncatePlain(objective && objective !== name ? `${line} — ${objective}` : line, 90);
	}
	function syncTimer(): void {
		const last = deltas[deltas.length - 1];
		const gaugeAlive = last !== undefined && Date.now() - last.at <= TPS_STALE_MS;
		const wanted =
			lastCtx?.hasUI === true && (phase === "working" || wait !== undefined || resolveLight().pulsing || gaugeAlive);
		if (wanted && !timer) {
			timer = setInterval(() => {
				frame += 1;
				render();
			}, 500);
		} else if (!wanted && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}
	function broadcast(): void {
		const resolved = resolveLight();
		const state = {
			sessionId: lastCtx?.sessionManager.getSessionId(),
			...statePayload(resolved),
		};
		const key = JSON.stringify(state);
		if (key === lastBroadcast) return;
		lastBroadcast = key;
		pi.events.emit("andon:state", state);
		recordState(resolved);
	}
	function statePayload(resolved: Resolved): AndonState {
		return {
			v: 1,
			light: resolved.light,
			word: resolved.word,
			pulsing: resolved.pulsing,
			objective: currentObjective(),
			title,
			waitUntil: wait ? new Date(wait.startedAt + wait.expectedMs).toISOString() : undefined,
		};
	}
	function recordState(resolved: Resolved): void {
		const key = `${resolved.light}/${resolved.word}`;
		if (key === lastRecorded) return;
		lastRecorded = key;
		try {
			pi.appendEntry("andon.state", statePayload(resolved));
		} catch {}
	}
	function render(ctx?: ExtensionContext): void {
		if (ctx) lastCtx = ctx;
		const current = lastCtx;
		broadcast();
		if (!current?.hasUI) return;
		const theme = current.ui.theme;
		const nextTitle = titleLine();
		if (nextTitle !== lastTitleText) {
			current.ui.setTitle(nextTitle);
			lastTitleText = nextTitle;
		}
		if (visible && current.mode === "tui") {
			if (!widgetShown) {
				current.ui.setWidget(
					"andon",
					(tui, fallbackTheme) => {
						cardTui = tui;
						return new AndonCard(
							() => lastCtx?.ui.theme ?? fallbackTheme,
							(theme, width) => cardLines(theme, width),
						);
					},
					{ placement: "belowEditor" },
				);
				widgetShown = true;
			} else {
				cardTui?.requestRender();
			}
		} else if (visible) {
			current.ui.setWidget("andon", cardLines(theme, 200), { placement: "belowEditor" });
			widgetShown = true;
		} else if (widgetShown) {
			current.ui.setWidget("andon", undefined);
			widgetShown = false;
			cardTui = undefined;
		}
		syncTimer();
	}
	function persist(): void {
		pi.appendEntry<AndonData>("andon", { title, titleSource, summary, overrideState, visible });
	}
	function resetState(): void {
		title = undefined;
		titleSource = "auto";
		summary = undefined;
		overrideState = undefined;
		visible = true;
	}
	function restore(ctx: ExtensionContext): void {
		let data: AndonData | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "andon") {
				data = entry.data as AndonData | undefined;
			}
		}
		if (data) {
			title = data.title;
			titleSource = data.titleSource ?? "auto";
			summary = data.summary;
			overrideState = data.overrideState;
			visible = data.visible ?? true;
		}
	}
	pi.events.on("pulse:tps", (payload) => {
		const reading = payload as
			| {
					sessionId?: string;
					tps?: number;
			  }
			| undefined;
		if (!reading || typeof reading.tps !== "number" || reading.tps <= 0) return;
		const mine = lastCtx?.sessionManager.getSessionId();
		if (reading.sessionId && mine && reading.sessionId !== mine) return;
		pulseTps = { value: reading.tps, at: Date.now() };
	});
	pi.events.on("andon:update", (payload) => {
		const update = payload as SupervisorUpdate | undefined;
		const ctx = lastCtx;
		if (!update || !ctx) return;
		if (update.sessionId && update.sessionId !== ctx.sessionManager.getSessionId()) return;
		supervisor = {
			state: update.state ?? "green",
			objective: update.objective || undefined,
			note: update.note || undefined,
			label: update.label || "supervisor",
			at: Date.now(),
		};
		render();
	});
	pi.registerCommand("andon", {
		description: "Show, hide, or edit the andon status card",
		handler: async (args, ctx) => {
			const input = args.trim();
			const space = input.indexOf(" ");
			const verb = (space === -1 ? input : input.slice(0, space)).toLowerCase();
			const rest = space === -1 ? "" : input.slice(space + 1).trim();
			switch (verb) {
				case "":
				case "toggle":
					visible = !visible;
					persist();
					render(ctx);
					ctx.ui.notify(visible ? "Andon card shown" : "Andon card hidden", "info");
					return;
				case "show":
				case "hide":
					visible = verb === "show";
					persist();
					render(ctx);
					ctx.ui.notify(visible ? "Andon card shown" : "Andon card hidden", "info");
					return;
				case "title": {
					let next = rest;
					if (!next) {
						if (!ctx.hasUI) {
							ctx.ui.notify(`Andon title: ${title ?? "(unset)"}`, "info");
							return;
						}
						next = ((await ctx.ui.editor("Session title", title ?? "")) ?? "").trim();
					}
					if (!next) return;
					title = truncatePlain(next, 80);
					titleSource = "user";
					persist();
					render(ctx);
					ctx.ui.notify(`Andon title: ${title}`, "info");
					return;
				}
				case "state": {
					const value = rest.toLowerCase();
					if (!value) {
						ctx.ui.notify(`Andon state: ${overrideState ?? "auto"}`, "info");
						return;
					}
					if (value === "auto") {
						overrideState = undefined;
					} else if (value === "green" || value === "amber" || value === "red") {
						overrideState = value;
						if (value !== "amber") wait = undefined;
					} else {
						ctx.ui.notify("Usage: /andon state <green|amber|red|auto>", "error");
						return;
					}
					persist();
					render(ctx);
					ctx.ui.notify(`Andon state: ${overrideState ?? "auto"}`, "info");
					return;
				}
				case "edit": {
					if (!ctx.hasUI) {
						ctx.ui.notify("/andon edit requires interactive mode", "error");
						return;
					}
					const next = await ctx.ui.editor("Andon summary", summary ?? "");
					if (next === undefined) return;
					summary = next.trim() ? truncatePlain(next, 80) : undefined;
					summaryAt = Date.now();
					persist();
					render(ctx);
					return;
				}
				case "wait": {
					const value = rest.toLowerCase();
					if (!value) {
						const current = wait
							? `${formatDuration(Date.now() - wait.startedAt)}/${formatDuration(wait.expectedMs)}`
							: "off";
						ctx.ui.notify(`Andon wait: ${current}`, "info");
						return;
					}
					if (CLEAR_WAIT.has(value)) wait = undefined;
					else {
						const ms = parseDuration(value);
						if (ms === undefined) {
							ctx.ui.notify("Usage: /andon wait <duration|off> (e.g. 5m, 90s, 1h)", "error");
							return;
						}
						wait = { startedAt: Date.now(), expectedMs: ms, toolCallId: waitTarget() };
					}
					render(ctx);
					ctx.ui.notify(wait ? `Andon wait: ${formatDuration(wait.expectedMs)}` : "Andon wait cleared", "info");
					return;
				}
				case "clear":
					summary = undefined;
					wait = undefined;
					overrideState = undefined;
					persist();
					render(ctx);
					ctx.ui.notify("Andon summary cleared", "info");
					return;
				default:
					summary = truncatePlain(input, 80);
					summaryAt = Date.now();
					persist();
					render(ctx);
					ctx.ui.notify(`Andon: ${summary}`, "info");
			}
		},
	});
	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Toggle the andon status card",
		handler: async (ctx) => {
			visible = !visible;
			persist();
			render(ctx);
			ctx.ui.notify(visible ? "Andon card shown" : "Andon card hidden", "info");
		},
	});
	const AndonParams = Type.Object({
		state: Type.Optional(
			StringEnum(["green", "amber", "red"] as const, {
				description: "green = progressing, amber = waiting, red = stopped and needs the user",
			}),
		),
		summary: Type.Optional(
			Type.String({ description: "What you are doing right now, under ~60 chars, e.g. 'testing in staging'" }),
		),
		title: Type.Optional(Type.String({ description: "Stable one-line description of what this session is about" })),
		wait: Type.Optional(
			Type.String({
				description:
					"Expected duration of the tool you are about to run, e.g. '5m', '90s', '1h'. The card turns amber at 80% of this time. The wait clears when that tool ends; 'off' clears it now.",
			}),
		),
	});
	pi.registerTool({
		name: "set_andon",
		label: "Set andon",
		description:
			"Update this session's andon status card — the indicator the user scans to find sessions that need them. " +
			"Use it to say what this session is about (title), what you are doing right now (summary), and the " +
			"light: green (progressing), amber (waiting a long time on something, usually polling), red (stopped " +
			"and needing the user).",
		promptSnippet: "set_andon: update this session's visible status card and light",
		promptGuidelines: [
			"Keep the session's andon card truthful with `set_andon`. Green means progressing, amber means waiting a long time on something, red means stopped and needing the user.",
			'Before running something that may take a while — CI builds, deploys, downloads — call `set_andon` with `wait` set to the expected duration, e.g. `wait: "10m"`. The card turns amber at 80% of that time so a stuck wait is visible. The wait follows the tool it was declared for and clears when that tool ends, so declare it again for the next long operation; omitting `wait` clears it. Leave `state` unset when you declare a `wait` — the card raises the amber itself.',
			'Set `state: "red"` whenever you stop and need the user: asking a question, requesting approval, or handing back a decision. Clear it back to green when you are unblocked.',
			'Call `set_andon` at the start of a meaningful task with a short `title` and `summary`, and when you finish (`summary`, e.g. "done: auth fix"). Keep both under ~60 characters.',
		],
		parameters: AndonParams,
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.title) {
				title = truncatePlain(params.title, 80);
				titleSource = "model";
			}
			if (params.summary !== undefined) {
				summary = truncatePlain(params.summary, 80) || undefined;
				summaryAt = Date.now();
			}
			let waitNote = "";
			if (params.wait !== undefined) {
				const value = params.wait.trim().toLowerCase();
				if (CLEAR_WAIT.has(value)) {
					wait = undefined;
				} else {
					const ms = parseDuration(value);
					if (ms === undefined) waitNote = ` (unrecognised wait "${params.wait}", ignored)`;
					else wait = { startedAt: Date.now(), expectedMs: ms, toolCallId: waitTarget() };
				}
			} else {
				wait = undefined;
			}
			if (params.state) overrideState = params.state;
			persist();
			render(ctx);
			const resolved = resolveLight();
			return {
				content: [
					{
						type: "text",
						text: `Andon: ${resolved.light}${summary ? ` — ${summary}` : ""}${waitNote}`,
					},
				],
				details: { ...statePayload(resolved), summary },
			};
		},
		renderCall(args, theme) {
			const light = theme.fg(args.state ? LIGHT_TOKEN[args.state] : "success", "●");
			const text = args.title ?? args.summary;
			const parts: string[] = [];
			if (text) parts.push(theme.fg(args.title ? "text" : "dim", text));
			if (args.wait) parts.push(theme.fg("warning", `wait ${args.wait}`));
			return new Text(`${light} ${parts.join(" · ")}`.trimEnd(), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const details = result.details as
				| {
						summary?: string;
				  }
				| undefined;
			const args = context.args as
				| {
						title?: string;
						summary?: string;
				  }
				| undefined;
			if (!args?.title && args?.summary) return new Text("", 0, 0);
			return new Text(theme.fg("muted", details?.summary ?? "updated"), 0, 0);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		generation += 1;
		phase = "idle";
		lastOutcome = undefined;
		activeTools = new Map();
		wait = undefined;
		uiPrompt = undefined;
		contextPercent = undefined;
		widgetShown = false;
		cardTui = undefined;
		lastTitleText = undefined;
		deltas = [];
		pulseTps = undefined;
		resetState();
		restore(ctx);
		supervisor = undefined;
		pullRequest = undefined;
		prBranch = undefined;
		prCheckedAt = 0;
		prLooking = false;
		render(ctx);
		setTimeout(() => {
			lastBroadcast = "";
			lastRecorded = "";
			broadcast();
		}, 0);
		void refreshPullRequest(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		resetState();
		restore(ctx);
		supervisor = undefined;
		render(ctx);
	});
	pi.on("session_info_changed", async (event, ctx) => {
		if (event.name && (!title || titleSource === "auto")) {
			title = event.name;
			titleSource = "auto";
			persist();
			render(ctx);
		}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		refreshPullRequestIfStale(ctx);
		if (event.messageType !== "user" || title) return;
		const line = event.prompt
			.split("\n")
			.map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
			.find(Boolean);
		if (!line) return;
		const interim = truncatePlain(line, 60);
		title = interim;
		titleSource = "auto";
		persist();
		render(ctx);
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		const started = generation;
		void summarisePrompt(ctx, event.prompt).then((result) => {
			if (!result || started !== generation || titleSource !== "auto" || title !== interim) return;
			title = result;
			persist();
			render();
		});
	});
	pi.on("agent_start", async (_event, ctx) => {
		phase = "working";
		lastOutcome = undefined;
		activeTools.clear();
		wait = undefined;
		overrideState = undefined;
		deltas = [];
		pulseTps = undefined;
		persist();
		render(ctx);
	});
	pi.on("message_update", async (event) => {
		const kind = event.assistantMessageEvent.type;
		if (kind === "text_delta" || kind === "thinking_delta" || kind === "toolcall_delta") {
			deltas.push({ at: Date.now(), chars: event.assistantMessageEvent.delta.length });
		}
	});
	pi.on("agent_before_settle", async (event) => {
		lastOutcome = event.outcome;
	});
	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) lastOutcome = "aborted";
		phase = lastOutcome === "error" || lastOutcome === "aborted" ? "failed" : "idle";
		activeTools.clear();
		wait = undefined;
		render(ctx);
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		activeTools.set(event.toolCallId, {
			name: event.toolName,
			startedAt: Date.now(),
			command: toolCommand(event.args),
		});
		if (wait && !wait.toolCallId && event.toolName !== "set_andon") wait.toolCallId = event.toolCallId;
		render(ctx);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		const tool = activeTools.get(event.toolCallId);
		activeTools.delete(event.toolCallId);
		if (wait?.toolCallId === event.toolCallId) wait = undefined;
		if (tool?.command && PR_COMMAND.test(tool.command)) void refreshPullRequest(ctx);
		render(ctx);
	});
	pi.on("ui_prompt_start", async (event, ctx) => {
		uiPrompt = { kind: event.kind, title: event.title };
		render(ctx);
	});
	pi.on("ui_prompt_end", async (_event, ctx) => {
		uiPrompt = undefined;
		render(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		contextPercent = ctx.getContextUsage()?.percent ?? undefined;
		render(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		generation += 1;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx.hasUI) {
			ctx.ui.setWidget("andon", undefined);
		}
		widgetShown = false;
		cardTui = undefined;
		lastCtx = undefined;
	});
}
