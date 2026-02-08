import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const COMMAND_NAME = "conversation-retro";
const STATUS_KEY = "conversation-retro-status";
const WIDGET_KEY = "conversation-retro-widget";

const DEFAULT_DAYS = 7;
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MINUTES = 12;
const DEFAULT_OUTPUT_DIR = ".pi/reports/conversation-retro";

type Phase = "discovering" | "analyzing" | "reviewing" | "done";

interface CommandOptions {
	days: number;
	concurrency: number;
	timeoutMinutes: number;
	outputDir: string;
	limit?: number;
	dryRun: boolean;
}

interface SessionHeader {
	type?: string;
	cwd?: string;
	timestamp?: string;
}

interface ConversationCandidate {
	sessionPath: string;
	sessionFileName: string;
	sessionCreatedAt: Date;
	sessionCwd: string;
	summaryPath: string;
}

interface AnalysisResult {
	candidate: ConversationCandidate;
	success: boolean;
	error?: string;
}

interface ProgressState {
	phase: Phase;
	totalInScope: number;
	totalToAnalyze: number;
	totalSkippedExisting: number;
	running: number;
	finished: number;
	succeeded: number;
	failed: number;
	reviewerDone: boolean;
	reportPath?: string;
	runningItems: string[];
	outputDir: string;
}

interface RunPiResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	killed: boolean;
}

function parseArgs(rawArgs: string | undefined): CommandOptions {
	const options: CommandOptions = {
		days: DEFAULT_DAYS,
		concurrency: DEFAULT_CONCURRENCY,
		timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
		outputDir: DEFAULT_OUTPUT_DIR,
		dryRun: false,
	};

	if (!rawArgs?.trim()) return options;

	const parts = rawArgs.trim().split(/\s+/);
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const next = parts[i + 1];

		if ((part === "--days" || part === "-d") && next) {
			const parsed = Number.parseInt(next, 10);
			if (Number.isFinite(parsed) && parsed > 0 && parsed <= 90) {
				options.days = parsed;
			}
			i++;
			continue;
		}

		if ((part === "--concurrency" || part === "-c") && next) {
			const parsed = Number.parseInt(next, 10);
			if (Number.isFinite(parsed) && parsed > 0 && parsed <= 16) {
				options.concurrency = parsed;
			}
			i++;
			continue;
		}

		if ((part === "--timeout" || part === "-t") && next) {
			const parsed = Number.parseInt(next, 10);
			if (Number.isFinite(parsed) && parsed > 0 && parsed <= 60) {
				options.timeoutMinutes = parsed;
			}
			i++;
			continue;
		}

		if ((part === "--output" || part === "-o") && next) {
			options.outputDir = next;
			i++;
			continue;
		}

		if ((part === "--limit" || part === "-l") && next) {
			const parsed = Number.parseInt(next, 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				options.limit = parsed;
			}
			i++;
			continue;
		}

		if (part === "--dry-run") {
			options.dryRun = true;
			continue;
		}
	}

	return options;
}

function getAgentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) return fromEnv;
	return path.join(os.homedir(), ".pi", "agent");
}

function getSessionsBaseDir(): string {
	return path.join(getAgentDir(), "sessions");
}

function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function collectSessionFilesRecursively(rootDir: string): string[] {
	if (!existsSync(rootDir)) return [];

	const out: string[] = [];
	const stack = [rootDir];

	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "subagent-artifacts") continue;
				stack.push(fullPath);
				continue;
			}

			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				out.push(fullPath);
			}
		}
	}

	return out;
}

function parseCreatedAtFromSessionFileName(filePath: string): Date | undefined {
	const base = path.basename(filePath, ".jsonl");
	const timestampPart = base.split("_")[0];
	const match = timestampPart.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
	if (!match) return undefined;

	const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return undefined;
	return new Date(ms);
}

