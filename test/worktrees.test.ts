import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RiffWorktree, Voice } from "../src/types.ts";
import {
	activeWorktreeLines,
	commitSettledWork,
	discardRiffWorktree,
	findRepoRoot,
	mergeRiffWorktree,
	parseRiffWorktree,
	parseWorktreeCopy,
	prepareRiffWorktree,
	pruneVanishedWorktrees,
	worktreeStats,
} from "../src/worktrees.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function gitTry(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "" };
}

/** Temp repo as `<parent>/repo`, so worktrees land in a private `<parent>/.fugue-worktrees`. */
async function makeRepo(): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), "fugue-wt-"));
	const repo = join(parent, "repo");
	await mkdir(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	await writeFile(join(repo, "app.txt"), "one\n");
	git(repo, "add", "app.txt");
	git(repo, "commit", "-qm", "base");
	return repo;
}

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
	const repo = await makeRepo();
	try {
		await run(repo);
	} finally {
		await rm(dirname(repo), { recursive: true, force: true });
	}
}

async function prepare(repo: string, name: string, cwd = repo): Promise<NarrowedSetup> {
	const result = await prepareRiffWorktree({ name, cwd });
	assert.equal(result.isolated, true, `expected isolation for ${name}`);
	return result as NarrowedSetup;
}

interface NarrowedSetup {
	isolated: true;
	setup: { worktree: RiffWorktree; cwd: string; warnings: string[] };
}

async function commitInWorktree(worktree: RiffWorktree, file: string, content: string, message: string): Promise<void> {
	await writeFile(join(worktree.path, file), content + "\n");
	git(worktree.path, "add", "--", file);
	git(worktree.path, "commit", "-qm", message);
}

function voiceWith(worktree: RiffWorktree): Voice {
	return { runId: "run-1", name: "auth", role: "worker", parent: "conductor", origin: "fugue", state: "done", worktree };
}

test("findRepoRoot resolves the repo from a subdirectory and rejects non-repos", async () => {
	await withRepo(async (repo) => {
		await mkdir(join(repo, "src"), { recursive: true });
		assert.equal(await findRepoRoot(join(repo, "src")), repo);
		const other = await mkdtemp(join(tmpdir(), "fugue-norepo-"));
		try {
			assert.equal(await findRepoRoot(other), undefined);
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});
});

test("prepareRiffWorktree creates fugue/<name> at HEAD in .fugue-worktrees/<repo>/<leaf>", async () => {
	await withRepo(async (repo) => {
		const base = git(repo, "rev-parse", "HEAD").trim();
		const { setup } = await prepare(repo, "auth");
		assert.equal(setup.worktree.branch, "fugue/auth");
		assert.equal(setup.worktree.base, base);
		assert.equal(setup.worktree.status, "active");
		assert.equal(setup.worktree.path, join(dirname(repo), ".fugue-worktrees", "repo", "auth"));
		assert.equal(setup.cwd, setup.worktree.path);
		assert.equal(git(setup.worktree.path, "rev-parse", "--abbrev-ref", "HEAD").trim(), "fugue/auth");
		assert.equal(git(setup.worktree.path, "rev-parse", "HEAD").trim(), base);
		assert.equal(setup.warnings.length, 0);
	});
});

test("prepareRiffWorktree suffixes -2, -3 when the branch or folder is taken", async () => {
	await withRepo(async (repo) => {
		git(repo, "branch", "fugue/auth");
		const first = await prepare(repo, "auth");
		assert.equal(first.setup.worktree.branch, "fugue/auth-2");
		assert.equal(first.setup.worktree.path, join(dirname(repo), ".fugue-worktrees", "repo", "auth-2"));
		const second = await prepare(repo, "auth");
		assert.equal(second.setup.worktree.branch, "fugue/auth-3");
		await rm(second.setup.worktree.path, { recursive: true, force: true });
		await mkdir(join(dirname(repo), ".fugue-worktrees", "repo", "auth-4"), { recursive: true });
		const third = await prepare(repo, "auth");
		assert.equal(third.setup.worktree.branch, "fugue/auth-5");
	});
});

test("prepareRiffWorktree mirrors a subdirectory cwd inside the worktree", async () => {
	await withRepo(async (repo) => {
		await mkdir(join(repo, "src", "deep"), { recursive: true });
		await writeFile(join(repo, "src", "deep", "file.txt"), "x\n");
		git(repo, "add", "src");
		git(repo, "commit", "-qm", "add src");
		const { setup } = await prepare(repo, "auth", join(repo, "src"));
		assert.equal(setup.cwd, join(setup.worktree.path, "src"));
		assert.ok(existsSync(join(setup.cwd, "deep", "file.txt")));
	});
});

test("prepareRiffWorktree copies node_modules and .env but not with a config override", async () => {
	await withRepo(async (repo) => {
		await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(repo, "node_modules", "pkg", "index.js"), "module\n");
		await writeFile(join(repo, ".env"), "SECRET=1\n");
		const { setup } = await prepare(repo, "auth");
		assert.ok(existsSync(join(setup.worktree.path, "node_modules", "pkg", "index.js")));
		assert.ok(existsSync(join(setup.worktree.path, ".env")));
	});
	await withRepo(async (repo) => {
		await mkdir(join(repo, "node_modules"), { recursive: true });
		await writeFile(join(repo, "node_modules", "in.js"), "x\n");
		await mkdir(join(repo, "vendor"), { recursive: true });
		await writeFile(join(repo, "vendor", "lib.js"), "v\n");
		await mkdir(join(repo, ".pi"), { recursive: true });
		await writeFile(join(repo, ".pi", "fugue.json"), JSON.stringify({ worktree: { copy: ["vendor"] } }));
		const { setup } = await prepare(repo, "auth");
		assert.ok(existsSync(join(setup.worktree.path, "vendor", "lib.js")));
		assert.ok(!existsSync(join(setup.worktree.path, "node_modules")));
	});
});

