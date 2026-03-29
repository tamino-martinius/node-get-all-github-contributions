import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AccountProgress,
	ImportConfig,
	ImportData,
	ProgressStats,
} from "@/types/import";
import { Import } from "../src/import";

// --- Paths (resolved from project root, where npm run executes) ---
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const DATA_PATH = path.resolve(process.cwd(), "data/data.json");
const LOG_PATH = path.resolve(process.cwd(), "logs/import.log");
process.env.LOG_FILE_PATH = LOG_PATH;

// --- Set up debug log file ---
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// --- ANSI helpers ---
const ESC = "\x1b[";
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const BG_BLUE = `${ESC}44m`;
const FG_WHITE = `${ESC}37m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_RED = `${ESC}31m`;
const FG_CYAN = `${ESC}36m`;
const FG_MAGENTA = `${ESC}35m`;

function stripAnsi(str: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape sequence stripping
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function visualPadEnd(str: string, width: number): string {
	const visualLen = stripAnsi(str).length;
	if (visualLen >= width) return str;
	return str + " ".repeat(width - visualLen);
}

function visualTruncate(str: string, maxWidth: number): string {
	const stripped = stripAnsi(str);
	if (stripped.length <= maxWidth) return visualPadEnd(str, maxWidth);
	return `${stripped.slice(0, maxWidth - 1)}\u2026`;
}

// --- Load config & data ---
const config: ImportConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// Must always pass an object so we share the reference with Import and can observe progress
const data: ImportData = fs.existsSync(DATA_PATH)
	? JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"))
	: { accounts: {}, languageColors: {}, importState: { accountProgress: {} } };

const importer = new Import({ config, data });
const accountNames = config.accounts.map((a) => a.username);
let activeTab = 0;

// --- Data persistence ---
function saveData() {
	fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
	fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}
const saveInterval = setInterval(saveData, 30_000);

// --- Terminal setup ---
if (!process.stdin.isTTY) {
	console.error("This script requires an interactive terminal (TTY).");
	process.exit(1);
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf-8");
process.stdout.write(HIDE_CURSOR);

function cleanup() {
	process.stdout.write(SHOW_CURSOR);
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

process.on("exit", cleanup);

// --- Keyboard handling ---
process.stdin.on("data", (key: string) => {
	if (key === "\u0003" || key === "q") {
		clearInterval(renderInterval);
		clearInterval(saveInterval);
		saveData();
		cleanup();
		process.exit(0);
	}
	if (key === "\x1b[D" || key === "h") {
		activeTab = (activeTab - 1 + accountNames.length) % accountNames.length;
		render();
	}
	if (key === "\x1b[C" || key === "l") {
		activeTab = (activeTab + 1) % accountNames.length;
		render();
	}
});

// --- Status indicator ---
function statusIcon(status: string): string {
	switch (status) {
		case "completed":
			return `${FG_GREEN}\u2713${RESET}`;
		case "in-progress":
			return `${FG_YELLOW}\u25cf${RESET}`;
		case "error":
			return `${FG_RED}\u2717${RESET}`;
		default:
			return `${DIM}\u25cb${RESET}`;
	}
}

// --- Format stats ---
function formatStats(
	initial: ProgressStats,
	total: ProgressStats,
	current: ProgressStats,
): string[] {
	const entries: { label: string; key: keyof ProgressStats }[] = [
		{ label: "Repos", key: "repoCount" },
		{ label: "Branches", key: "branchCount" },
		{ label: "Commits", key: "commitCount" },
		{ label: "Additions", key: "additionCount" },
		{ label: "Deletions", key: "deletionCount" },
		{ label: "Changed Files", key: "changedFileCount" },
	];

	return entries.map(({ label, key }) => {
		const diff = total[key] - initial[key];
		const diffStr = diff > 0 ? ` ${FG_GREEN}(+${diff})${RESET}` : "";
		const pct =
			total[key] > 0 ? Math.round((current[key] / total[key]) * 100) : 0;
		const pctColor = pct >= 100 ? FG_GREEN : pct > 50 ? FG_YELLOW : FG_CYAN;
		const pctStr = total[key] > 0 ? ` ${pctColor}${pct}%${RESET}` : "";
		return `  ${label.padEnd(15)} ${String(current[key]).padStart(7)} / ${String(total[key]).padStart(7)}${diffStr}${pctStr}`;
	});
}

// --- Format rate limit ---
function formatRateLimit(
	index: number,
	rl: { remaining?: number; limit?: number; resetTimestamp?: number },
): string {
	const remaining = rl.remaining ?? "?";
	const limit = rl.limit ?? "?";

	let color = DIM;
	if (typeof rl.remaining === "number" && typeof rl.limit === "number") {
		const pct = rl.remaining / rl.limit;
		if (pct > 0.5) color = FG_GREEN;
		else if (pct > 0.2) color = FG_YELLOW;
		else if (pct > 0.05) color = FG_RED;
		else color = `${FG_RED}${BOLD}`;
	}

	let resetStr = "";
	if (rl.resetTimestamp && rl.resetTimestamp > Date.now()) {
		const resetDate = new Date(rl.resetTimestamp);
		resetStr = ` ${DIM}resets at ${new Date(resetDate).toLocaleString()}${RESET}`;
	}

	return `  Token ${index + 1}: ${color}${remaining}${RESET}/${limit}${resetStr}`;
}

// --- Render ---
function render() {
	const cols = process.stdout.columns || 120;
	const _rows = process.stdout.rows || 40;
	const lines: string[] = [];

	// Tab bar
	let tabLine = "";
	for (let i = 0; i < accountNames.length; i++) {
		const progress: AccountProgress | undefined =
			data.importState?.accountProgress?.[accountNames[i]];
		const icon = progress ? statusIcon(progress.status) : statusIcon("pending");

		if (i === activeTab) {
			tabLine += `${BG_BLUE}${FG_WHITE}${BOLD} ${icon} ${accountNames[i]} ${RESET} `;
		} else {
			tabLine += ` ${icon} ${DIM}${accountNames[i]}${RESET} `;
		}
	}
	tabLine += `  ${DIM}\u25c0 \u25b6 to switch | q to quit${RESET}`;
	lines.push(tabLine);
	lines.push(`${"─".repeat(cols)}`);

	const accountName = accountNames[activeTab];
	const progress: AccountProgress | undefined =
		data.importState?.accountProgress?.[accountName];

	if (!progress) {
		lines.push(` ${DIM}Waiting for import to start...${RESET}`);
		process.stdout.write(`${CLEAR + lines.join("\n")}\n`);
		return;
	}

	// Status message
	const statusColor =
		progress.status === "completed"
			? FG_GREEN
			: progress.status === "error"
				? FG_RED
				: progress.status === "in-progress"
					? FG_YELLOW
					: FG_CYAN;
	lines.push(` ${statusColor}${BOLD}${progress.progressMessage}${RESET}`);
	lines.push(`${"─".repeat(cols)}`);

	// Two-column layout
	const leftWidth = Math.min(Math.floor(cols * 0.55), 50);
	const rightWidth = cols - leftWidth - 3;

	const leftLines: string[] = [];
	const rightLines: string[] = [];

	// Left: Stats
	leftLines.push(`${BOLD}${FG_MAGENTA}Stats${RESET}`);
	leftLines.push(
		...formatStats(
			progress.progressStats.initial,
			progress.progressStats.total,
			progress.progressStats.current,
		),
	);

	leftLines.push("");

	if (progress.status === "error") {
		leftLines.push(`  ${DIM}See ${LOG_PATH} for full debug logs${RESET}`);
		leftLines.push("");
	}

	leftLines.push(`${BOLD}${FG_MAGENTA}Recent Activity${RESET}`);

	// Group contexts by repository, preserving insertion order
	const repoMap = new Map<
		string,
		{ name: string; branchCount?: number; branches: string[] }
	>();
	for (const ctx of progress.context) {
		if (!ctx.repositoryNode) continue;
		const key = ctx.repositoryNode.id;
		if (!repoMap.has(key)) {
			repoMap.set(key, { name: ctx.repositoryNode.name, branches: [] });
		}
		const entry = repoMap.get(key) ?? {
			name: ctx.repositoryNode.name,
			branches: [] as string[],
		};
		repoMap.set(key, entry);
		if (ctx.branchCount !== undefined) entry.branchCount = ctx.branchCount;
		if (ctx.branchNode) entry.branches.push(ctx.branchNode.name);
	}

	// Last 5 repos as sticky swimlanes
	const repoEntries = [...repoMap.values()].slice(-5);
	for (let i = 0; i < repoEntries.length; i++) {
		const entry = repoEntries[i];
		const countStr =
			entry.branchCount !== undefined
				? ` ${DIM}(${entry.branchCount} branches)${RESET}`
				: "";
		leftLines.push(`  ${FG_CYAN}${entry.name}${RESET}${countStr}`);

		// Show branches only for the last repo
		if (i === repoEntries.length - 1 && entry.branches.length > 0) {
			const recentBranches = entry.branches.slice(-5);
			const overflow = entry.branches.length - 5;
			if (overflow > 0) {
				leftLines.push(`    ${DIM}... ${overflow} more ...${RESET}`);
			}
			for (const branch of recentBranches) {
				leftLines.push(`    ${branch}`);
			}
		}
	}

	// Right: Tokens
	rightLines.push(`${BOLD}${FG_MAGENTA}Tokens${RESET}`);
	if (progress.rateLimits.length === 0) {
		rightLines.push(`  ${DIM}No token data yet${RESET}`);
	} else {
		for (let i = 0; i < progress.rateLimits.length; i++) {
			rightLines.push(formatRateLimit(i, progress.rateLimits[i]));
		}
	}

	// Merge columns
	const maxRowCount = Math.max(leftLines.length, rightLines.length);
	for (let i = 0; i < maxRowCount; i++) {
		const left = visualTruncate(leftLines[i] || "", leftWidth);
		const right = visualTruncate(rightLines[i] || "", rightWidth);
		lines.push(` ${left} ${DIM}\u2502${RESET} ${right}`);
	}

	process.stdout.write(`${CLEAR + lines.join("\n")}\n`);
}

// --- Render loop ---
const renderInterval = setInterval(render, 150);
render();

// --- Run import ---
importer
	.sync()
	.then(() => {
		render();
		clearInterval(renderInterval);
		clearInterval(saveInterval);
		saveData();
		cleanup();

		const hasErrors = Object.values(data.importState.accountProgress).some(
			(p) => p.status === "error",
		);
		if (hasErrors) {
			console.log(
				`\n${FG_YELLOW}Import completed with errors.${RESET} Data saved to data/data.json`,
			);
		} else {
			console.log(
				`\n${FG_GREEN}Import complete.${RESET} Data saved to data/data.json`,
			);
		}
		process.exit(hasErrors ? 1 : 0);
	})
	.catch((err) => {
		render();
		clearInterval(renderInterval);
		clearInterval(saveInterval);
		saveData();
		cleanup();
		console.error(`\n${FG_RED}Import failed:${RESET}`, err);
		process.exit(1);
	});
