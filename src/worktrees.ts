/**
 * Fugue-managed git worktrees for writer riffs (DESIGN §2 Spawning).
 *
 * pi-subagents' own `worktree: true` only isolates workflow children, needs a
 * clean source checkout and removes the worktree after capturing a patch.
 * Fugue isolates a single riff in `<parent>/.fugue-worktrees/<repo>/<leaf>` on
 * branch `fugue/<name>`, commits leftovers when the riff settles, and merges
 * the branch back only when the main checkout's dirty files do not overlap.
 *
 * Every function here resolves; failures come back as a reason or a warning so
 * a spawn, a settle or a merge never throws into Pi's event loop.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RiffWorktree, Voice } from "./types.ts";

export const DEFAULT_WORKTREE_COPY = ["node_modules", ".env", ".env.local"] as const;
export const WORKTREE_DIR = ".fugue-worktrees";
const BRANCH_PREFIX = "fugue/";
const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 256 * 1024;
const MAX_LISTED_FILES = 10;

export interface GitResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Run git in `cwd`. Never rejects: a missing binary, a timeout and a non-zero exit are results. */
export function runGit(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
	return runProcess("git", args, cwd, timeoutMs);
}

function runProcess(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<GitResult> {
	return new Promise((resolveResult) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let finished = false;
		const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		const append = (current: string, chunk: Buffer): string =>
			current.length >= MAX_OUTPUT_CHARS ? current : current + chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - current.length);
		const killGroup = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, timeoutMs);
		timer.unref?.();
		const finish = (code: number | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolveResult({ code, stdout, stderr, timedOut });
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (error) => {
			stderr = stderr || errorMessage(error);
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function splitZ(text: string): string[] {
	return text.split("\0").filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** A `RiffWorktree` read back from a session entry; anything malformed is dropped. */
export function parseRiffWorktree(value: unknown): RiffWorktree | undefined {
	if (!isRecord(value)) return undefined;
	const { repoRoot, path, branch, base, status } = value;
	if (typeof repoRoot !== "string" || !repoRoot) return undefined;
	if (typeof path !== "string" || !path) return undefined;
	if (typeof branch !== "string" || !branch) return undefined;
	if (typeof base !== "string" || !base) return undefined;
	if (status !== "active" && status !== "merged" && status !== "discarded") return undefined;
	return { repoRoot, path, branch, base, status };
}

export interface WorktreeCopyConfig {
	copy?: string[];
	error?: string;
}

/** `{ "worktree": { "copy": [...] } }` from `.pi/fugue.json`; `undefined` copy keeps the defaults. */
export function parseWorktreeCopy(text: string): WorktreeCopyConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { error: `not valid JSON (${errorMessage(error)})` };
	}
	if (!isRecord(raw)) return { error: "expected a JSON object" };
	if (raw.worktree === undefined) return {};
	if (!isRecord(raw.worktree)) return { error: '"worktree" must be an object' };
	const copy = raw.worktree.copy;
	if (copy === undefined) return {};
	if (!Array.isArray(copy) || copy.some((entry) => typeof entry !== "string")) {
		return { error: '"worktree.copy" must be an array of strings' };
	}
	return { copy: copy.map((entry) => entry.trim()).filter(Boolean) };
}

/** Copy list for a repo: the config's, or the defaults when there is no usable config. */
async function copyEntriesFor(repoRoot: string, warnings: string[]): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(join(repoRoot, ".pi", "fugue.json"), "utf8");
	} catch {
		return [...DEFAULT_WORKTREE_COPY];
	}
	const parsed = parseWorktreeCopy(text);
	if (parsed.error) {
		warnings.push(`.pi/fugue.json worktree config ignored: ${parsed.error}`);
		return [...DEFAULT_WORKTREE_COPY];
	}
	return parsed.copy ?? [...DEFAULT_WORKTREE_COPY];
}

