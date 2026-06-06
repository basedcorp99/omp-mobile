import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import type {
	ApiTerminalClientMessage,
	ApiTerminalServerMessage,
	ApiTerminalTabState,
} from "./types.ts";

export interface TerminalClient {
	connectionId: string;
	clientId: string;
	connectedAtMs: number;
	send: (event: ApiTerminalServerMessage) => void;
	close: (code?: number, reason?: string) => void;
}

interface RunningTerminalTab {
	id: string;
	label: string;
	cwd: string;
	shell: string;
	cols: number;
	rows: number;
	status: "running" | "exited";
	startedAt: number;
	exitCode: number | null;
	signal: string | number | null;
	historyChunks: string[];
	historyBytes: number;
	historyTruncated: boolean;
	pendingOutput: string;
	pendingOutputTimer: ReturnType<typeof setTimeout> | null;
	decoder: TextDecoder;
	terminal: any | null;
	process: any | null;
}

interface SessionTerminalManagerOptions {
	sessionId: string;
	cwd: string;
	canWrite: (clientId: string) => boolean;
}

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;
const MIN_COLS = 20;
const MIN_ROWS = 6;
const MAX_HISTORY_BYTES = 512 * 1024;
const OUTPUT_BATCH_INTERVAL_MS = 16;
const OUTPUT_BATCH_MAX_BYTES = 64 * 1024;

function textByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function normalizeTerminalSize(cols?: number, rows?: number): { cols: number; rows: number } {
	const safeCols = Number.isFinite(cols)
		? Math.max(MIN_COLS, Math.min(320, Math.floor(Number(cols))))
		: DEFAULT_COLS;
	const safeRows = Number.isFinite(rows)
		? Math.max(MIN_ROWS, Math.min(120, Math.floor(Number(rows))))
		: DEFAULT_ROWS;
	return { cols: safeCols, rows: safeRows };
}

function normalizeCwd(input: string | undefined, fallback: string): string {
	const raw = typeof input === "string" && input.trim() ? input.trim() : fallback;
	const resolved = resolve(raw);
	return existsSync(resolved) ? resolved : fallback;
}

const SCRIPT_WRAPPER_CANDIDATES = ["/usr/bin/script", "/bin/script"];

function normalizeShellPath(shell: string | null | undefined): string | null {
	const normalized = typeof shell === "string" ? shell.trim() : "";
	if (!normalized || !normalized.startsWith("/") || !existsSync(normalized)) return null;
	const name = basename(normalized).toLowerCase();
	if (name === "false" || name === "nologin") return null;
	return normalized;
}

function resolveMachineDefaultShell(): string {
	let username = "";
	try {
		username = userInfo().username || "";
	} catch {
		// ignore
	}
	if (!username) username = process.env.USER?.trim() || process.env.LOGNAME?.trim() || "";
	if (username) {
		try {
			const line = readFileSync("/etc/passwd", "utf8")
				.split(/\r?\n/)
				.find((entry) => entry.startsWith(`${username}:`));
			const resolved = normalizeShellPath(line?.split(":").at(-1));
			if (resolved) return resolved;
		} catch {
			// ignore passwd lookup failures and fall back to env/defaults
		}
	}
	return normalizeShellPath(process.env.SHELL) || normalizeShellPath("/bin/sh") || "/bin/sh";
}