test("prepareRiffWorktree without node_modules copies nothing and warns about nothing", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		assert.ok(!existsSync(join(setup.worktree.path, "node_modules")));
		assert.deepEqual(setup.warnings, []);
	});
});

test("prepareRiffWorktree reports a non-git cwd instead of failing", async () => {
	const plain = await mkdtemp(join(tmpdir(), "fugue-plain-"));
	try {
		const result = await prepareRiffWorktree({ name: "auth", cwd: plain });
		assert.equal(result.isolated, false);
		assert.match(result.reason ?? "", /not inside a git repository/);
		assert.equal(result.cwd, plain);
	} finally {
		await rm(plain, { recursive: true, force: true });
	}
});

test("commitSettledWork commits tracked and untracked changes and excludes copied essentials", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await writeFile(join(worktree.path, "app.txt"), "one\ntwo\n");
		await writeFile(join(worktree.path, "new.txt"), "new\n");
		await mkdir(join(worktree.path, "node_modules", "dep"), { recursive: true });
		await writeFile(join(worktree.path, "node_modules", "dep", "index.js"), "dep\n");
		await writeFile(join(worktree.path, ".env"), "SECRET=1\n");
		const result = await commitSettledWork(worktree, "auth", "done");
		assert.equal(result.committed, true);
		assert.equal(git(worktree.path, "log", "-1", "--format=%s").trim(), "wip(auth): uncommitted work at done");
		const changed = git(worktree.path, "show", "--name-only", "--format=");
		assert.match(changed, /app\.txt/);
		assert.match(changed, /new\.txt/);
		assert.doesNotMatch(changed, /node_modules/);
		assert.doesNotMatch(changed, /\.env/);
		assert.equal((await commitSettledWork(worktree, "auth", "done")).committed, false);
	});
});

test("mergeRiffWorktree merges clean work and removes the worktree and branch", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await commitInWorktree(worktree, "feature.txt", "from the riff", "add feature");
		const outcome = await mergeRiffWorktree({ worktree, name: "auth" });
		assert.equal(outcome.ok, true, outcome.reason);
		assert.equal(outcome.commits, 1);
		assert.equal(outcome.files, 1);
		assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "merge fugue/auth");
		assert.equal(git(repo, "show", "HEAD:feature.txt"), "from the riff\n");
		assert.ok(!existsSync(worktree.path));
		assert.notEqual(gitTry(repo, "rev-parse", "--verify", "--quiet", "refs/heads/fugue/auth").status, 0);
	});
});

