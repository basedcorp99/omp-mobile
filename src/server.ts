import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { PiWebRuntime, type SessionClient } from "./session-runtime.ts";
import { FaceIdService } from "./faceid.ts";
import { PushService } from "./push.ts";
import { getSystemPiEntryPath } from "./system-pi.ts";
import { transcribeAudio, getVoiceStatus } from "./voice.ts";

const _systemPiEntryPath = getSystemPiEntryPath();
const _packageRoot = dirname(_systemPiEntryPath);
const { discoverAgents } = await import(join(_packageRoot, "task", "discovery.ts"));
import type {
	ApiCommandRequest,
	ApiActiveSessionsResponse,
	ApiAddRepoRequest,
	ApiCreateSessionRequest,
	ApiErrorResponse,
	ApiForkSessionRequest,
	ApiListModelsResponse,
	ApiListReposResponse,
	ApiListSessionsResponse,
	ApiNavigateTreeRequest,
	ApiOkResponse,
	ApiReleaseRequest,
	ApiSessionState,
	ApiTakeoverRequest,
	SseEvent,
	ApiTerminalClientMessage,
	ApiTerminalServerMessage,
} from "./types.ts";

interface ServerArgs {
	host: string;
	port: number;
	token: string | null;
	tls: { certFile: string; keyFile: string } | null;
}

function stripBrackets(host: string): string {
	const trimmed = host.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
	return trimmed;
}

function parseIpv4(host: string): [number, number, number, number] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const nums = parts.map((p) => Number.parseInt(p, 10));
	if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
	return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isTailnetHost(host: string): boolean {
	const normalized = stripBrackets(host).trim().toLowerCase();
	const base = normalized.split("%")[0] || normalized;
	const ip4 = parseIpv4(base);
	if (ip4) {
		const [a, b] = ip4;
		// Tailscale IPv4 addresses live in 100.64.0.0/10.
		return a === 100 && b >= 64 && b <= 127;
	}

	// Tailscale IPv6 ULA prefix is fd7a:115c:a1e0::/48.
	return base.startsWith("fd7a:115c:a1e0:");
}

function isAnyAddressHost(host: string): boolean {
	const normalized = stripBrackets(host).trim().toLowerCase();
	return (
		normalized === "0.0.0.0" ||
		normalized === "::" ||
		normalized === "0:0:0:0:0:0:0:0"
	);
}

function parseArgs(argv: string[]): ServerArgs {
	const args = argv.slice(2);
	let host = process.env.PI_WEB_HOST?.trim() || "localhost";
	let port = Number.parseInt(process.env.PI_WEB_PORT?.trim() || "4317", 10);
	let token = process.env.PI_WEB_TOKEN?.trim() || null;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--host" && i + 1 < args.length) {
			host = args[++i];
		} else if (arg === "--port" && i + 1 < args.length) {
			port = Number.parseInt(args[++i] ?? "", 10);
		} else if (arg === "--token" && i + 1 < args.length) {
			token = args[++i] ?? null;
		} else if (arg === "--help" || arg === "-h") {
			console.log(`pi-web

Usage:
  bun run dev [--host <host>] [--port <port>] [--token <token>]

Env:
  PI_WEB_HOST
  PI_WEB_PORT
  PI_WEB_TOKEN
  PI_WEB_PUSH_SUBJECT
`);
			process.exit(0);
		}
	}

	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid port: ${String(port)}`);
	}
	if (isAnyAddressHost(host)) {
		throw new Error(
			"Binding to 0.0.0.0/:: is disabled. Use localhost/127.0.0.1 (local) or your Tailscale IP (100.x or fd7a:115c:a1e0::/48).",
		);
	}

	let tls: ServerArgs["tls"] = null;
	if (isTailnetHost(host)) {
		const tlsDir = join(import.meta.dir, "..", ".tls");
		const certs = existsSync(tlsDir)
			? (Bun.spawnSync(["ls", tlsDir]).stdout.toString().trim().split("\n"))
			: [];
		const certFile = certs.find((f) => f.endsWith(".crt"));
		const keyFile = certs.find((f) => f.endsWith(".key"));
		if (certFile && keyFile) {
			tls = { certFile: join(tlsDir, certFile), keyFile: join(tlsDir, keyFile) };
		}
	}

	return { host, port, token, tls };
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	if (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized === "0:0:0:0:0:0:0:1"
	) {
		return true;
	}
	return normalized.startsWith("127.");
}

function formatSubjectHost(host: string): string {
	const normalized = stripBrackets(host).trim().split("%")[0] || "";
	if (!normalized) return "";
	return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function getTlsSubjectHost(certFile: string | null | undefined): string | null {
	if (!certFile || !existsSync(certFile)) return null;
	try {
		const cert = new X509Certificate(readFileSync(certFile, "utf8"));
		const sanEntries = (cert.subjectAltName || "").split(/,\s*/).map((entry) => entry.trim()).filter(Boolean);
		const dnsEntry = sanEntries.find((entry) => entry.startsWith("DNS:"));
		if (dnsEntry) return dnsEntry.slice(4).trim();
		const cnMatch = cert.subject.match(/(?:^|,\s*)CN\s*=\s*([^,]+)/i);
		if (cnMatch?.[1]) return cnMatch[1].trim();
	} catch {
		// ignore
	}
	return null;
}

function resolvePreferredPushSubject(host: string, tls: ServerArgs["tls"]): string | null {
	const explicit = process.env.PI_WEB_PUSH_SUBJECT?.trim();
	if (explicit) return explicit;

	const certHost = getTlsSubjectHost(tls?.certFile);
	const fallbackHost = formatSubjectHost(host);
	const subjectHost = certHost || fallbackHost;
	if (!subjectHost || isLoopbackHost(subjectHost) || isAnyAddressHost(subjectHost)) return null;
	return `https://${subjectHost}`;
}