/** Repo root of `cwd`, or undefined when `cwd` is not inside a git repository. */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
	const result = await runGit(resolve(cwd), ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) return undefined;
	const root = result.stdout.trim();
	return root ? resolve(root) : undefined;
}

interface WorktreeAllocation {
	branch: string;
	path: string;
}

async function registeredWorktreePaths(repoRoot: string): Promise<Set<string>> {
	const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	const paths = new Set<string>();
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) paths.add(resolve(line.slice("worktree ".length).trim()));
	}
	return paths;
}

/** `fugue/<name>`, then `-2`, `-3`, ...; never an existing branch, folder or registered worktree. */
async function allocateWorktree(repoRoot: string, name: string): Promise<WorktreeAllocation> {
	const folderBase = join(dirname(repoRoot), WORKTREE_DIR, basename(repoRoot));
	const taken = await registeredWorktreePaths(repoRoot);
	for (let n = 1; ; n += 1) {
		const leaf = n === 1 ? name : `${name}-${n}`;
		const branch = `${BRANCH_PREFIX}${leaf}`;
		const path = join(folderBase, leaf);
		if (taken.has(path) || (await pathExists(path))) continue;
		const ref = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		if (ref.code === 0) continue;
		return { branch, path };
	}
}

function normalizeCopyEntry(raw: string): string | undefined {
	const entry = raw.trim().replace(/[\\/]+$/, "");
	if (!entry || isAbsolute(entry)) return undefined;
	if (entry.split(/[\\/]/).some((part) => part === ".." || part === "")) return undefined;
	return entry;
}

/** `cp -a --reflink=auto`, falling back to plain `cp -a` where reflink is unsupported. */
async function copyEntry(source: string, target: string): Promise<GitResult> {
	const withReflink = await runProcess("cp", ["-a", "--reflink=auto", source, target], dirname(target), 300_000);
	if (withReflink.code === 0) return withReflink;
	if (/unrecognized option|invalid option|illegal option|unknown option/i.test(withReflink.stderr)) {
		return runProcess("cp", ["-a", source, target], dirname(target), 300_000);
	}
	return withReflink;
}

async function copyEssentials(repoRoot: string, worktreePath: string, entries: readonly string[]): Promise<string[]> {
	const warnings: string[] = [];
	for (const raw of entries) {
		const entry = normalizeCopyEntry(raw);
		if (!entry) {
			warnings.push(`copy entry "${raw}" is not a safe relative path; skipped`);
			continue;
		}
		const source = join(repoRoot, entry);
		const target = join(worktreePath, entry);
		if (!(await pathExists(source)) || (await pathExists(target))) continue;
		await mkdir(dirname(target), { recursive: true });
		const result = await copyEntry(source, target);
		if (result.code !== 0) {
			warnings.push(`could not copy ${entry}: ${firstLine(result.stderr) || `cp exited ${result.code}`}`);
		}
	}
	return warnings;
}

export interface RiffWorktreeSetup {
	worktree: RiffWorktree;
	/** Directory the riff runs in: the worktree root or the mirrored subdirectory. */
	cwd: string;
	warnings: string[];
}

export type PrepareWorktreeResult =
	| { isolated: true; setup: RiffWorktreeSetup }
	| { isolated: false; cwd: string; reason?: string; warnings: string[] };

/**
 * Isolate one riff: branch `fugue/<name>` at the current HEAD, folder next to
 * the repo, untracked essentials copied in. Returns unisolated with a reason
 * when the cwd is not a usable git repository.
 */