test("mergeRiffWorktree aborts a conflict and leaves the main checkout untouched", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await commitInWorktree(worktree, "app.txt", "from the riff", "change app");
		await writeFile(join(repo, "app.txt"), "from main\n");
		git(repo, "commit", "-qam", "change app in main");
		const head = git(repo, "rev-parse", "HEAD").trim();
		const outcome = await mergeRiffWorktree({ worktree, name: "auth" });
		assert.equal(outcome.ok, false);
		assert.match(outcome.reason ?? "", /conflicts in app\.txt/);
		assert.equal(git(repo, "rev-parse", "HEAD").trim(), head);
		assert.equal(git(repo, "status", "--porcelain"), "");
		assert.ok(!existsSync(join(repo, ".git", "MERGE_HEAD")));
		assert.equal(git(repo, "show", "HEAD:app.txt"), "from main\n");
		assert.ok(existsSync(worktree.path));
	});
});

test("mergeRiffWorktree aborts a squash conflict too", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await commitInWorktree(worktree, "app.txt", "from the riff", "change app");
		await writeFile(join(repo, "app.txt"), "from main\n");
		git(repo, "commit", "-qam", "change app in main");
		const head = git(repo, "rev-parse", "HEAD").trim();
		const outcome = await mergeRiffWorktree({ worktree, name: "auth", squash: true });
		assert.equal(outcome.ok, false);
		assert.match(outcome.reason ?? "", /conflicts in app\.txt/);
		assert.equal(git(repo, "rev-parse", "HEAD").trim(), head);
		assert.equal(git(repo, "status", "--porcelain"), "");
		assert.equal(git(repo, "show", "HEAD:app.txt"), "from main\n");
	});
});

test("mergeRiffWorktree refuses when dirty files in the main checkout overlap", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await commitInWorktree(worktree, "app.txt", "from the riff", "change app");
		await writeFile(join(repo, "app.txt"), "one\nlocal edit\n");
		const outcome = await mergeRiffWorktree({ worktree, name: "auth" });
		assert.equal(outcome.ok, false);
		assert.match(outcome.reason ?? "", /uncommitted changes in/);
		assert.match(outcome.reason ?? "", /app\.txt/);
		assert.equal(git(repo, "show", "HEAD:app.txt"), "one\n");
		assert.ok(existsSync(worktree.path));
	});
});

test("mergeRiffWorktree merges when dirty files do not overlap", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await commitInWorktree(worktree, "feature.txt", "from the riff", "add feature");
		await writeFile(join(repo, "app.txt"), "one\nlocal edit\n");
		const outcome = await mergeRiffWorktree({ worktree, name: "auth" });
		assert.equal(outcome.ok, true, outcome.reason);
		assert.equal(git(repo, "show", "HEAD:feature.txt"), "from the riff\n");
		assert.equal(git(repo, "status", "--porcelain").trim(), "M app.txt");
		assert.equal(git(repo, "show", "HEAD:app.txt"), "one\n");
		assert.ok(!existsSync(worktree.path));
	});
});

test("mergeRiffWorktree squashes on request", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await commitInWorktree(worktree, "one.txt", "one", "first");
		await commitInWorktree(worktree, "two.txt", "two", "second");
		const outcome = await mergeRiffWorktree({ worktree, name: "auth", squash: true });
		assert.equal(outcome.ok, true, outcome.reason);
		assert.equal(outcome.commits, 2);
		assert.equal(outcome.files, 2);
		assert.equal(git(repo, "log", "-1", "--format=%s").trim(), "squash fugue/auth");
		assert.equal(git(repo, "log", "-1", "--format=%P").trim().includes(" "), false);
		assert.equal(git(repo, "show", "HEAD:two.txt"), "two\n");
	});
});