function resolveBearerToken(req: Request): string | null {
	const headerValue = req.headers.get("authorization");
	if (!headerValue) return null;
	const normalized = headerValue.trim();
	if (!normalized.toLowerCase().startsWith("bearer ")) return null;
	const token = normalized.slice(7).trim();
	return token.length > 0 ? token : null;
}

function resolveRequestToken(req: Request, url: URL): string | null {
	return url.searchParams.get("token")?.trim() || resolveBearerToken(req);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function ok(): Response {
	const body: ApiOkResponse = { ok: true };
	return json(body, 200);
}

function errorResponse(message: string, status: number): Response {
	const body: ApiErrorResponse = { error: message };
	return json(body, status);
}

function serveStatic(path: string, contentType?: string): Response {
	if (!existsSync(path)) {
		return new Response("Not found", { status: 404 });
	}
	const file = Bun.file(path);
	return new Response(file, {
		status: 200,
		headers: {
			"content-type": contentType ?? file.type ?? "application/octet-stream",
			"cache-control": "no-store",
		},
	});
}

function createSseStream(signal: AbortSignal) {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let keepAlive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			keepAlive = setInterval(() => {
				if (!controller) return;
				const ping: SseEvent = { type: "ping" };
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(ping)}\n\n`));
			}, 5_000);
		},
		cancel() {
			controller = null;
			if (keepAlive) clearInterval(keepAlive);
			keepAlive = null;
		},
	});

	const close = () => {
		if (!controller) return;
		try {
			controller.close();
		} catch {
			// ignore
		}
		controller = null;
		if (keepAlive) clearInterval(keepAlive);
		keepAlive = null;
	};

	const send = (event: SseEvent) => {
		if (!controller) return;
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	};

	signal.addEventListener("abort", close, { once: true });

	const response = new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		},
	});

	return { response, send, close };
}

const { host, port, token, tls } = parseArgs(process.argv);
const pushService = new PushService();
await pushService.init(resolvePreferredPushSubject(host, tls));
const runtime = new PiWebRuntime({
	onMessageNotification: async (payload) => {
		const title = `pi${payload.sessionName ? ` · ${payload.sessionName}` : ""}`;
		const body = payload.messageText.length > 140 ? `${payload.messageText.slice(0, 137)}…` : payload.messageText;
		const result = await pushService.send({
			title,
			body,
			url: `/?session=${encodeURIComponent(payload.sessionId)}`,
			sessionId: payload.sessionId,
			sessionName: payload.sessionName,
			tag: payload.sessionId,
		});
		if (result.sent > 0 || result.failed > 0 || result.suppressed) {
			console.log(`[push] sent=${result.sent} failed=${result.failed} suppressed=${result.suppressed ? 1 : 0} client=${result.targetClientId || "-"} reason=${result.reason} title="${title}"`);
		}
	},
});
const faceId = new FaceIdService();
const requiresAuth = !isLoopbackHost(host) && !isTailnetHost(host);
const replayEnabled = process.env.PI_WEB_REPLAY?.trim() === "1";

if (requiresAuth && !token) {
	throw new Error(`Missing token. Provide --token <token> or set PI_WEB_TOKEN when binding to non-loopback host (${host}).`);
}

const publicDir = join(import.meta.dir, "..", "public");
const publicRoot = resolve(publicDir) + sep;
const simpleWebAuthnBrowserDir = join(import.meta.dir, "..", "node_modules", "@simplewebauthn", "browser", "esm");
const simpleWebAuthnBrowserRoot = resolve(simpleWebAuthnBrowserDir) + sep;
const simpleWebAuthnBrowserUrlPrefix = "/vendor/simplewebauthn/browser/esm/";
const vendorStaticFiles = new Map<string, { path: string; contentType?: string }>([
	[
		"/vendor/xterm/xterm.mjs",
		{
			path: join(import.meta.dir, "..", "node_modules", "@xterm", "xterm", "lib", "xterm.mjs"),
			contentType: "text/javascript; charset=utf-8",
		},
	],
	[
		"/vendor/xterm/xterm.css",
		{
			path: join(import.meta.dir, "..", "node_modules", "@xterm", "xterm", "css", "xterm.css"),
			contentType: "text/css; charset=utf-8",
		},
	],
	[
		"/vendor/xterm/addon-fit.mjs",
		{
			path: join(import.meta.dir, "..", "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
			contentType: "text/javascript; charset=utf-8",
		},
	],
	[
		"/vendor/xterm/addon-search.mjs",
		{
			path: join(import.meta.dir, "..", "node_modules", "@xterm", "addon-search", "lib", "addon-search.mjs"),
			contentType: "text/javascript; charset=utf-8",
		},
	],
	[
		"/vendor/xterm/addon-web-links.mjs",
		{
			path: join(import.meta.dir, "..", "node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.mjs"),
			contentType: "text/javascript; charset=utf-8",
		},
	],
]);

function requireJsonBody(req: Request): Promise<Record<string, unknown>> {
	return req.json().catch(() => ({}));
}

const DIRECTORY_SEARCH_LIMIT = 20;
const DIRECTORY_SEARCH_CACHE_TTL_MS = 60_000;
const DIRECTORY_SEARCH_ROOTS = ["/root", "/home"];
const directoryIndexCache: {
	dirs: string[];
	expiresAt: number;
	inflight: Promise<string[]> | null;
} = {
	dirs: [],
	expiresAt: 0,
	inflight: null,
};

function hasExecutable(path: string | null | undefined): path is string {
	return Boolean(path && existsSync(path));
}

function parseSearchLines(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => existsSync(line))
		.filter((line) => isSearchableDirectory(line));
}

function isSearchableDirectory(path: string): boolean {
	const normalized = path.trim();
	if (!normalized) return false;
	if (normalized.includes("/.git/") || normalized.endsWith("/.git")) return false;
	if (normalized.includes("/node_modules/") || normalized.endsWith("/node_modules")) return false;
	if (normalized.includes("/dist/") || normalized.endsWith("/dist")) return false;
	if (normalized.includes("/build/") || normalized.endsWith("/build")) return false;
	if (normalized.includes("/coverage/") || normalized.endsWith("/coverage")) return false;
	if (normalized.includes("/.next/") || normalized.endsWith("/.next")) return false;
	if (normalized.includes("/.turbo/") || normalized.endsWith("/.turbo")) return false;
	if (normalized.includes("/target/") || normalized.endsWith("/target")) return false;
	if (normalized.includes("/.cache/") || normalized.endsWith("/.cache")) return false;
	if (normalized.includes("/.bun/install/cache/") || normalized.endsWith("/.bun/install/cache")) return false;
	if (normalized.includes("/.pi/agent/sessions/") || normalized.endsWith("/.pi/agent/sessions")) return false;
	return true;
}

function splitSearchTokens(input: string): string[] {
	return input.toLowerCase().split(/[\s/_-]+/).map((token) => token.trim()).filter(Boolean);
}

function pathHasHiddenSegment(path: string): boolean {
	return path
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean)
		.some((part) => part !== "." && part !== ".." && part !== "~" && part.startsWith(".") && part.length > 1);
}

function queryAllowsHiddenSearch(query: string): boolean {
	return query.includes(".");
}

function compactSearchText(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isSubsequence(needle: string, haystack: string): boolean {
	if (!needle) return true;
	let index = 0;
	for (const ch of haystack) {
		if (ch === needle[index]) index += 1;
		if (index >= needle.length) return true;
	}
	return false;
}

function scoreDirectoryMatch(path: string, query: string): number {
	const lowerPath = path.toLowerCase();
	const parts = lowerPath.split("/").filter(Boolean);
	const baseName = parts[parts.length - 1] || lowerPath;
	const queryLower = query.trim().toLowerCase();
	const tokens = splitSearchTokens(queryLower);
	const compactQuery = compactSearchText(queryLower);
	const compactBase = compactSearchText(baseName);
	const compactPath = compactSearchText(lowerPath);
	let score = 0;

	if (baseName === queryLower || (compactQuery && compactBase === compactQuery)) score += 2_000;
	if (baseName.startsWith(queryLower) || (compactQuery && compactBase.startsWith(compactQuery))) score += 1_200;
	if (baseName.includes(queryLower) || (compactQuery && compactBase.includes(compactQuery))) score += 900;
	if (lowerPath.includes(queryLower)) score += 500;
	if (tokens.length > 0 && tokens.every((token) => baseName.includes(token))) score += 700;
	if (tokens.length > 0 && tokens.every((token) => lowerPath.includes(token))) score += 400;
	if (compactQuery && isSubsequence(compactQuery, compactBase)) score += 280;
	if (compactQuery && isSubsequence(compactQuery, compactPath)) score += 140;

	const depth = parts.length;
	// Heavily penalize deep subdirectories — users want project roots
	score -= depth * 30;
	if (depth <= 2) score += 200;
	else if (depth <= 3) score += 80;
	if (lowerPath.includes("/.worktrees/worktree-")) {
		const wtDepth = lowerPath.split("/.worktrees/worktree-")[1];
		if (wtDepth && !wtDepth.includes("/")) score += 150;
	}
	if (lowerPath.startsWith("/root/")) score += 10;
	return score;
}

function uniqueDirs(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const candidate of paths) {
		const normalized = candidate.trim();
		if (!normalized || seen.has(normalized) || !isSearchableDirectory(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function buildDirectoryIndex(): Promise<string[]> {
	const roots = DIRECTORY_SEARCH_ROOTS.filter((root) => existsSync(root));
	if (roots.length === 0) return Promise.resolve([]);

	const pruneNames = [".git", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "target", ".cache"];
	const pruneExpression = pruneNames.flatMap((name, index) => [
		...(index > 0 ? ["-o"] : []),
		"-name",
		name,
	]);
	const args = [
		...roots,
		"(",
		...pruneExpression,
		")",
		"-prune",
		"-o",
		"-type",
		"d",
		"-print",
	];

	return new Promise((resolve, reject) => {
		execFile("find", args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error && (error as NodeJS.ErrnoException).killed) return reject(new Error("Search timed out"));
			resolve(uniqueDirs(parseSearchLines(stdout || "")));
		});
	});
}

async function getDirectoryIndex(): Promise<string[]> {
	if (directoryIndexCache.dirs.length > 0 && directoryIndexCache.expiresAt > Date.now()) {
		return directoryIndexCache.dirs;
	}
	if (directoryIndexCache.inflight) return directoryIndexCache.inflight;

	const inflight = buildDirectoryIndex()
		.then((dirs) => {
			directoryIndexCache.dirs = dirs;
			directoryIndexCache.expiresAt = Date.now() + DIRECTORY_SEARCH_CACHE_TTL_MS;
			return dirs;
		})
		.finally(() => {
			directoryIndexCache.inflight = null;
		});

	directoryIndexCache.inflight = inflight;
	return inflight;
}

function queryZoxideDirs(query: string): Promise<string[]> {
	const zoxideBin = hasExecutable("/root/.local/bin/zoxide")
		? "/root/.local/bin/zoxide"
		: hasExecutable("/usr/bin/zoxide")
			? "/usr/bin/zoxide"
			: hasExecutable("/usr/local/bin/zoxide")
				? "/usr/local/bin/zoxide"
				: null;
	if (!zoxideBin) return Promise.resolve([]);

	return new Promise((resolve, reject) => {
		execFile(zoxideBin, ["query", "-l", query], { timeout: 1_500 }, (error, stdout) => {
			if (error && (error as NodeJS.ErrnoException).killed) return reject(new Error("Search timed out"));
			resolve(uniqueDirs(parseSearchLines(stdout || "")));
		});
	});
}

function queryFzfDirs(query: string, dirs: string[]): Promise<string[]> {
	const fzfBin = hasExecutable("/usr/bin/fzf")
		? "/usr/bin/fzf"
		: hasExecutable("/usr/local/bin/fzf")
			? "/usr/local/bin/fzf"
			: null;
	if (!fzfBin || dirs.length === 0) return Promise.resolve([]);

	return new Promise((resolve, reject) => {
		const child = spawn(fzfBin, ["--filter", query], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			settled = true;
			child.kill("SIGKILL");
			reject(new Error("Search timed out"));
		}, 2_500);

		child.on("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve([]);
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (code !== 0 && code !== 1) {
				console.warn(`[dirs/search] fzf exited with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ""}`);
				resolve([]);
				return;
			}
			resolve(uniqueDirs(parseSearchLines(stdout)));
		});
		child.stdin.end(`${dirs.join("\n")}\n`);
	});
}

function rankDirectoryMatches(query: string, dirs: string[]): string[] {
	const allowHidden = queryAllowsHiddenSearch(query);
	return uniqueDirs(dirs)
		.filter((path) => allowHidden || !pathHasHiddenSegment(path))
		.map((path) => ({ path, score: scoreDirectoryMatch(path, query) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, DIRECTORY_SEARCH_LIMIT)
		.map((entry) => entry.path);
}

async function fuzzyFindDirs(query: string): Promise<string[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const allowHidden = queryAllowsHiddenSearch(trimmed);

	const dirs = await getDirectoryIndex();
	const rankedFallback = rankDirectoryMatches(trimmed, dirs);
	const [zoxideResults, fzfResults] = await Promise.all([
		queryZoxideDirs(trimmed).catch(() => []),
		queryFzfDirs(trimmed, dirs).catch(() => []),
	]);

	const zoxideSet = new Set(zoxideResults);
	const fzfSet = new Set(fzfResults);
	return uniqueDirs([...zoxideResults, ...fzfResults, ...rankedFallback])
		.filter((path) => allowHidden || !pathHasHiddenSegment(path))
		.map((path) => ({
			path,
			score: scoreDirectoryMatch(path, trimmed) + (zoxideSet.has(path) ? 600 : 0) + (fzfSet.has(path) ? 250 : 0),
		}))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, DIRECTORY_SEARCH_LIMIT)
		.map((entry) => entry.path);
}

function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

function ensureApiAuth(req: Request, url: URL): Response | null {
	if (!requiresAuth) return null;
	if (!isApiPath(url.pathname)) return null;
	const provided = resolveRequestToken(req, url);
	if (provided !== token) {
		return errorResponse("Unauthorized. Provide ?token=... or Authorization: Bearer <token>.", 401);
	}
	return null;
}

function resolvePublicFile(url: URL): string | null {
	let relPath = url.pathname.replace(/^\/+/, "");
	if (!relPath) return null;

	// Disallow replay fixtures unless explicitly enabled.
	if (relPath.startsWith("fixtures/") && !replayEnabled) return null;

	try {
		relPath = decodeURIComponent(relPath);
	} catch {
		return null;
	}

	const full = resolve(publicDir, relPath);
	if (!full.startsWith(publicRoot)) return null;
	return full;
}

function resolveSimpleWebAuthnBrowserFile(url: URL): string | null {
	if (!url.pathname.startsWith(simpleWebAuthnBrowserUrlPrefix)) return null;
	let relPath = url.pathname.slice(simpleWebAuthnBrowserUrlPrefix.length).replace(/^\/+/, "");
	if (!relPath) return null;

	try {
		relPath = decodeURIComponent(relPath);
	} catch {
		return null;
	}

	const full = resolve(simpleWebAuthnBrowserDir, relPath);
	if (!full.startsWith(simpleWebAuthnBrowserRoot)) return null;
	return full;
}

function parseSessionRoute(pathname: string): { sessionId: string; action: string } | null {
	const parts = pathname.split("/").filter((p) => p.length > 0);
	if (parts.length !== 4) return null;
	if (parts[0] !== "api" || parts[1] !== "sessions") return null;
	return { sessionId: parts[2], action: parts[3] };
}

interface TerminalWebSocketData {
	kind: "terminal";
	sessionId: string;
	clientId: string;
	connectionId: string;
}

function encodeTerminalEvent(event: ApiTerminalServerMessage): string {
	return JSON.stringify(event);
}

Bun.serve({
	hostname: host,
	port,
	idleTimeout: 255,
	...(tls ? { tls: { cert: Bun.file(tls.certFile), key: Bun.file(tls.keyFile) } } : {}),
	websocket: {
		open(ws) {
			const data = ws.data as TerminalWebSocketData | undefined;
			if (!data || data.kind !== "terminal") {
				try { ws.close(1008, "invalid_socket"); } catch {}
				return;
			}
			const isScratchTerminal = data.sessionId === "scratch";
			try {
				const init = isScratchTerminal ? runtime.addGlobalTerminalClient({
					connectionId: data.connectionId,
					clientId: data.clientId,
					connectedAtMs: Date.now(),
					send(event) {
						try { ws.send(encodeTerminalEvent(event)); } catch {}
					},
					close(code, reason) {
						try { ws.close(code, reason); } catch {}
					},
				}) : runtime.addTerminalClient(data.sessionId, {
					connectionId: data.connectionId,
					clientId: data.clientId,
					connectedAtMs: Date.now(),
					send(event) {
						try { ws.send(encodeTerminalEvent(event)); } catch {}
					},
					close(code, reason) {
						try { ws.close(code, reason); } catch {}
					},
				});
				ws.send(encodeTerminalEvent(init));
			} catch {
				try { ws.close(1008, "session_not_running"); } catch {}
			}
		},
		message(ws, rawMessage) {
			const data = ws.data as TerminalWebSocketData | undefined;
			if (!data || data.kind !== "terminal") return;
			let parsed: ApiTerminalClientMessage;
			try {
				const text = typeof rawMessage === "string" ? rawMessage : Buffer.from(rawMessage).toString("utf8");
				parsed = JSON.parse(text) as ApiTerminalClientMessage;
			} catch {
				try {
					ws.send(encodeTerminalEvent({ type: "error", message: "Invalid terminal payload", code: "invalid_json" }));
				} catch {}
				return;
			}
			try {
				if (data.sessionId === "scratch") {
					runtime.handleGlobalTerminalClientMessage(data.connectionId, parsed);
				} else {
					runtime.handleTerminalClientMessage(data.sessionId, data.connectionId, parsed);
				}
			} catch (error) {
				try {
					ws.send(encodeTerminalEvent({
						type: "error",
						message: error instanceof Error ? error.message : String(error),
						code: "terminal_runtime_error",
					}));
				} catch {}
			}
		},
		close(ws) {
			const data = ws.data as TerminalWebSocketData | undefined;
			if (!data || data.kind !== "terminal") return;
			if (data.sessionId === "scratch") {
				runtime.removeGlobalTerminalClient(data.connectionId);
			} else {
				runtime.removeTerminalClient(data.sessionId, data.connectionId);
			}
		},
		binaryType: "uint8array",
		maxPayloadLength: 2 * 1024 * 1024,
		idleTimeout: 120,
	},
	async fetch(req, server): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/health") {
			return json({ ok: true }, 200);
		}

		const authError = ensureApiAuth(req, url);
		if (authError) return authError;

		if (req.method === "GET" && url.pathname === "/") {
			return serveStatic(join(publicDir, "index.html"), "text/html; charset=utf-8");
		}
		if (req.method === "GET" && url.pathname === "/favicon.ico") {
			return new Response(null, { status: 204 });
		}

		if (req.method === "GET" && url.pathname.startsWith(simpleWebAuthnBrowserUrlPrefix)) {
			const filePath = resolveSimpleWebAuthnBrowserFile(url);
			if (filePath) return serveStatic(filePath);
			return new Response("Not found", { status: 404 });
		}

		const vendorStatic = vendorStaticFiles.get(url.pathname);
		if (req.method === "GET" && vendorStatic) {
			return serveStatic(vendorStatic.path, vendorStatic.contentType);
		}

		if (req.method === "GET" && !isApiPath(url.pathname)) {
			const filePath = resolvePublicFile(url);
			if (filePath) return serveStatic(filePath);
		}

		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const sessions = await runtime.listSessions();
			const cwdFilter = url.searchParams.get("cwd")?.trim();
			const filtered =
				cwdFilter && cwdFilter.length > 0 ? sessions.filter((s) => typeof s.cwd === "string" && s.cwd === cwdFilter) : sessions;
			const body: ApiListSessionsResponse = { sessions: filtered };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/models") {
			const models = await runtime.listModels();
			const body: ApiListModelsResponse = { models };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/active-sessions") {
			const sessions = runtime.listActiveSessions();
			const body: ApiActiveSessionsResponse = { sessions };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/agents") {
			try {
				const cwd = url.searchParams.get("cwd") || process.cwd();
				const { agents: discovered } = await discoverAgents(cwd);
				const agents = discovered.map((a: any) => ({
					name: a.name,
					description: a.description || "",
					scope: a.source || "builtin",
					model: Array.isArray(a.model) ? a.model[0] || null : (a.model || null),
				}));
				return json({ agents }, 200);
			} catch (err) {
				console.error("Failed to discover agents:", err);
				return json({ agents: [] }, 200);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/repos") {
			const repos = await runtime.listRepos();
			const body: ApiListReposResponse = { repos };
			return json(body, 200);
		}

		if (req.method === "GET" && url.pathname === "/api/dirs/search") {
			const query = url.searchParams.get("q") || "";
			if (!query.trim()) return json({ dirs: [] }, 200);
			try {
				const dirs = await fuzzyFindDirs(query.trim());
				return json({ dirs }, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 500);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/dirs/create") {
			const raw = (await requireJsonBody(req)) as { path?: string };
			if (!raw?.path || typeof raw.path !== "string") {
				return errorResponse("Missing path", 400);
			}
			// Security: ensure path is under /root
			const fullPath = resolve("/root", raw.path);
			if (!fullPath.startsWith("/root/") && fullPath !== "/root") {
				return errorResponse("Path must be under /root", 403);
			}
			try {
				await mkdir(fullPath, { recursive: true });
				return json({ path: fullPath }, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 500);
			}
		}

                if (req.method === "GET" && url.pathname === "/api/faceid/status") {
                        try {
                                const body = await faceId.status(url.hostname);
                                return json(body, 200);
                        } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                return errorResponse(message, 400);
                        }
                }

		if (req.method === "POST" && url.pathname === "/api/repos") {
			const raw = (await requireJsonBody(req)) as ApiAddRepoRequest;
			if (!raw?.cwd || typeof raw.cwd !== "string") {
				return errorResponse("Missing cwd", 400);
			}
			try {
				await runtime.addRepo(raw.cwd);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/push/public-key") {
			try {
				return json({ publicKey: pushService.getPublicKey() }, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
			const raw = (await requireJsonBody(req)) as {
				subscription?: unknown;
				clientId?: unknown;
				userAgent?: unknown;
				platform?: unknown;
			};
			try {
				return json(await pushService.subscribe(raw.subscription as PushSubscriptionJSON, {
					clientId: typeof raw.clientId === "string" ? raw.clientId : undefined,
					userAgent: typeof raw.userAgent === "string" ? raw.userAgent : undefined,
					platform: typeof raw.platform === "string" ? raw.platform : undefined,
				}), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/push/activity") {
			const raw = (await requireJsonBody(req)) as {
				clientId?: unknown;
				sessionId?: unknown;
				visible?: unknown;
				focused?: unknown;
			};
			if (typeof raw?.clientId !== "string" || !raw.clientId.trim()) {
				return errorResponse("Missing clientId", 400);
			}
			try {
				return json(pushService.updateClientActivity({
					clientId: raw.clientId.trim(),
					sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
					visible: Boolean(raw.visible),
					focused: Boolean(raw.focused),
				}), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") {
			const raw = (await requireJsonBody(req)) as { endpoint?: unknown };
			if (typeof raw?.endpoint !== "string" || !raw.endpoint.trim()) {
				return errorResponse("Missing endpoint", 400);
			}
			try {
				return json(await pushService.unsubscribe(raw.endpoint.trim()), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/voice/status") {
			const status = getVoiceStatus();
			return json(status, 200);
		}

		if (req.method === "POST" && url.pathname === "/api/voice/warm") {
			try {
				return json({ ok: true, warming: false, reason: "using chatgpt-oauth" }, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 500);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/voice/transcribe") {
			try {
				const contentType = req.headers.get("content-type") || "";
				if (!contentType.includes("audio/") && !contentType.includes("application/octet-stream") && !contentType.includes("multipart/form-data")) {
					return errorResponse("Expected audio content", 400);
				}
				let audioBuffer: Buffer;
				if (contentType.includes("multipart/form-data")) {
					const formData = await req.formData();
					const file = formData.get("audio");
					if (!file || !(file instanceof Blob)) return errorResponse("Missing audio field", 400);
					audioBuffer = Buffer.from(await file.arrayBuffer());
				} else {
					audioBuffer = Buffer.from(await req.arrayBuffer());
				}
				if (audioBuffer.length === 0) return errorResponse("Empty audio", 400);
				if (audioBuffer.length > 25 * 1024 * 1024) return errorResponse("Audio too large (25MB max)", 400);
				const result = await transcribeAudio(audioBuffer);
				return json(result, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 500);
			}
		}

                if (req.method === "POST" && url.pathname === "/api/faceid/challenge") {
                        const raw = (await requireJsonBody(req)) as { kind?: unknown };
                        const kind = raw?.kind;
                        if (kind !== "register" && kind !== "authenticate") {
                                return errorResponse("Invalid faceid challenge kind", 400);
                        }
                        try {
                                const result = await faceId.createChallenge(kind, url.hostname, url.origin);
                                return json(result, 200);
                        } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                return errorResponse(message, 400);
                        }
                }

                if (req.method === "POST" && url.pathname === "/api/faceid/verify") {
                        const raw = (await requireJsonBody(req)) as { challengeId?: unknown; credential?: unknown };
                        if (typeof raw?.challengeId !== "string" || raw.challengeId.length === 0) {
                                return errorResponse("Missing challengeId", 400);
                        }
                        try {
                                const result = await faceId.verify(raw.challengeId, raw.credential);
                                return json(result, 200);
                        } catch (error) {
                                const message = error instanceof Error ? error.message : String(error);
                                return errorResponse(message, 400);
                        }
                }

		// ── Worktree API ───────────────────────────────────────
		if (req.method === "GET" && url.pathname === "/api/worktrees") {
			try {
				const worktrees = await runtime.listWorktrees();
				return json({ worktrees }, 200);
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 500);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/worktree/create") {
			const raw = (await requireJsonBody(req)) as {
				repoPath?: string;
				name?: string;
				baseBranch?: string;
				clientId?: string;
				startAgent?: string;
			};
			if (!raw?.repoPath || typeof raw.repoPath !== "string") return errorResponse("Missing repoPath", 400);
			if (!raw?.name || typeof raw.name !== "string") return errorResponse("Missing name", 400);
			if (!raw?.clientId || typeof raw.clientId !== "string") return errorResponse("Missing clientId", 400);
			try {
				const result = await runtime.createWorktree({
					repoPath: raw.repoPath,
					name: raw.name,
					baseBranch: typeof raw.baseBranch === "string" ? raw.baseBranch : undefined,
					clientId: raw.clientId,
					startAgent: typeof raw.startAgent === "string" ? raw.startAgent : undefined,
				});
				return json(result, 200);
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 400);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/worktree/merge") {
			const raw = (await requireJsonBody(req)) as { worktreePath?: string; targetBranch?: string };
			if (!raw?.worktreePath || typeof raw.worktreePath !== "string") return errorResponse("Missing worktreePath", 400);
			try {
				const result = await runtime.mergeWorktree({
					worktreePath: raw.worktreePath,
					targetBranch: typeof raw.targetBranch === "string" ? raw.targetBranch : undefined,
				});
				return json(result, 200);
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 400);
			}
		}

		if (req.method === "DELETE" && url.pathname === "/api/worktree") {
			const path = url.searchParams.get("path");
			if (!path) return errorResponse("Missing path query param", 400);
			try {
				await runtime.deleteWorktree(path);
				return ok();
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 400);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/worktree/branches") {
			const repoPath = url.searchParams.get("repo") || "";
			if (!repoPath) return errorResponse("Missing repo query param", 400);
			try {
				const branches = await runtime.getWorktreeBranches(repoPath);
				return json({ branches }, 200);
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 500);
			}
		}

		if (req.method === "GET" && url.pathname === "/api/is-git-repo") {
			const path = url.searchParams.get("path") || "";
			if (!path) return json({ isGitRepo: false }, 200);
			try {
				const isGit = await runtime.isGitRepo(path);
				return json({ isGitRepo: isGit }, 200);
			} catch {
				return json({ isGitRepo: false }, 200);
			}
		}

		if (req.method === "POST" && url.pathname === "/api/sessions") {
			const raw = (await requireJsonBody(req)) as ApiCreateSessionRequest;
			try {
				const result = await runtime.startSession(raw);
				return json(result, 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResponse(message, 400);
			}
		}

		const sessionRoute = parseSessionRoute(url.pathname);
		if (!sessionRoute) {
			return new Response("Not found", { status: 404 });
		}

		const { sessionId, action } = sessionRoute;

		if (req.method === "GET" && action === "state") {
			const includeFullHistory = url.searchParams.get("fullHistory") === "1" || url.searchParams.get("full") === "1";
			const tailMessages = Math.max(0, Number.parseInt(url.searchParams.get("tailMessages") || "0", 10) || 0);
			try {
				const state: ApiSessionState = runtime.getSessionState(sessionId, includeFullHistory, tailMessages);
				return json(state, 200);
			} catch {
				return errorResponse("Session not running", 404);
			}
		}


		if (req.method === "POST" && action === "archive") {
			const raw = (await requireJsonBody(req)) as Record<string, unknown>;
			if (typeof raw?.archived !== "boolean") {
				return errorResponse("Invalid archive payload", 400);
			}
			const archived = raw.archived;
			await runtime.archiveSession(sessionId, archived);
			return json({ archived }, 200);
		}
		if (req.method === "GET" && action === "tree") {
			try {
				return json(runtime.getSessionTree(sessionId), 200);
			} catch {
				return errorResponse("Session not running", 404);
			}
		}

		if (req.method === "GET" && action === "events") {
			const clientId = url.searchParams.get("clientId")?.trim() || randomUUID();
			const includeFullHistory = url.searchParams.get("fullHistory") === "1" || url.searchParams.get("full") === "1";
			const tailMessages = Math.max(0, Number.parseInt(url.searchParams.get("tailMessages") || "0", 10) || 0);
			let state: ApiSessionState;
			try {
				state = runtime.getSessionState(sessionId, includeFullHistory, tailMessages);
			} catch {
				return errorResponse("Session not running", 404);
			}

			const stream = createSseStream(req.signal);
			const connectionId = randomUUID();
			const client: SessionClient = {
				connectionId,
				clientId,
				connectedAtMs: Date.now(),
				send: stream.send,
				close: stream.close,
			};

			let role: ReturnType<typeof runtime.getSessionRole>["role"];
			let controllerClientId: string | null;
			try {
				runtime.addClient(sessionId, client);
				const resolved = runtime.getSessionRole(sessionId, clientId);
				role = resolved.role;
				controllerClientId = resolved.controllerClientId;
			} catch {
				stream.close();
				return errorResponse("Session not running", 404);
			}

			const init: SseEvent = {
				type: "init",
				state,
				yourClientId: clientId,
				controllerClientId,
				role,
			};
			stream.send(init);
			runtime.replayPendingDialogs(sessionId, connectionId);

			req.signal.addEventListener(
				"abort",
				() => {
					runtime.removeClient(sessionId, connectionId);
				},
				{ once: true },
			);

			return stream.response;
		}

		if (req.method === "GET" && action === "terminal") {
			const clientId = url.searchParams.get("clientId")?.trim() || randomUUID();
			if (sessionId !== "scratch") {
				try {
					runtime.getSessionRole(sessionId, clientId);
				} catch {
					return errorResponse("Session not running", 404);
				}
			}
			const upgraded = server.upgrade(req, {
				data: {
					kind: "terminal",
					sessionId,
					clientId,
					connectionId: randomUUID(),
				} satisfies TerminalWebSocketData,
			});
			return upgraded
				? (undefined as never)
				: errorResponse("Failed to open terminal websocket", 400);
		}

		if (req.method === "POST" && action === "tree") {
			const raw = (await requireJsonBody(req)) as Record<string, unknown>;
			if (!raw || typeof raw !== "object") {
				return errorResponse("Invalid tree navigation payload", 400);
			}
			const request: ApiNavigateTreeRequest = {
				clientId: typeof raw.clientId === "string" ? raw.clientId : "",
				targetId: typeof raw.targetId === "string" ? raw.targetId : "",
				...(raw.summarize === true ? { summarize: true } : {}),
				...(typeof raw.customInstructions === "string" ? { customInstructions: raw.customInstructions } : {}),
				...(raw.replaceInstructions === true ? { replaceInstructions: true } : {}),
				...(typeof raw.label === "string" ? { label: raw.label } : {}),
			};
			try {
				return json(await runtime.navigateTree(sessionId, request), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "fork") {
			const raw = (await requireJsonBody(req)) as Record<string, unknown>;
			if (!raw || typeof raw !== "object") {
				return errorResponse("Invalid fork payload", 400);
			}
			const request: ApiForkSessionRequest = {
				clientId: typeof raw.clientId === "string" ? raw.clientId : "",
				entryId: typeof raw.entryId === "string" ? raw.entryId : "",
			};
			try {
				return json(await runtime.forkSession(sessionId, request), 200);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "command") {
			const raw = (await requireJsonBody(req)) as ApiCommandRequest;
			if (!raw || typeof raw !== "object" || typeof raw.type !== "string") {
				return errorResponse("Invalid command payload", 400);
			}
			try {
				await runtime.handleCommand(sessionId, raw);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "takeover") {
			const raw = (await requireJsonBody(req)) as ApiTakeoverRequest;
			if (!raw?.clientId || typeof raw.clientId !== "string") {
				return errorResponse("Missing clientId", 400);
			}
			try {
				runtime.takeover(sessionId, raw);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "cannot_takeover_while_streaming") return errorResponse("Cannot take over while streaming", 409);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "release") {
			const raw = (await requireJsonBody(req)) as ApiReleaseRequest;
			if (!raw?.clientId || typeof raw.clientId !== "string") {
				return errorResponse("Missing clientId", 400);
			}
			try {
				await runtime.release(sessionId, raw);
				return ok();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "session_not_running") return errorResponse("Session not running", 404);
				if (message === "not_controller") return errorResponse("Not controller", 403);
				return errorResponse(message, 400);
			}
		}

		if (req.method === "POST" && action === "stop") {
			try {
				await runtime.stopSession(sessionId);
				return ok();
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 400);
			}
		}

		if (req.method === "DELETE") {
			// Delete by session path (passed as query param)
			const url = new URL(req.url, `http://${host}`);
			const sessionPath = url.searchParams.get("path");
			if (!sessionPath) return errorResponse("Missing path query param", 400);
			try {
				await runtime.deleteSession(sessionPath);
				return ok();
			} catch (error) {
				return errorResponse(error instanceof Error ? error.message : String(error), 400);
			}
		}

		return new Response("Not found", { status: 404 });
	},
});

const scheme = tls ? "https" : "http";
const baseUrl = `${scheme}://${host}:${port}`;
console.log(`pi-web listening on ${baseUrl}`);
if (tls) {
	console.log("TLS enabled with Tailscale certs.");
}
if (requiresAuth && token) {
	console.log(`Token required (non-loopback bind). Open: ${baseUrl}/?token=${token}`);
	console.log(`API scripts: Authorization: Bearer ${token}`);
} else if (isTailnetHost(host)) {
	console.log("Tailscale IP detected: token auth disabled; rely on tailnet ACLs.");
}