export async function prepareRiffWorktree(options: { name: string; cwd: string }): Promise<PrepareWorktreeResult> {
	const cwd = resolve(options.cwd);
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) return { isolated: false, cwd, reason: `${cwd} is not inside a git repository`, warnings: [] };
	const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
	const base = head.code === 0 ? head.stdout.trim() : "";
	if (!base) return { isolated: false, cwd, reason: `${repoRoot} has no commits yet`, warnings: [] };
	const allocation = await allocateWorktree(repoRoot, options.name);
	const add = await runGit(repoRoot, ["worktree", "add", "-b", allocation.branch, allocation.path, base]);
	if (add.code !== 0) {
		return {
			isolated: false,
			cwd,
			reason: `git worktree add failed: ${firstLine(add.stderr) || `exit ${add.code}`}`,
			warnings: [],
		};
	}
	const warnings: string[] = [];
	const copy = await copyEntriesFor(repoRoot, warnings);
	warnings.push(...(await copyEssentials(repoRoot, allocation.path, copy)));
	const worktree: RiffWorktree = { repoRoot, path: allocation.path, branch: allocation.branch, base, status: "active" };
	const inside = relative(repoRoot, cwd);
	let riffCwd = allocation.path;
	if (inside && !inside.startsWith("..") && !isAbsolute(inside)) {
		const sub = join(allocation.path, inside);
		if (await pathExists(sub)) riffCwd = sub;
		else warnings.push(`subdirectory ${inside} is not in the worktree; running at the worktree root`);
	}
	return { isolated: true, setup: { worktree, cwd: riffCwd, warnings } };
}

function isIdentityError(stderr: string): boolean {
	return /unable to auto-detect email address|please tell me who you are|committer identity unknown|empty ident name|author identity unknown/i.test(
		stderr,
	);
}

async function commitWithFallbackIdentity(cwd: string, message: string): Promise<GitResult> {
	const first = await runGit(cwd, ["commit", "-m", message]);
	if (first.code === 0 || !isIdentityError(first.stderr)) return first;
	return runGit(cwd, ["-c", "user.name=Fugue", "-c", "user.email=fugue@localhost", "commit", "-m", message]);
}

export interface SettleCommitResult {
	committed: boolean;
	warning?: string;
}

/**
 * Commit whatever the riff left uncommitted on its branch, so nothing is ever
 * lost. Copied essentials (node_modules, .env, ...) are excluded so secrets and
 * dependencies never enter the branch. Never rejects.
 */
export async function commitSettledWork(worktree: RiffWorktree, name: string, state: string): Promise<SettleCommitResult> {
	try {
		if (worktree.status !== "active" || !(await pathExists(worktree.path))) return { committed: false };
		const warnings: string[] = [];
		const copy = await copyEntriesFor(worktree.repoRoot, warnings);
		const excludes = copy.map((entry) => `:(exclude,literal)${entry}`);
		const add = await runGit(worktree.path, ["add", "-A", "--", ".", ...excludes]);
		if (add.code !== 0) return { committed: false, warning: `could not stage work: ${firstLine(add.stderr) || `exit ${add.code}`}` };
		const staged = await runGit(worktree.path, ["diff", "--cached", "--quiet"]);
		if (staged.code === 0) return { committed: false };
		const commit = await commitWithFallbackIdentity(worktree.path, `wip(${name}): uncommitted work at ${state}`);
		if (commit.code !== 0) return { committed: false, warning: `could not commit work: ${firstLine(commit.stderr) || `exit ${commit.code}`}` };
		return { committed: true };
	} catch (error) {
		return { committed: false, warning: errorMessage(error) };
	}
}

export interface WorktreeStats {
	commits: number;
	files: number;
}

/** Commits on the branch since its base and the files it changed, or undefined when git cannot say. */
export async function worktreeStats(worktree: RiffWorktree): Promise<WorktreeStats | undefined> {
	const count = await runGit(worktree.repoRoot, ["rev-list", "--count", `${worktree.base}..${worktree.branch}`]);
	if (count.code !== 0) return undefined;
	const commits = Number.parseInt(count.stdout.trim(), 10);
	if (!Number.isFinite(commits)) return undefined;
	const files = await runGit(worktree.repoRoot, ["diff", "--name-only", "-z", worktree.base, worktree.branch]);
	return { commits, files: files.code === 0 ? splitZ(files.stdout).length : 0 };
}