test("mergeRiffWorktree commits leftovers before merging and keeps the branch with keep", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const worktree = setup.worktree;
		await writeFile(join(worktree.path, "leftover.txt"), "not committed\n");
		const outcome = await mergeRiffWorktree({ worktree, name: "auth", keep: true });
		assert.equal(outcome.ok, true, outcome.reason);
		assert.equal(outcome.commits, 1);
		assert.equal(git(repo, "log", "-1", "--format=%s", "fugue/auth").trim(), "wip(auth): uncommitted work at merge");
		assert.equal(git(repo, "show", "HEAD:leftover.txt"), "not committed\n");
		assert.ok(existsSync(worktree.path));
		assert.equal(git(repo, "rev-parse", "--verify", "refs/heads/fugue/auth").trim().length, 40);
	});
});

test("discardRiffWorktree removes the folder and keeps the branch unless asked", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const outcome = await discardRiffWorktree({ worktree: setup.worktree });
		assert.equal(outcome.removed, true);
		assert.equal(outcome.branchDeleted, false);
		assert.ok(!existsSync(setup.worktree.path));
		assert.equal(git(repo, "rev-parse", "--verify", "refs/heads/fugue/auth").trim().length, 40);
	});
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		const outcome = await discardRiffWorktree({ worktree: setup.worktree, deleteBranch: true });
		assert.equal(outcome.removed, true);
		assert.equal(outcome.branchDeleted, true);
		assert.notEqual(gitTry(repo, "rev-parse", "--verify", "--quiet", "refs/heads/fugue/auth").status, 0);
	});
});

test("pruneVanishedWorktrees prunes the missing worktree and leaves the branch and status", async () => {
	await withRepo(async (repo) => {
		const { setup } = await prepare(repo, "auth");
		await commitInWorktree(setup.worktree, "feature.txt", "x", "work");
		const before = await worktreeStats(setup.worktree);
		assert.deepEqual(before, { commits: 1, files: 1 });
		assert.deepEqual(await activeWorktreeLines([voiceWith(setup.worktree)]), [
			`worktree: auth fugue/auth ${setup.worktree.path}`,
		]);
		await rm(setup.worktree.path, { recursive: true, force: true });
		assert.deepEqual(await activeWorktreeLines([voiceWith(setup.worktree)]), [
			`worktree: auth fugue/auth ${setup.worktree.path} (missing)`,
		]);
		const pruned = await pruneVanishedWorktrees([voiceWith(setup.worktree)]);
		assert.deepEqual(pruned, [repo]);
		assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), new RegExp(setup.worktree.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(git(repo, "rev-parse", "--verify", "refs/heads/fugue/auth").trim().length, 40);
		assert.equal(setup.worktree.status, "active");
	});
});

test("parseRiffWorktree accepts a full worktree and rejects malformed ones", () => {
	const worktree: RiffWorktree = {
		repoRoot: "/repo",
		path: "/wt/auth",
		branch: "fugue/auth",
		base: "abc123",
		status: "active",
	};
	assert.deepEqual(parseRiffWorktree(worktree), worktree);
	assert.deepEqual(parseRiffWorktree({ ...worktree, status: "merged" }), { ...worktree, status: "merged" });
	assert.equal(parseRiffWorktree({ ...worktree, status: "gone" }), undefined);
	assert.equal(parseRiffWorktree({ ...worktree, branch: "" }), undefined);
	assert.equal(parseRiffWorktree("nope"), undefined);
	assert.equal(parseRiffWorktree(undefined), undefined);
});

test("parseWorktreeCopy reads the config and rejects every malformed shape", () => {
	assert.deepEqual(parseWorktreeCopy('{"gates":[]}'), {});
	assert.deepEqual(parseWorktreeCopy('{"worktree":{"copy":["vendor"," cache "]}}'), { copy: ["vendor", "cache"] });
	assert.deepEqual(parseWorktreeCopy('{"worktree":{"copy":[]}}'), { copy: [] });
	assert.match(parseWorktreeCopy("{oops").error ?? "", /not valid JSON/);
	assert.match(parseWorktreeCopy("[]").error ?? "", /expected a JSON object/);
	assert.match(parseWorktreeCopy('{"worktree":3}').error ?? "", /"worktree" must be an object/);
	assert.match(parseWorktreeCopy('{"worktree":{"copy":[1]}}').error ?? "", /array of strings/);
});
