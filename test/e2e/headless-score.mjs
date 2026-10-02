/**
 * Real-host render of the Score. Runs the actual Pi InteractiveMode against a
 * capturing Terminal, mounts `src/ui/index.ts` with the 5-voice fixture at 100
 * columns, prints the compact line, then feeds arrow-down and prints the panel.
 *
 * The capturing terminal also maintains a small virtual screen (cursor moves,
 * clears, prints) so the output is the real composited frame, not the raw
 * differential stream.
 *
 * Run: node test/e2e/headless-score.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
const {
	createAgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	InteractiveMode,
} = await import(PI + "/dist/index.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_INDEX = join(HERE, "..", "..", "src", "ui", "index.ts");
const HELPERS = join(HERE, "..", "helpers.ts");
const FIXTURES = join(HERE, "..", "fixtures", "snapshots.ts");

/** Minimal ANSI screen: enough for CUP, relative moves, clears and prints. */
class VirtualScreen {
	constructor(columns, rows) {
		this.columns = columns;
		this.rows = rows;
		this.grid = Array.from({ length: rows }, () => Array(columns).fill(" "));
		this.row = 0;
		this.col = 0;
		this.saved = { row: 0, col: 0 };
		this.pending = "";
	}

	write(data) {
		const text = this.pending + data;
		this.pending = "";
		let i = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\u001b") {
				const next = text[i + 1];
				if (next === "[") {
					let j = i + 2;
					while (j < text.length && !/[@-~]/.test(text[j])) j++;
					if (j >= text.length) {
						this.pending = text.slice(i);
						break;
					}
					this.csi(text.slice(i + 2, j), text[j]);
					i = j + 1;
				} else if (next === "]" || next === "_") {
					let j = i + 2;
					while (j < text.length && text[j] !== "\u0007" && !(text[j] === "\u001b" && text[j + 1] === "\\")) j++;
					if (j >= text.length) {
						this.pending = text.slice(i);
						break;
					}
					i = text[j] === "\u0007" ? j + 1 : j + 2;
				} else {
					i += 2;
				}
				continue;
			}
			if (ch === "\n") {
				this.row = Math.min(this.rows - 1, this.row + 1);
				this.col = 0;
				i++;
				continue;
			}
			if (ch === "\r") {
				this.col = 0;
				i++;
				continue;
			}
			if (ch === "\b") {
				this.col = Math.max(0, this.col - 1);
				i++;
				continue;
			}
			if (ch === "\u0007") {
				i++;
				continue;
			}
			const char = String.fromCodePoint(text.codePointAt(i));
			if (this.row >= 0 && this.row < this.rows && this.col >= 0 && this.col < this.columns) {
				this.grid[this.row][this.col] = char;
			}
			this.col++;
			i += char.length;
		}
	}

	csi(body, final) {
		const params = body.replace(/^[?>!]/, "").split(";").map((value) => (value === "" ? 0 : Number(value)));
		const amount = params[0] || 1;
		if (final === "H" || final === "f") {
			this.row = (params[0] || 1) - 1;
			this.col = (params[1] || 1) - 1;
		} else if (final === "A") {
			this.row = Math.max(0, this.row - amount);
		} else if (final === "B") {
			this.row = Math.min(this.rows - 1, this.row + amount);
		} else if (final === "C") {
			this.col = Math.min(this.columns - 1, this.col + amount);
		} else if (final === "D") {
			this.col = Math.max(0, this.col - amount);
		} else if (final === "G") {
			this.col = (params[0] || 1) - 1;
		} else if (final === "d") {
			this.row = (params[0] || 1) - 1;
		} else if (final === "J") {
			if ((params[0] || 0) === 2) this.grid = this.grid.map(() => Array(this.columns).fill(" "));
		} else if (final === "K") {
			const mode = params[0] || 0;
			for (let x = mode === 0 ? this.col : 0; x < (mode === 1 ? this.col : this.columns); x++) this.grid[this.row][x] = " ";
		} else if (final === "s") {
			this.saved = { row: this.row, col: this.col };
		} else if (final === "u") {
			this.row = this.saved.row;
			this.col = this.saved.col;
		}
	}

	text() {
		return this.grid.map((row) => row.join("").trimEnd());
	}
}

class CapturingTerminal {
	constructor(columns, rows) {
		this.columns = columns;
		this.rows = rows;
		this.kittyProtocolActive = false;
		this.buffer = "";
		this.input = undefined;
		this.screen = new VirtualScreen(columns, rows);
	}
	start(onInput) {
		this.input = onInput;
	}
	stop() {}
	async drainInput() {}
	write(data) {
		this.buffer += data;
		this.screen.write(data);
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

const EXTENSION = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mountScore } from ${JSON.stringify(UI_INDEX)};
import { shiftToNow } from ${JSON.stringify(HELPERS)};
import { fixture5 } from ${JSON.stringify(FIXTURES)};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const snapshot = shiftToNow(fixture5());
    mountScore(pi, ctx, { snapshot: () => snapshot, subscribe: () => () => {} }, {
      tell: async () => "steered",
      resume: async () => "resumed",
      stop: async () => "stopped",
      readOutput: async () => ["+ adding src/auth/middleware.ts", "- removing the legacy check"],
    });
  });
}
`;

async function run(width) {
	const cwd = mkdtempSync(join(tmpdir(), "fugue-score-e2e-"));
	mkdirSync(join(cwd, ".pi/extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi/extensions/fugue-score.ts"), EXTENSION);

	const createRuntime = async ({ cwd: dir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd: dir });
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const terminal = new CapturingTerminal(width, 32);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: getAgentDir(),
		sessionManager: SessionManager.inMemory(cwd),
	});
	const mode = new InteractiveMode(runtime, { terminal, tuiMode: "regular" });
	await mode.init();

	console.log(`\n--- real host, terminal ${width}x32: compact line ---`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const plain = terminal.buffer
		.replace(/\u001b\][^\u0007]*\u0007/g, "")
		.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\r/g, "");
	for (const line of plain.split("\n").filter((line) => /fugue │|fugue \d+$/.test(line))) {
		console.log(`  ${JSON.stringify(line.trimEnd())}`);
	}

	terminal.input?.("\u001b[B");
	await new Promise((resolve) => setTimeout(resolve, 250));

	console.log(`\n--- real host: panel after arrow-down ---`);
	for (const line of terminal.screen.text()) {
		if (line.trim()) console.log(`  ${line}`);
	}

	await runtime.dispose();
	rmSync(cwd, { recursive: true, force: true });
}

await run(100);