async function gitPaths(cwd: string, args: readonly string[]): Promise<string[]> {
	const result = await runGit(cwd, args);
	return result.code === 0 ? splitZ(result.stdout) : [];
}

async function conflictingPaths(repoRoot: string): Promise<string[]> {
	return gitPaths(repoRoot, ["diff", "--name-only", "--diff-filter=U", "-z"]);
}

/** Files the branch would touch that are dirty in the main checkout right now. */
async function overlappingDirtyFiles(worktree: RiffWorktree): Promise<string[]> {
	const [unstaged, staged, untracked, changed] = await Promise.all([
		gitPaths(worktree.repoRoot, ["diff", "--name-only", "-z"]),
		gitPaths(worktree.repoRoot, ["diff", "--name-only", "--cached", "-z"]),
		gitPaths(worktree.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
		gitPaths(worktree.repoRoot, ["diff", "--name-only", "-z", `HEAD...${worktree.branch}`]),
	]);
	const dirty = new Set([...unstaged, ...staged, ...untracked]);
	return changed.filter((path) => dirty.has(path));
}

async function abortMerge(repoRoot: string): Promise<void> {
	const abort = await runGit(repoRoot, ["merge", "--abort"]);
	// A squash merge that conflicted has no MERGE_HEAD, so `--abort` refuses;
	// `reset --merge` restores the same pre-merge state without touching other dirty files.
	if (abort.code !== 0) await runGit(repoRoot, ["reset", "--merge"]);
}

function listFiles(files: readonly string[]): string {
	const shown = files.slice(0, MAX_LISTED_FILES);
	const rest = files.length - shown.length;
	return `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

async function removeWorktreeAndBranch(worktree: RiffWorktree): Promise<string[]> {
	const warnings: string[] = [];
	if (await pathExists(worktree.path)) {
		const remove = await runGit(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
		if (remove.code !== 0) warnings.push(`could not remove ${worktree.path}: ${firstLine(remove.stderr) || `exit ${remove.code}`}`);
	}
	const branch = await runGit(worktree.repoRoot, ["branch", "-D", worktree.branch]);
	if (branch.code !== 0) warnings.push(`could not delete branch ${worktree.branch}: ${firstLine(branch.stderr) || `exit ${branch.code}`}`);
	return warnings;
}

export interface MergeOutcome {
	ok: boolean;
	commits: number;
	files: number;
	reason?: string;
	warnings: string[];
}

/**
 * Merge a settled riff's branch into the main checkout. Refuses when dirty
 * files in the main checkout overlap what the branch changes; on conflict the
 * merge is aborted and the checkout is left as it was.
 */
export async function mergeRiffWorktree(options: {
	worktree: RiffWorktree;
	name: string;
	squash?: boolean;
	keep?: boolean;
}): Promise<MergeOutcome> {
	const { worktree, name } = options;
	const warnings: string[] = [];
	const failure = (reason: string): MergeOutcome => ({ ok: false, commits: 0, files: 0, reason, warnings });
	if (worktree.status !== "active") return failure(`worktree is already ${worktree.status}`);
	if (!(await pathExists(worktree.path))) {
		return failure(`worktree folder ${worktree.path} is gone; branch ${worktree.branch} still holds the work`);
	}
	const leftover = await commitSettledWork(worktree, name, "merge");
	if (leftover.warning) warnings.push(leftover.warning);
	const overlapping = await overlappingDirtyFiles(worktree);
	if (overlapping.length > 0) {
		return failure(`${overlapping.length} file(s) have uncommitted changes in ${worktree.repoRoot}: ${listFiles(overlapping)}`);
	}
	const stats = await worktreeStats(worktree);
	const merge = options.squash
		? await mergeSquash(worktree)
		: await runGit(worktree.repoRoot, ["merge", "--no-ff", "-m", `merge ${worktree.branch}`, worktree.branch]);
	if (merge.code !== 0) {
		const conflicts = await conflictingPaths(worktree.repoRoot);
		await abortMerge(worktree.repoRoot);
		const detail = conflicts.length > 0 ? `conflicts in ${listFiles(conflicts)}` : firstLine(merge.stderr) || `exit ${merge.code}`;
		return failure(`merge did not apply: ${detail}`);
	}
	if (!options.keep) warnings.push(...(await removeWorktreeAndBranch(worktree)));
	return { ok: true, commits: stats?.commits ?? 0, files: stats?.files ?? 0, warnings };
}

async function mergeSquash(worktree: RiffWorktree): Promise<GitResult> {
	const merged = await runGit(worktree.repoRoot, ["merge", "--squash", worktree.branch]);
	if (merged.code !== 0) return merged;
	return commitWithFallbackIdentity(worktree.repoRoot, `squash ${worktree.branch}`);
}

export interface DiscardOutcome {
	removed: boolean;
	branchDeleted: boolean;
	warnings: string[];
}

/** Remove the worktree folder; the branch stays unless `deleteBranch`. Never rejects. */
export async function discardRiffWorktree(options: { worktree: RiffWorktree; deleteBranch?: boolean }): Promise<DiscardOutcome> {
	const { worktree } = options;
	const warnings: string[] = [];
	let removed = !(await pathExists(worktree.path));
	if (!removed) {
		const remove = await runGit(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
		if (remove.code === 0) {
			removed = true;
		} else if (isManagedWorktreePath(worktree.path)) {
			// A stale registration (folder recreated, metadata pruned) still yields to rm;
			// the path lives under our own .fugue-worktrees folder, so this is safe.
			try {
				await rm(worktree.path, { recursive: true, force: true });
				removed = true;
				await runGit(worktree.repoRoot, ["worktree", "prune"]);
			} catch (error) {
				warnings.push(`could not remove ${worktree.path}: ${errorMessage(error)}`);
			}
		} else {
			warnings.push(`could not remove ${worktree.path}: ${firstLine(remove.stderr) || `exit ${remove.code}`}`);
		}
	}
	let branchDeleted = false;
	if (options.deleteBranch) {
		const branch = await runGit(worktree.repoRoot, ["branch", "-D", worktree.branch]);
		if (branch.code === 0) branchDeleted = true;
		else warnings.push(`could not delete branch ${worktree.branch}: ${firstLine(branch.stderr) || `exit ${branch.code}`}`);
	}
	return { removed, branchDeleted, warnings };
}

function isManagedWorktreePath(path: string): boolean {
	return resolve(path).split(sep).includes(WORKTREE_DIR);
}

/**
 * At session start: `git worktree prune` for repos of hydrated riffs whose
 * folder vanished. The branch is untouched and the voice's status stays as recorded.
 */
export async function pruneVanishedWorktrees(voices: readonly Voice[]): Promise<string[]> {
	const vanished = new Map<string, boolean>();
	for (const voice of voices) {
		const worktree = voice.worktree;
		if (!worktree || worktree.status !== "active" || vanished.has(worktree.repoRoot)) continue;
		vanished.set(worktree.repoRoot, !(await pathExists(worktree.path)));
	}
	const pruned: string[] = [];
	for (const [repoRoot, missing] of vanished) {
		if (!missing) continue;
		const result = await runGit(repoRoot, ["worktree", "prune"]);
		if (result.code === 0) pruned.push(repoRoot);
	}
	return pruned;
}

/** One line per active worktree for `/fugue doctor` (name, branch, path, exists on disk). */
export async function activeWorktreeLines(voices: readonly Voice[]): Promise<string[]> {
	const active = voices.filter((voice) => voice.worktree?.status === "active");
	if (active.length === 0) return ["worktrees: none"];
	const lines: string[] = [];
	for (const voice of active) {
		const worktree = voice.worktree!;
		const exists = await pathExists(worktree.path);
		lines.push(`worktree: ${voice.name} ${worktree.branch} ${worktree.path}${exists ? "" : " (missing)"}`);
	}
	return lines;
}