function readSessionHeader(filePath: string): SessionHeader | null {
	try {
		const raw = readFileSync(filePath, "utf8");
		const firstLine = raw.split(/\r?\n/, 1)[0];
		if (!firstLine) return null;
		const parsed = JSON.parse(firstLine) as SessionHeader;
		if (parsed?.type !== "session" || typeof parsed.cwd !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

function toOutputDir(repoRoot: string, outputArg: string): string {
	if (path.isAbsolute(outputArg)) return outputArg;
	return path.join(repoRoot, outputArg);
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function truncateMiddle(input: string, max = 600): string {
	if (input.length <= max) return input;
	const half = Math.floor((max - 20) / 2);
	return `${input.slice(0, half)}\n\n...[truncated]...\n\n${input.slice(-half)}`;
}

function buildAnalysisPrompt(candidate: ConversationCandidate): string {
	return [
		"You are a strict postmortem reviewer for Pi coding-agent conversations.",
		"Your goal is to help the user improve their agent setup so mistakes stop repeating.",
		"",
		`Analyze this session JSONL file: ${candidate.sessionPath}`,
		"",
		"Read the full session carefully. For each problem you find, classify the root cause into one of these categories:",
		"- **Missing instructions**: The AGENTS.md, skills, or prompt templates lacked guidance the agent needed",
		"- **Ignored instructions**: The agent had the right guidance but didn't follow it",
		"- **Wrong approach**: The agent picked a bad strategy (e.g. over-engineering, wrong tool, rabbit hole)",
		"- **Missing context**: The agent lacked project knowledge it should have been given upfront",
		"- **Tool misuse**: The agent used tools incorrectly (e.g. destructive commands, wrong flags, skipping validation)",
		"- **No issue found**: The conversation went well — note what worked and why",
		"",
		"For each problem, cite specific evidence from the session (tool calls, commands, or agent reasoning).",
		"",
		"Output ONLY markdown with these sections:",
		"",
		"# Session Review",
		"",
		"## Summary",
		"One-paragraph overview: what was the task, did it succeed, and what was the main issue (if any).",
		"",
		"## Problems found",
		"For each problem:",
		"- What happened (with evidence from the session)",
		"- Root cause category (from the list above)",
		"- Impact (wasted time, broken code, wrong output, etc.)",
		"",
		"## Suggested AGENTS.md additions",
		"Concrete rules or instructions that would have prevented these problems.",
		"Write them as copy-pasteable bullet points or sections for an AGENTS.md file.",
		"Only include this section if there are actual improvements to suggest.",
		"",
		"## Suggested workflow changes",
		"Changes to skills, prompt templates, project structure, or development workflow that would help.",
		"Only include this section if there are actual improvements to suggest.",
		"",
		"Keep it practical and concise (max ~800 words). Skip sections that don't apply.",
		"Do not execute destructive commands. Read-only investigation only.",
	].join("\n");
}

function buildSummaryFileContent(candidate: ConversationCandidate, analysis: string): string {
	const generatedAt = new Date().toISOString();
	const header = [
		`<!-- source_session: ${candidate.sessionPath} -->`,
		`<!-- session_created_at: ${candidate.sessionCreatedAt.toISOString()} -->`,
		`<!-- generated_at: ${generatedAt} -->`,
		"",
	];
	return `${header.join("\n")}${analysis.trim()}\n`;
}

function buildReviewerPrompt(summaryCount: number): string {
	return [
		"You are a senior reviewer synthesizing session reviews into an actionable improvement plan.",
		"Your audience is a developer who wants to make their coding agent stop repeating the same mistakes.",
		"",
		`You are given ${summaryCount} individual session reviews from recent conversations.`,
		"",
		"Your job:",
		"1. Find recurring patterns across sessions — what types of mistakes keep happening?",
		"2. Identify the highest-impact changes to AGENTS.md, skills, and workflows",
		"3. Produce concrete, copy-pasteable improvements the user can apply immediately",
		"",
		"Root cause categories used in the session reviews:",
		"- Missing instructions, Ignored instructions, Wrong approach, Missing context, Tool misuse",
		"",
		"Output ONLY markdown with these sections:",
		"",
		"# Agent Improvement Report",
		"",
		"## Executive summary",
		"2-3 sentences: what's the biggest problem and the single most impactful fix.",
		"",
		"## Recurring failure patterns",
		"Group related problems across sessions. For each pattern:",
		"- Description and frequency (how many sessions affected)",
		"- Root cause category",
		"- Example evidence from the session reviews",
		"",
		"## AGENTS.md improvements",
		"Concrete rules, guidelines, or sections to add to the project's AGENTS.md.",
		"Write them as ready-to-paste markdown — the user should be able to copy these directly.",
		"Prioritize by impact (most frequent/costly patterns first).",
		"",
		"## Skill and workflow improvements",
		"Suggested changes to pi skills, prompt templates, project structure, or development workflow.",
		"Be specific: name the skill to create/modify, the template to add, or the structural change to make.",
		"",
		"## What's working well",
		"Patterns from sessions that went smoothly. What should the user keep doing?",
		"",
		"Be specific and opinionated. Every suggestion must tie back to evidence from the session reviews.",
		"Avoid generic advice like 'add more tests' or 'improve documentation' unless backed by specific failures.",
	].join("\n");
}

function buildReviewerInputBundle(summaryPaths: string[]): string {
	const lines: string[] = [];
	lines.push("# Session reviews for synthesis");
	lines.push("");
	lines.push(`Total reviews: ${summaryPaths.length}`);
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push("Each review below analyzes one coding agent conversation, identifying problems, root causes, and suggested fixes.");
	lines.push("");

	for (const summaryPath of summaryPaths) {
		let content = "";
		try {
			content = readFileSync(summaryPath, "utf8").trim();
		} catch {
			content = "[Could not read summary file]";
		}

		lines.push("---");
		lines.push(`## ${path.basename(summaryPath)}`);
		lines.push(`Path: ${summaryPath}`);
		lines.push("");
		lines.push(content.length > 0 ? content : "[Empty summary]");
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}

function getTimestampTag(date = new Date()): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(
		date.getUTCMinutes(),
	)}${pad(date.getUTCSeconds())}`;
}

function buildProgressLines(state: ProgressState): string[] {
	const remaining = Math.max(0, state.totalToAnalyze - state.finished - state.running);
	const phaseLabel =
		state.phase === "discovering"
			? "discovering sessions"
			: state.phase === "analyzing"
				? "running conversation reviewers"
				: state.phase === "reviewing"
					? "running final reviewer"
					: "complete";

	const lines = [
		"Conversation Retro",
		`phase: ${phaseLabel}`,
		`in scope: ${state.totalInScope} • existing summaries: ${state.totalSkippedExisting}`,
		`finished: ${state.finished}/${state.totalToAnalyze} • running: ${state.running} • remaining: ${remaining}`,
		`success: ${state.succeeded} • failed: ${state.failed}`,
		`output: ${state.outputDir}`,
	];

	if (state.runningItems.length > 0) {
		const runningPreview = state.runningItems.slice(0, 3).join(", ");
		lines.push(`active: ${runningPreview}${state.runningItems.length > 3 ? ` (+${state.runningItems.length - 3} more)` : ""}`);
	}

	if (state.phase === "done" && state.reportPath) {
		lines.push(`report: ${state.reportPath}`);
	}

	return lines;
}

function renderProgress(ctx: ExtensionCommandContext, state: ProgressState): void {
	if (!ctx.hasUI) return;
	const lines = buildProgressLines(state);
	const short = `retro ${state.finished}/${state.totalToAnalyze} done • ${state.running} running`;
	ctx.ui.setStatus(STATUS_KEY, short);
	ctx.ui.setWidget(WIDGET_KEY, lines);
}

function clearProgress(ctx: ExtensionCommandContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function runPiCommand(
	args: string[],
	cwd: string,
	timeoutMs: number,
	envAdditions?: Record<string, string>,
): Promise<RunPiResult> {
	return new Promise((resolve) => {
		const env = {
			...process.env,
			PI_SKIP_VERSION_CHECK: "1",
			...(envAdditions ?? {}),
		};

		const proc = spawn("pi", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stdout = "";
		let stderr = "";
		let killed = false;

		const timeoutId = setTimeout(() => {
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 4000);
		}, timeoutMs);

		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timeoutId);
			resolve({ stdout, stderr, exitCode: code ?? 0, killed });
		});

		proc.on("error", (error) => {
			clearTimeout(timeoutId);
			resolve({ stdout, stderr: `${stderr}\n${String(error)}`.trim(), exitCode: 1, killed: true });
		});
	});
}

async function resolveRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	return cwd;
}

function getConversationCandidates(
	repoRoot: string,
	outputDir: string,
	cutoffMs: number,
): { candidates: ConversationCandidate[]; skippedExisting: number } {
	const sessionsBase = getSessionsBaseDir();
	const files = collectSessionFilesRecursively(sessionsBase);

	const candidates: ConversationCandidate[] = [];
	let skippedExisting = 0;

	for (const filePath of files) {
		const createdAt = parseCreatedAtFromSessionFileName(filePath) ?? new Date(statSync(filePath).mtimeMs);
		if (createdAt.getTime() < cutoffMs) continue;

		const header = readSessionHeader(filePath);
		if (!header?.cwd) continue;
		if (!isPathInside(header.cwd, repoRoot)) continue;

		const sessionFileName = path.basename(filePath, ".jsonl");
		const summaryPath = path.join(outputDir, `${sessionFileName}.md`);

		if (existsSync(summaryPath)) {
			skippedExisting++;
			continue;
		}

		candidates.push({
			sessionPath: filePath,
			sessionFileName,
			sessionCreatedAt: createdAt,
			sessionCwd: header.cwd,
			summaryPath,
		});
	}

	candidates.sort((a, b) => a.sessionCreatedAt.getTime() - b.sessionCreatedAt.getTime());
	return { candidates, skippedExisting };
}

async function analyzeConversation(
	candidate: ConversationCandidate,
	repoRoot: string,
	timeoutMs: number,
): Promise<AnalysisResult> {
	const prompt = buildAnalysisPrompt(candidate);
	const args = [
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--tools",
		"read,bash,grep,find,ls",
		prompt,
	];

	const result = await runPiCommand(args, repoRoot, timeoutMs);
	if (result.exitCode !== 0 || result.killed) {
		return {
			candidate,
			success: false,
			error: truncateMiddle(result.stderr || result.stdout || `pi exited with code ${result.exitCode}`),
		};
	}

	const text = result.stdout.trim();
	if (!text) {
		return {
			candidate,
			success: false,
			error: "Subagent returned empty output",
		};
	}

	try {
		writeFileSync(candidate.summaryPath, buildSummaryFileContent(candidate, text), "utf8");
	} catch (error) {
		return {
			candidate,
			success: false,
			error: `Failed writing summary: ${String(error)}`,
		};
	}

	return { candidate, success: true };
}

async function runWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	onItemStart: (item: T, index: number) => void,
	onItemDone: (item: T, index: number, result: R) => void,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];

	const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<R>(items.length);
	let cursor = 0;

	const loops = new Array(safeConcurrency).fill(null).map(async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			const item = items[index];
			onItemStart(item, index);
			const result = await worker(item, index);
			results[index] = result;
			onItemDone(item, index, result);
		}
	});

	await Promise.all(loops);
	return results;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description:
			"Spawn one reviewer subagent per recent repo conversation, write per-conversation mistake summaries, then generate an improvement report",
		handler: async (args, ctx) => {
			const options = parseArgs(args);
			const repoRoot = await resolveRepoRoot(pi, ctx.cwd);
			const outputDir = toOutputDir(repoRoot, options.outputDir);
			ensureDir(outputDir);

			const progress: ProgressState = {
				phase: "discovering",
				totalInScope: 0,
				totalToAnalyze: 0,
				totalSkippedExisting: 0,
				running: 0,
				finished: 0,
				succeeded: 0,
				failed: 0,
				reviewerDone: false,
				runningItems: [],
				outputDir,
			};

			renderProgress(ctx, progress);

			const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
			const sessionsBase = getSessionsBaseDir();
			const allRecentInRepo = collectSessionFilesRecursively(sessionsBase)
				.map((filePath) => {
					const created = parseCreatedAtFromSessionFileName(filePath) ?? new Date(statSync(filePath).mtimeMs);
					const header = readSessionHeader(filePath);
					return { filePath, created, header };
				})
				.filter((row) => row.created.getTime() >= cutoffMs && row.header?.cwd && isPathInside(row.header.cwd, repoRoot));

			const { candidates, skippedExisting } = getConversationCandidates(repoRoot, outputDir, cutoffMs);
			const limitedCandidates = options.limit ? candidates.slice(0, options.limit) : candidates;

			progress.totalInScope = allRecentInRepo.length;
			progress.totalSkippedExisting = skippedExisting;
			progress.totalToAnalyze = limitedCandidates.length;
			progress.phase = "analyzing";
			renderProgress(ctx, progress);

			if (ctx.hasUI) {
				const limitSuffix = options.limit ? ` (limit: ${options.limit})` : "";
				ctx.ui.notify(
					`conversation retro: ${progress.totalInScope} in scope, ${progress.totalToAnalyze} to analyze, ${progress.totalSkippedExisting} already summarized${limitSuffix}`,
					"info",
				);
			}

			if (options.dryRun) {
				progress.phase = "done";
				renderProgress(ctx, progress);
				clearProgress(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify("conversation retro dry run complete (no subagents were started)", "info");
				}
				return;
			}

			const timeoutMs = options.timeoutMinutes * 60 * 1000;

			const results = await runWithConcurrency(
				limitedCandidates,
				options.concurrency,
				(item) => {
					progress.running++;
					progress.runningItems.push(item.sessionFileName);
					renderProgress(ctx, progress);
				},
				(item, _index, result) => {
					progress.running = Math.max(0, progress.running - 1);
					progress.finished++;
					progress.runningItems = progress.runningItems.filter((name) => name !== item.sessionFileName);
					if (result.success) progress.succeeded++;
					else progress.failed++;
					renderProgress(ctx, progress);
				},
				(item) => analyzeConversation(item, repoRoot, timeoutMs),
			);

			const failed = results.filter((r) => !r.success);
			if (failed.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`conversation retro: ${failed.length} subagents failed`, "warning");
			}

			const summaryPathsInScope = allRecentInRepo
				.map((row) => path.join(outputDir, `${path.basename(row.filePath, ".jsonl")}.md`))
				.filter((summaryPath) => existsSync(summaryPath));

			if (summaryPathsInScope.length === 0) {
				progress.phase = "done";
				renderProgress(ctx, progress);
				if (ctx.hasUI) ctx.ui.notify("conversation retro: no summaries available for review", "warning");
				clearProgress(ctx);
				return;
			}

			progress.phase = "reviewing";
			renderProgress(ctx, progress);

			const tempBundlePath = path.join(os.tmpdir(), `pi-conversation-retro-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
			writeFileSync(tempBundlePath, buildReviewerInputBundle(summaryPathsInScope), "utf8");

			const reviewerPrompt = buildReviewerPrompt(summaryPathsInScope.length);
			const reviewerArgs = [
				"-p",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-tools",
				`@${tempBundlePath}`,
				reviewerPrompt,
			];

			const reviewerResult = await runPiCommand(reviewerArgs, repoRoot, timeoutMs);
			if (reviewerResult.exitCode !== 0 || reviewerResult.killed || !reviewerResult.stdout.trim()) {
				const reason = truncateMiddle(
					reviewerResult.stderr || reviewerResult.stdout || `Reviewer subagent exited with code ${reviewerResult.exitCode}`,
				);
				if (ctx.hasUI) ctx.ui.notify(`conversation retro reviewer failed: ${reason}`, "error");
				progress.phase = "done";
				renderProgress(ctx, progress);
				clearProgress(ctx);
				return;
			}

			const reportTag = getTimestampTag();
			const reportPath = path.join(outputDir, `workflow-improvement-report-${reportTag}.md`);
			const latestReportPath = path.join(outputDir, "workflow-improvement-report-latest.md");
			writeFileSync(reportPath, reviewerResult.stdout.trim() + "\n", "utf8");
			writeFileSync(latestReportPath, reviewerResult.stdout.trim() + "\n", "utf8");

			progress.phase = "done";
			progress.reviewerDone = true;
			progress.reportPath = reportPath;
			renderProgress(ctx, progress);
			clearProgress(ctx);

			if (ctx.hasUI) {
				const failPreview = failed.slice(0, 3).map((f) => `${f.candidate.sessionFileName}: ${f.error ?? "unknown error"}`);
				const failSuffix = failed.length > 3 ? `\n... +${failed.length - 3} more failures` : "";
				ctx.ui.notify(
					[
						`conversation retro complete`,
						`summaries analyzed this run: ${progress.succeeded}/${progress.totalToAnalyze}`,
						`summaries considered by reviewer: ${summaryPathsInScope.length}`,
						`report: ${reportPath}`,
						failed.length > 0 ? `failures:\n${failPreview.join("\n")}${failSuffix}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
					failed.length > 0 ? "warning" : "info",
				);
			}
		},
	});
}