function shellQuote(value: string): string {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveShellCommand(): { shell: string; command: string[] } {
	const shell = resolveMachineDefaultShell();
	const scriptWrapper = SCRIPT_WRAPPER_CANDIDATES.find((candidate) => existsSync(candidate));
	if (scriptWrapper) {
		return {
			shell,
			command: [scriptWrapper, "-qefc", `exec ${shellQuote(shell)}`, "/dev/null"],
		};
	}
	return { shell, command: [shell] };
}

function toTerminalSnapshot(tab: RunningTerminalTab, includeHistory = false): ApiTerminalTabState {
	return {
		id: tab.id,
		label: tab.label,
		cwd: tab.cwd,
		shell: tab.shell,
		cols: tab.cols,
		rows: tab.rows,
		status: tab.status,
		startedAt: tab.startedAt,
		exitCode: tab.exitCode,
		signal: tab.signal,
		...(includeHistory
			? {
				history: tab.historyChunks.join(""),
				historyTruncated: tab.historyTruncated,
			}
			: {}),
	};
}

export class SessionTerminalManager {
	private readonly clients = new Map<string, TerminalClient>();
	private readonly tabs = new Map<string, RunningTerminalTab>();
	private sessionCwd: string;
	private nextOrdinal = 1;

	constructor(private readonly options: SessionTerminalManagerOptions) {
		this.sessionCwd = resolve(options.cwd);
	}

	setCwd(cwd: string): void {
		this.sessionCwd = resolve(cwd);
	}

	addClient(client: TerminalClient): ApiTerminalServerMessage {
		this.clients.set(client.connectionId, client);
		return {
			type: "init",
			tabs: [...this.tabs.values()].map((tab) => toTerminalSnapshot(tab, true)),
		};
	}

	removeClient(connectionId: string): void {
		this.clients.delete(connectionId);
	}

	dispose(): void {
		for (const tabId of [...this.tabs.keys()]) {
			this.disposeTab(tabId, { notify: false });
		}
		for (const client of [...this.clients.values()]) {
			try {
				client.close(1000, "session_closed");
			} catch {
				// ignore broken sockets
			}
		}
		this.clients.clear();
	}

	handleMessage(connectionId: string, message: ApiTerminalClientMessage): void {
		const client = this.clients.get(connectionId);
		if (!client) return;
		if (!message || typeof message !== "object" || typeof message.type !== "string") {
			this.sendError(connectionId, "Invalid terminal message", "invalid_message");
			return;
		}

		switch (message.type) {
			case "create_tab": {
				if (!this.assertWritable(connectionId, client.clientId)) return;
				this.createTab(connectionId, message.cwd, message.cols, message.rows);
				return;
			}
			case "input": {
				if (!this.assertWritable(connectionId, client.clientId, message.tabId)) return;
				this.writeToTab(connectionId, message.tabId, message.data);
				return;
			}
			case "resize": {
				if (!this.assertWritable(connectionId, client.clientId, message.tabId)) return;
				this.resizeTab(connectionId, message.tabId, message.cols, message.rows);
				return;
			}
			case "close_tab": {
				if (!this.assertWritable(connectionId, client.clientId, message.tabId)) return;
				this.disposeTab(message.tabId, { notify: true });
				return;
			}
			case "ping":
				return;
			default:
				this.sendError(connectionId, `Unknown terminal message: ${String((message as { type?: unknown }).type)}`, "unknown_message");
		}
	}

	private assertWritable(connectionId: string, clientId: string, tabId?: string): boolean {
		if (this.options.canWrite(clientId)) return true;
		this.sendError(connectionId, "Take over the session to use the terminal", "not_controller", tabId);
		return false;
	}

	private sendToClient(connectionId: string, event: ApiTerminalServerMessage): void {
		const client = this.clients.get(connectionId);
		if (!client) return;
		try {
			client.send(event);
		} catch {
			// ignore broken sockets
		}
	}

	private broadcast(event: ApiTerminalServerMessage): void {
		for (const client of this.clients.values()) {
			try {
				client.send(event);
			} catch {
				// ignore broken sockets
			}
		}
	}

	private sendError(connectionId: string, message: string, code = "terminal_error", tabId?: string): void {
		this.sendToClient(connectionId, {
			type: "error",
			message,
			code,
			...(tabId ? { tabId } : {}),
		});
	}

	private createTab(connectionId: string, requestedCwd?: string, cols?: number, rows?: number): void {
		if (typeof (Bun as any)?.Terminal !== "function") {
			this.sendError(connectionId, "Terminal PTY support is not available in this Bun runtime", "terminal_unavailable");
			return;
		}

		const cwd = normalizeCwd(requestedCwd, this.sessionCwd);
		const size = normalizeTerminalSize(cols, rows);
		const { shell, command } = resolveShellCommand();
		const id = randomUUID();
		const label = `${basename(shell) || "term"} ${this.nextOrdinal++}`;

		const tab: RunningTerminalTab = {
			id,
			label,
			cwd,
			shell,
			cols: size.cols,
			rows: size.rows,
			status: "running",
			startedAt: Date.now(),
			exitCode: null,
			signal: null,
			historyChunks: [],
			historyBytes: 0,
			historyTruncated: false,
			pendingOutput: "",
			pendingOutputTimer: null,
			decoder: new TextDecoder(),
			terminal: null,
			process: null,
		};

		try {
			const terminal = new Bun.Terminal({
				cols: size.cols,
				rows: size.rows,
				data: (_terminal: unknown, data: Uint8Array) => {
					this.handleTabOutput(id, data);
				},
				// NOTE: This exit fires when the PTY stream closes (EOF/error),
				// NOT when the subprocess exits. exitCode here is 0 (clean EOF) or
				// 1 (error) — PTY lifecycle, not process exit code.
				// Actual process exit is handled via onExit in Bun.spawn below.
			});

			const proc = Bun.spawn(command, {
				cwd,
				env: {
					...process.env,
					SHELL: shell,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					PROMPT_EOL_MARK: "",
					PWD: cwd,
					OMP_MOBILE_TERMINAL: "1",
					OMP_MOBILE_SESSION_ID: this.options.sessionId,
					PI_WEB_TERMINAL: "1",
					PI_WEB_SESSION_ID: this.options.sessionId,
				},
				terminal,
				onExit: (_proc, exitCode, signalCode) => {
					this.handleTabExit(id, exitCode, signalCode);
				},
			});
			// Don't let lingering shell processes block server shutdown
			proc.unref();

			tab.terminal = terminal;
			tab.process = proc;
			this.tabs.set(id, tab);
			this.broadcast({ type: "tab_opened", tab: toTerminalSnapshot(tab, false) });
		} catch (error) {
			try {
				tab.terminal?.close?.();
			} catch {
				// ignore cleanup failure
			}
			const message = error instanceof Error ? error.message : String(error);
			this.sendError(connectionId, `Failed to start terminal: ${message}`, "spawn_failed");
		}
	}

	private writeToTab(connectionId: string, tabId: string, data: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			this.sendError(connectionId, "Terminal tab not found", "tab_not_found", tabId);
			return;
		}
		if (tab.status !== "running" || !tab.terminal) {
			this.sendError(connectionId, "Terminal tab has already exited", "tab_not_running", tabId);
			return;
		}
		if (typeof data !== "string" || data.length === 0) return;
		try {
			tab.terminal.write(data);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendError(connectionId, `Failed to write to terminal: ${message}`, "write_failed", tabId);
		}
	}

	private resizeTab(connectionId: string, tabId: string, cols?: number, rows?: number): void {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			this.sendError(connectionId, "Terminal tab not found", "tab_not_found", tabId);
			return;
		}
		const size = normalizeTerminalSize(cols, rows);
		tab.cols = size.cols;
		tab.rows = size.rows;
		if (tab.status === "running" && tab.terminal) {
			try {
				tab.terminal.resize(size.cols, size.rows);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.sendError(connectionId, `Failed to resize terminal: ${message}`, "resize_failed", tabId);
				return;
			}
		}
		this.broadcast({ type: "tab_updated", tab: toTerminalSnapshot(tab, false) });
	}

	private disposeTab(tabId: string, options: { notify: boolean }): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.flushTabOutput(tabId);
		this.tabs.delete(tabId);
		if (tab.pendingOutputTimer) {
			clearTimeout(tab.pendingOutputTimer);
			tab.pendingOutputTimer = null;
		}
		tab.pendingOutput = "";
		const proc = tab.process;
		const terminal = tab.terminal;
		tab.process = null;
		tab.terminal = null;
		// Close terminal first to stop I/O callbacks
		try {
			terminal?.close?.();
		} catch {
			// ignore pty cleanup failure
		}
		// Force kill the process with SIGKILL to prevent zombie/leaked processes
		// SIGTERM alone may leave orphaned child processes
		try {
			proc?.kill?.("SIGKILL");
		} catch {
			// ignore process cleanup failure (process may have already exited)
		}
		if (options.notify) {
			this.broadcast({ type: "tab_closed", tabId });
		}
	}

	private appendHistory(tab: RunningTerminalTab, chunk: string): void {
		if (!chunk) return;
		tab.historyChunks.push(chunk);
		tab.historyBytes += textByteLength(chunk);
		while (tab.historyBytes > MAX_HISTORY_BYTES && tab.historyChunks.length > 1) {
			const removed = tab.historyChunks.shift() || "";
			tab.historyBytes -= textByteLength(removed);
			tab.historyTruncated = true;
		}
		if (tab.historyBytes > MAX_HISTORY_BYTES && tab.historyChunks.length === 1) {
			const current = tab.historyChunks[0] || "";
			const sliceStart = Math.max(0, current.length - Math.floor(MAX_HISTORY_BYTES / 2));
			tab.historyChunks[0] = current.slice(sliceStart);
			tab.historyBytes = textByteLength(tab.historyChunks[0]);
			tab.historyTruncated = true;
		}
	}

	private queueTabOutput(tabId: string, chunk: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab || !chunk) return;
		tab.pendingOutput += chunk;
		if (textByteLength(tab.pendingOutput) >= OUTPUT_BATCH_MAX_BYTES) {
			this.flushTabOutput(tabId);
			return;
		}
		if (tab.pendingOutputTimer) return;
		tab.pendingOutputTimer = setTimeout(() => {
			tab.pendingOutputTimer = null;
			this.flushTabOutput(tabId);
		}, OUTPUT_BATCH_INTERVAL_MS);
	}

	private flushTabOutput(tabId: string): void {
		const tab = this.tabs.get(tabId);
		if (!tab || !tab.pendingOutput) return;
		if (tab.pendingOutputTimer) {
			clearTimeout(tab.pendingOutputTimer);
			tab.pendingOutputTimer = null;
		}
		const data = tab.pendingOutput;
		tab.pendingOutput = "";
		this.broadcast({ type: "tab_output", tabId, data });
	}

	private handleTabOutput(tabId: string, data: Uint8Array): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const text = tab.decoder.decode(data, { stream: true });
		if (!text) return;
		this.appendHistory(tab, text);
		this.queueTabOutput(tabId, text);
	}

	private handleTabExit(tabId: string, exitCode: number, signal: string | number | null): void {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const flushed = tab.decoder.decode();
		if (flushed) {
			this.appendHistory(tab, flushed);
			this.queueTabOutput(tabId, flushed);
		}
		this.flushTabOutput(tabId);
		tab.status = "exited";
		tab.exitCode = Number.isFinite(exitCode) ? exitCode : null;
		tab.signal = signal ?? null;
		try {
			tab.terminal?.close?.();
		} catch {
			// ignore
		}
		tab.process = null;
		tab.terminal = null;
		this.broadcast({ type: "tab_updated", tab: toTerminalSnapshot(tab, false) });
	}
}
