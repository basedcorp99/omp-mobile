import { createApi } from "./core/api.js";
import { isPhoneLike, isStandalonePwa } from "./core/device.js";
import { installFaceIdGuard } from "./core/faceid.js";
import { installPushNotifications } from "./core/push.js";
import { fileToImageContent } from "./core/image_upload.js";
import { createVoiceRecorder } from "./core/voice.js";
import { isWebSpeechSupported } from "./core/web-speech.js";
import {
	getFaceIdEnabled,
	getFontScalePreference,
	getOrCreateClientId,
	getSendOnEnterEnabled,
	getStreamingSendMode,
	getThemePreference,
	getToken,
	getVoiceInputMode,
	getVoiceTranscriptionMode,
	getLastVoiceTranscript,
	getTerminalPaneOpen,
	setFontScalePreference,
	setSendOnEnterEnabled,
	setStreamingSendMode,
	setThemePreference,
	setVoiceInputMode,
	setVoiceTranscriptionMode,
	setLastVoiceTranscript,
	setTerminalPaneOpen,
} from "./core/storage.js";
import { createSessionController } from "./session/controller.js";
import { extractTextContent } from "./session/content.js";
import { createMenu } from "./ui/menu.js";
import { createUiPromptDialog } from "./ui/ui_prompt_dialog.js";
import { createSessionBranchLauncher } from "./ui/session_branch_launcher.js";
import { createSidebar } from "./ui/sidebar.js";

function haptic(ms = 10) { try { navigator.vibrate?.(ms); } catch {} }

const sessionsList = document.getElementById("sessions-list");
const msgs = document.getElementById("msgs");
const input = document.getElementById("inp");
const btnScrollBottom = document.getElementById("btn-scroll-bottom");
const workingIndicator = document.getElementById("working");
const workingSpin = document.getElementById("work-spin");
const workingText = document.querySelector("#working .work-text");

const footerLine1 = document.getElementById("footer-line-1");
const footerCwd = document.getElementById("footer-cwd");
const footerMetrics = document.getElementById("footer-metrics");
const footerRight2 = document.getElementById("footer-right-2");

const rolePill = document.getElementById("role-pill");
const btnModel = document.getElementById("btn-model");
const btnThinking = document.getElementById("btn-thinking");
const btnCommands = document.getElementById("btn-commands");
const attachBarEl = document.getElementById("attach-bar");
const btnMenuHeader = document.getElementById("btn-menu-header");
const btnNotify = document.getElementById("btn-notify");
const lblModel = document.getElementById("lbl-model");
const lblThinking = document.getElementById("lbl-thinking");
const lblNotify = document.getElementById("lbl-notify");

const sidebarLabel = document.getElementById("sidebar-label");
const btnSidebarLeft = document.getElementById("btn-sidebar-left");
const btnSidebarRight = document.getElementById("btn-sidebar-right");

const btnTerminal = document.getElementById("btn-terminal");
const btnTakeover = document.getElementById("btn-takeover");
const btnAbort = document.getElementById("btn-abort");
const btnCompact = document.getElementById("btn-compact");
const btnRelease = document.getElementById("btn-release");
const btnLoadMore = document.getElementById("btn-load-more");
const btnTakeoverTxt = btnTakeover?.querySelector?.(".txt") || null;
const btnAbortTxt = btnAbort?.querySelector?.(".txt") || null;
const btnCompactTxt = btnCompact?.querySelector?.(".txt") || null;
const btnReleaseTxt = btnRelease?.querySelector?.(".txt") || null;
const btnAttach = document.getElementById("btn-attach");
// Keep session switching snappy by loading a recent tail first, then hydrate
// the exact full transcript (including reasoning/thinking blocks) in the background.
const LOAD_FULL_SESSION_HISTORY = true;
const MAX_PENDING_ATTACHMENTS = 12;

const slashAutocompleteStyle = document.createElement("style");
slashAutocompleteStyle.textContent = `
#slash-autocomplete {
	position: absolute;
	bottom: calc(100% + 8px);
	left: 0;
	right: 0;
	max-height: 240px;
	overflow-y: auto;
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 8px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.3);
	z-index: 1000;
	font-size: 13px;
	display: none;
}
#slash-autocomplete.visible { display: block; }
.slash-item {
	display: flex;
	align-items: center;
	padding: 8px 12px;
	gap: 10px;
	cursor: pointer;
	border-bottom: 1px solid rgba(255,255,255,0.04);
}
.slash-item:last-child { border-bottom: none; }
.slash-item.active { background: var(--accent); color: #fff; }
.slash-name { font-weight: 600; min-width: 80px; white-space: nowrap; }
.slash-desc { flex: 1; color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slash-item.active .slash-desc { color: rgba(255,255,255,0.7); }
.slash-cat { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
.slash-item.active .slash-cat { color: rgba(255,255,255,0.5); }
body.light .slash-item.active { background: var(--accent); color: #fff; }
`;
document.head.appendChild(slashAutocompleteStyle);

const btnHistory = document.getElementById("btn-history");
const btnLastVoice = document.getElementById("btn-last-voice");
const btnVoice = document.getElementById("btn-voice");
const btnAttachClear = document.getElementById("btn-attach-clear");
const attachList = document.getElementById("attach-list");
const btnTheme = document.getElementById("btn-theme");
const btnSettings = document.getElementById("btn-settings");
const imageInput = document.getElementById("image-input");

const menuOverlay = document.getElementById("menu-overlay");
const menuScrim = document.getElementById("menu-scrim");
const menuPanel = document.getElementById("menu-panel");

const sidebar = document.querySelector(".sidebar");
const chat = document.querySelector(".chat");
const sidebarOverlay = document.getElementById("sidebar-overlay");

const kbMenu = document.getElementById("kb-menu");
const kbAbort = document.getElementById("kb-abort");
const kbCompact = document.getElementById("kb-compact");
const kbTerminal = document.getElementById("kb-terminal");
const kbTakeover = document.getElementById("kb-takeover");
const kbRelease = document.getElementById("kb-release");
const kbEnter = document.getElementById("kb-enter");
const kbTakeoverTextNode = kbTakeover ? Array.from(kbTakeover.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;
const kbAbortTextNode = kbAbort ? Array.from(kbAbort.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;
const kbCompactTextNode = kbCompact ? Array.from(kbCompact.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) : null;

const clientId = getOrCreateClientId();
const token = getToken();
const currentUrl = new URL(window.location.href);
const replayName = currentUrl.searchParams.get("replay")?.trim() || null;
const sessionParam = currentUrl.searchParams.get("session")?.trim() || null;
let lastSyncedSessionUrl = null;
const api = createApi(token);
const faceIdEnabled = getFaceIdEnabled();
const faceIdGuard = faceIdEnabled ? installFaceIdGuard({ api }) : { start: async () => {} };
let pushCtrl = null;

const VOICE_INPUT_MODE_COMPOSE = "compose";
const VOICE_INPUT_MODE_AUTO_SEND = "auto-send";

function normalizeVoiceInputMode(mode) {
	return mode === VOICE_INPUT_MODE_AUTO_SEND ? VOICE_INPUT_MODE_AUTO_SEND : VOICE_INPUT_MODE_COMPOSE;
}

// Preferences
let sendOnEnter = getSendOnEnterEnabled();
let fontScale = getFontScalePreference();
let voiceInputMode = normalizeVoiceInputMode(getVoiceInputMode());
const savedTheme = getThemePreference();
if (savedTheme === "light") document.body.classList.add("light");
document.documentElement.style.setProperty("--font-scale", String(fontScale));

let workingIntervalId = null;
let workingFrame = 0;

let sidebarCtrl = null;
let menuCtrl = null;
let uiPromptDialog = null;
let branchLauncher = null;
let terminalPane = null;
let pendingAttachments = [];
const pendingPromptHistoryBySession = new Map();
let promptHistoryCursor = -1;
let promptHistoryDraft = "";
let promptHistorySessionId = null;
let lastComposerSessionId = null;
let lastBranchLauncherSessionId = null;
const sessionDrafts = new Map(); // sessionId → draft text
const slashAutocomplete = document.createElement("div");
slashAutocomplete.id = "slash-autocomplete";
slashAutocomplete.setAttribute("role", "listbox");
slashAutocomplete.setAttribute("aria-label", "Slash command suggestions");
const slashAutocompleteContainer = input.parentElement;
if (slashAutocompleteContainer) {
	if (getComputedStyle(slashAutocompleteContainer).position === "static") slashAutocompleteContainer.style.position = "relative";
	slashAutocompleteContainer.appendChild(slashAutocomplete);
}
let slashMatches = [];
let slashSelectedIndex = 0;
let slashRangeStart = -1;
let slashRangeEnd = -1;

function normalizeSlashCommandName(name) {
	const trimmed = String(name || "").trim();
	if (!trimmed) return "";
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getSlashAutocompleteCommands() {
	const active = sessionCtrl?.getActiveState?.() || activeState;
	const commands = Array.isArray(active?.commands) ? active.commands : [];
	const result = [];
	const seen = new Set();
	for (const command of commands) {
		const name = normalizeSlashCommandName(command?.name);
		const key = name.toLowerCase();
		if (!name || seen.has(key)) continue;
		seen.add(key);
		result.push({
			name,
			description: String(command?.description || ""),
			category: String(command?.source || "command"),
		});
	}
	if (active?.sessionId || activeSessionId) {
		for (const command of [
			{ name: "/tree", description: "Browse checkpoints and branches", category: "session" },
			{ name: "/fork", description: "Fork from an earlier message", category: "session" },
		]) {
			const key = command.name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(command);
		}
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function isSlashAutocompleteVisible() {
	return slashAutocomplete.classList.contains("visible");
}

function hideSlashAutocomplete() {
	slashAutocomplete.classList.remove("visible");
	slashAutocomplete.textContent = "";
	slashMatches = [];
	slashSelectedIndex = 0;
	slashRangeStart = -1;
	slashRangeEnd = -1;
}

function getSlashCommandContext() {
	const cursor = input.selectionStart;
	if (typeof cursor !== "number" || cursor !== input.selectionEnd) return null;
	const textBeforeCursor = input.value.slice(0, cursor);
	const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
	const currentLine = textBeforeCursor.slice(lineStart);
	const slashIndex = currentLine.lastIndexOf("/");
	if (slashIndex < 0) return null;
	const prefix = currentLine.slice(slashIndex + 1);
	if (/\s/.test(prefix)) return null;
	return {
		prefix,
		start: lineStart + slashIndex,
		end: cursor,
	};
}

function setSlashSelectedIndex(index) {
	if (slashMatches.length === 0) return;
	slashSelectedIndex = (index + slashMatches.length) % slashMatches.length;
	const items = slashAutocomplete.querySelectorAll(".slash-item");
	items.forEach((item, itemIndex) => {
		item.classList.toggle("active", itemIndex === slashSelectedIndex);
		item.setAttribute("aria-selected", itemIndex === slashSelectedIndex ? "true" : "false");
	});
	items[slashSelectedIndex]?.scrollIntoView?.({ block: "nearest" });
}

function renderSlashAutocomplete() {
	slashAutocomplete.textContent = "";
	slashMatches.forEach((command, index) => {
		const item = document.createElement("div");
		item.className = `slash-item${index === slashSelectedIndex ? " active" : ""}`;
		item.dataset.command = command.name;
		item.setAttribute("role", "option");
		item.setAttribute("aria-selected", index === slashSelectedIndex ? "true" : "false");

		const name = document.createElement("span");
		name.className = "slash-name";
		name.textContent = command.name;
		item.appendChild(name);

		const description = document.createElement("span");
		description.className = "slash-desc";
		description.textContent = command.description;
		item.appendChild(description);

		const category = document.createElement("span");
		category.className = "slash-cat";
		category.textContent = command.category;
		item.appendChild(category);

		item.addEventListener("mouseenter", () => setSlashSelectedIndex(index));
		item.addEventListener("mousedown", (event) => {
			event.preventDefault();
			setSlashSelectedIndex(index);
			insertSelectedSlashCommand();
		});
		slashAutocomplete.appendChild(item);
	});
}

function updateSlashAutocomplete() {
	const context = getSlashCommandContext();
	if (!context) {
		hideSlashAutocomplete();
		return;
	}
	const needle = `/${context.prefix}`.toLowerCase();
	const matches = getSlashAutocompleteCommands().filter((command) => command.name.toLowerCase().startsWith(needle));
	if (matches.length === 0) {
		hideSlashAutocomplete();
		return;
	}
	slashMatches = matches;
	slashSelectedIndex = 0;
	slashRangeStart = context.start;
	slashRangeEnd = context.end;
	renderSlashAutocomplete();
	slashAutocomplete.classList.add("visible");
}

function insertSelectedSlashCommand() {
	if (!isSlashAutocompleteVisible() || slashMatches.length === 0) return false;
	const command = slashMatches[slashSelectedIndex];
	if (!command) return false;
	const context = getSlashCommandContext();
	const start = context?.start ?? slashRangeStart;
	const end = context?.end ?? slashRangeEnd;
	if (start < 0 || end < start) return false;
	const before = input.value.slice(0, start);
	const after = input.value.slice(end);
	const inserted = `${command.name} `;
	input.value = `${before}${inserted}${after}`;
	const cursor = before.length + inserted.length;
	input.setSelectionRange(cursor, cursor);
	autoResize(input);
	resetPromptHistoryNavigation();
	hideSlashAutocomplete();
	input.focus();
	return true;
}

function syncSessionUrl(sessionId) {
	if (replayName) return;
	const normalized = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
	if (normalized === lastSyncedSessionUrl) return;
	const url = new URL(window.location.href);
	if (normalized) url.searchParams.set("session", normalized);
	else url.searchParams.delete("session");
	history.replaceState(null, "", url.toString());
	lastSyncedSessionUrl = normalized;
}

function extractSessionIdFromUrl(rawUrl) {
	if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
	try {
		const url = new URL(rawUrl, window.location.origin);
		const sessionId = url.searchParams.get("session")?.trim();
		return sessionId || null;
	} catch {
		return null;
	}
}

async function openSessionTarget(sessionId) {
	const normalized = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
	if (!normalized) return false;

	try {
		const activeData = await api.getJson("/api/active-sessions");
		const activeSessions = Array.isArray(activeData.sessions) ? activeData.sessions : [];
		const activeMatch = activeSessions.find((session) => session && session.id === normalized);
		if (activeMatch) {
			sessionCtrl.openSessionId(activeMatch.id);
			clearAttachments();
			updateControls();
			return true;
		}
	} catch {
		// ignore
	}

	try {
		const allData = await api.getJson("/api/sessions");
		const allSessions = Array.isArray(allData.sessions) ? allData.sessions : [];
		const savedMatch = allSessions.find((session) => session && session.id === normalized);
		if (savedMatch) {
			await sessionCtrl.selectSession(savedMatch);
			clearAttachments();
			updateControls();
			return true;
		}
	} catch {
		// ignore
	}

	return false;
}

function setComposerText(text) {
	input.value = typeof text === "string" ? text : "";
	autoResize(input);
	input.focus();
	const end = input.value.length;
	if (typeof input.setSelectionRange === "function") input.setSelectionRange(end, end);
}

function getBranchLauncherAvailability(kind) {
	if (!branchLauncher) return { ok: false, message: "Branch navigation is still loading." };
	const sessionId = sessionCtrl?.getActiveSessionId?.();
	if (!sessionId) return { ok: false, message: "Open a session first." };
	const state = sessionCtrl?.getActiveState?.();
	if (state?.isStreaming) {
		return { ok: false, message: `Wait for the current response to finish before using /${kind}.` };
	}
	const messages = Array.isArray(state?.messages) ? state.messages : [];
	if (kind === "tree" && messages.length === 0) {
		return { ok: false, message: "This session has no history yet." };
	}
	if (kind === "fork" && !messages.some((message) => message && message.role === "user")) {
		return { ok: false, message: "There are no user messages to fork from yet." };
	}
	return { ok: true };
}

function openTreeLauncher(options = {}) {
	const availability = getBranchLauncherAvailability("tree");
	if (!availability.ok) {
		if (availability.message) sessionCtrl?.appendNotice?.(availability.message, "warning");
		return false;
	}
	branchLauncher.showTree(options);
	return true;
}

function openForkLauncher(options = {}) {
	const availability = getBranchLauncherAvailability("fork");
	if (!availability.ok) {
		if (availability.message) sessionCtrl?.appendNotice?.(availability.message, "warning");
		return false;
	}
	branchLauncher.showFork(options);
	return true;
}

function handleLauncherSlashCommand(text) {
	const match = String(text || "").trim().match(/^\/(tree|fork)(?:\s+(.*))?$/i);
	if (!match) return { matched: false, opened: false };
	const kind = String(match[1] || "").toLowerCase();
	const initialQuery = String(match[2] || "").trim();
	if (kind === "tree") return { matched: true, opened: openTreeLauncher({ initialQuery }) };
	if (kind === "fork") return { matched: true, opened: openForkLauncher({ initialQuery }) };
	return { matched: false, opened: false };
}

function resetPromptHistoryNavigation() {
	promptHistoryCursor = -1;
	promptHistoryDraft = "";
	promptHistorySessionId = sessionCtrl?.getActiveSessionId?.() || null;
}

function truncatePromptLabel(text, max = 120) {
	const normalized = String(text || "").replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function getServerPromptHistory(sessionId) {
	const state = sessionCtrl?.getActiveState?.();
	if (!sessionId || !state || state.sessionId !== sessionId || !Array.isArray(state.messages)) return [];
	return state.messages
		.filter((message) => message && message.role === "user")
		.map((message) => extractTextContent(message.content))
		.filter((text) => typeof text === "string" && text.trim().length > 0);
}

function computePromptHistoryOverlap(base, extras) {
	const max = Math.min(base.length, extras.length);
	for (let size = max; size > 0; size -= 1) {
		let matches = true;
		for (let i = 0; i < size; i += 1) {
			if (base[base.length - size + i] !== extras[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return size;
	}
	return 0;
}

function rememberPromptHistory(sessionId, text) {
	if (!sessionId || typeof text !== "string" || text.trim().length === 0) return;
	const entries = pendingPromptHistoryBySession.get(sessionId) || [];
	entries.push(text);
	pendingPromptHistoryBySession.set(sessionId, entries.slice(-50));
}

function reconcilePendingPromptHistory(sessionId) {
	if (!sessionId) return;
	const pending = pendingPromptHistoryBySession.get(sessionId);
	if (!pending || pending.length === 0) return;
	const overlap = computePromptHistoryOverlap(getServerPromptHistory(sessionId), pending);
	const remaining = pending.slice(overlap);
	if (remaining.length > 0) pendingPromptHistoryBySession.set(sessionId, remaining);
	else pendingPromptHistoryBySession.delete(sessionId);
}

function getSessionPromptHistory(sessionId = sessionCtrl?.getActiveSessionId?.()) {
	if (!sessionId) return [];
	const base = getServerPromptHistory(sessionId);
	const pending = pendingPromptHistoryBySession.get(sessionId) || [];
	const overlap = computePromptHistoryOverlap(base, pending);
	return [...base, ...pending.slice(overlap)].slice(-50);
}

function syncPromptHistoryState() {
	const sessionId = sessionCtrl?.getActiveSessionId?.() || null;
	if (sessionId !== lastComposerSessionId) {
		// Save draft for the session we're leaving
		if (lastComposerSessionId && input) {
			const draft = input.value;
			if (draft.trim()) sessionDrafts.set(lastComposerSessionId, draft);
			else sessionDrafts.delete(lastComposerSessionId);
		}
		lastComposerSessionId = sessionId;
		// Restore draft for the session we're entering
		if (input) {
			input.value = sessionDrafts.get(sessionId) || "";
			autoResize(input);
		}
		resetPromptHistoryNavigation();
	}
	if (sessionId) reconcilePendingPromptHistory(sessionId);
}

function openPromptHistoryDialog() {
	const history = getSessionPromptHistory();
	if (input.disabled || !uiPromptDialog || history.length === 0) return;
	const options = history
		.slice()
		.reverse()
		.map((text, index) => ({
			label: index === 0 ? `${truncatePromptLabel(text)} · latest` : truncatePromptLabel(text),
			value: text,
		}));
	uiPromptDialog.showSelect("prompt-history", "Prompt history", options, (_id, cancelled, value) => {
		if (cancelled || typeof value !== "string") return;
		resetPromptHistoryNavigation();
		setComposerText(value);
	});
}

function navigatePromptHistory(direction) {
	const sessionId = sessionCtrl?.getActiveSessionId?.();
	if (!sessionId) return false;
	const history = getSessionPromptHistory(sessionId);
	if (history.length === 0) return false;
	const selectionStart = input.selectionStart ?? 0;
	const selectionEnd = input.selectionEnd ?? 0;
	if (selectionStart !== selectionEnd) return false;
	if (promptHistorySessionId !== sessionId) resetPromptHistoryNavigation();
	promptHistorySessionId = sessionId;

	if (direction === "up") {
		if (selectionStart !== 0) return false;
		if (promptHistoryCursor === -1) promptHistoryDraft = input.value;
		if (promptHistoryCursor < history.length - 1) promptHistoryCursor += 1;
		setComposerText(history[history.length - 1 - promptHistoryCursor]);
		return true;
	}

	if (direction === "down") {
		if (selectionEnd !== input.value.length || promptHistoryCursor === -1) return false;
		promptHistoryCursor -= 1;
		setComposerText(promptHistoryCursor === -1 ? promptHistoryDraft : history[history.length - 1 - promptHistoryCursor]);
		return true;
	}

	return false;
}

function reusePrompt(text) {
	if (input.disabled) {
		sessionCtrl.appendNotice("Take over to reuse prompts.", "warning");
		return;
	}
	resetPromptHistoryNavigation();
	setComposerText(text);
}

function formatTokens(n) {
	const num = Number(n || 0);
	if (!Number.isFinite(num) || num <= 0) return "0";
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
	if (num >= 10_000) return `${Math.round(num / 1_000)}k`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
	return String(Math.round(num));
}

function formatCost(cost) {
	const num = Number(cost || 0);
	if (!Number.isFinite(num) || num <= 0) return null;
	return `$${num.toFixed(3)}`;
}

function buildSessionMetrics(state) {
	if (!state || typeof state !== "object") return "";

	const parts = [];
	const stats = state.stats && typeof state.stats === "object" ? state.stats : null;
	const tokens = stats && stats.tokens && typeof stats.tokens === "object" ? stats.tokens : null;

	const inputTokens = tokens && typeof tokens.input === "number" ? tokens.input : 0;
	const outputTokens = tokens && typeof tokens.output === "number" ? tokens.output : 0;
	const cacheRead = tokens && typeof tokens.cacheRead === "number" ? tokens.cacheRead : 0;
	const cacheWrite = tokens && typeof tokens.cacheWrite === "number" ? tokens.cacheWrite : 0;
	const cost = stats && typeof stats.cost === "number" ? stats.cost : 0;

	if (inputTokens) parts.push(`↑${formatTokens(inputTokens)}`);
	if (outputTokens) parts.push(`↓${formatTokens(outputTokens)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);

	const costStr = formatCost(cost);
	if (costStr) parts.push(costStr);

	const usage = state.contextUsage && typeof state.contextUsage === "object" ? state.contextUsage : null;
	const cw = usage && typeof usage.contextWindow === "number" ? usage.contextWindow : 0;
	if (cw > 0) {
		const percent = typeof usage.percent === "number" ? usage.percent : null;
		if (percent === null) {
			parts.push(`?/${formatTokens(cw)}`);
		} else {
			parts.push(`${Math.round(percent)}%/${formatTokens(cw)}`);
		}
	}

	return parts.join(" ");
}

function shortPath(cwd) {
	if (!cwd) return "";
	return String(cwd).replace(/^\/root\//, "~/").replace(/^\/home\/[^/]+\//, "~/");
}

function extractWorktreeName(cwd) {
	const match = String(cwd || "").match(/\/\.worktrees\/worktree-([^/]+)(?:\/merged)?$/);
	return match ? match[1] : null;
}

function formatFooterCwd(cwd) {
	const text = String(cwd || "");
	if (!text) return "";
	const wtName = extractWorktreeName(text);
	if (!wtName) return shortPath(text);
	const repoMatch = text.match(/^(.+)\/\.worktrees\//);
	const repoRoot = repoMatch ? repoMatch[1] : "";
	return repoRoot ? `${shortPath(repoRoot)} • 🌿 ${wtName}` : `🌿 ${wtName}`;
}

function updateFooter() {
	const activeState = sessionCtrl.getActiveState();
	if (!activeState) {
		footerLine1.textContent = "";
		if (footerCwd) {
			footerCwd.textContent = "";
			footerCwd.title = "";
		}
		if (footerMetrics) footerMetrics.textContent = "—";
		footerRight2.textContent = "—";
		return;
	}

	footerLine1.textContent = "";

	const model = activeState.model ? `${activeState.model.provider}/${activeState.model.id}` : "(no model)";
	const metrics = buildSessionMetrics(activeState);
	if (footerCwd) {
		footerCwd.textContent = formatFooterCwd(activeState.cwd || "");
		footerCwd.title = activeState.cwd || "";
	}
	if (footerMetrics) {
		const metaParts = [];
		if (metrics) metaParts.push(metrics);
		if (activeState.sessionId) metaParts.push(activeState.sessionId.slice(0, 8));
		footerMetrics.textContent = metaParts.join(" • ") || "—";
	}
	const agentPart = activeState.startAgent ? `${activeState.startAgent} • ` : "";
	footerRight2.textContent = `${agentPart}${model} • ${activeState.thinkingLevel}`;
}

function updateRolePill() {
	const role = sessionCtrl.getRole();
	if (!rolePill) return;
	rolePill.textContent = role;
	rolePill.classList.remove("controller", "viewer");
	rolePill.classList.add(role);
}

function updateTopSelectors() {
	const activeState = sessionCtrl.getActiveState();
	const model = activeState?.model ? `${activeState.model.provider}/${activeState.model.id}` : "—";
	if (lblModel) {
		lblModel.textContent = model;
		lblModel.title = activeState?.startAgent ? `${activeState.startAgent} • ${model}` : model;
	}
	const thinking = activeState?.thinkingLevel ? String(activeState.thinkingLevel) : "—";
	if (lblThinking) {
		lblThinking.textContent = thinking;
		lblThinking.title = thinking;
	}
}

function renderAttachmentBar() {
	if (attachList) {
		attachList.innerHTML = "";
		for (const [index, attachment] of pendingAttachments.entries()) {
			const chip = document.createElement("div");
			chip.className = "attach-chip";
			chip.title = attachment.label;

			const label = document.createElement("span");
			label.textContent = attachment.label;
			chip.appendChild(label);

			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "×";
			remove.title = "Remove image";
			remove.addEventListener("click", () => {
				pendingAttachments.splice(index, 1);
				renderAttachmentBar();
				updateControls();
			});
			chip.appendChild(remove);

			attachList.appendChild(chip);
		}
	}
	if (btnAttachClear) btnAttachClear.hidden = pendingAttachments.length === 0;
	if (attachBarEl) attachBarEl.style.display = pendingAttachments.length > 0 ? "flex" : "none";
}

function clearAttachments() {
	pendingAttachments = [];
	renderAttachmentBar();
	updateControls();
}

function getPendingAttachmentKeys() {
	return pendingAttachments.map((attachment) => `${attachment?.content?.mimeType || ""}:${attachment?.content?.data?.length || 0}:${attachment?.label || ""}`);
}

function buildVoiceJobMeta() {
	const mode = normalizeVoiceInputMode(voiceInputMode);
	const sessionId = sessionCtrl?.getActiveSessionId?.() || null;
	const images = mode === VOICE_INPUT_MODE_AUTO_SEND
		? pendingAttachments
			.map((attachment) => attachment?.content)
			.filter((image) => image && typeof image === "object")
			.map((image) => ({ ...image }))
		: [];
	return {
		mode,
		sessionId,
		attachmentKeys: mode === VOICE_INPUT_MODE_AUTO_SEND ? getPendingAttachmentKeys() : [],
		images,
	};
}

function handleQueuedVoiceJob(job) {
	if (!job || normalizeVoiceInputMode(job.mode) !== VOICE_INPUT_MODE_AUTO_SEND) return;
	if ((job.sessionId || null) !== (sessionCtrl?.getActiveSessionId?.() || null)) return;
	const expectedKeys = Array.isArray(job.attachmentKeys) ? job.attachmentKeys : [];
	if (expectedKeys.length === 0) return;
	const currentKeys = getPendingAttachmentKeys();
	if (currentKeys.length !== expectedKeys.length) return;
	if (currentKeys.every((key, index) => key === expectedKeys[index])) clearAttachments();
}

function appendTranscriptToComposer(text) {
	if (typeof text !== "string" || !text.trim() || input.disabled) return false;
	const transcript = text.trim();
	const before = input.value;
	const trimmedBefore = before.trimEnd();
	if (trimmedBefore === transcript || trimmedBefore.endsWith(` ${transcript}`) || trimmedBefore.endsWith(`\n${transcript}`)) {
		input.focus();
		return true;
	}
	input.value = before ? `${before} ${transcript}` : transcript;
	autoResize(input);
	input.focus();
	return true;
}

function formatSavedVoiceTime(updatedAt) {
	const ms = Number(updatedAt || 0);
	if (!Number.isFinite(ms) || ms <= 0) return "";
	try {
		return new Intl.DateTimeFormat(undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		}).format(new Date(ms));
	} catch {
		return "";
	}
}

function rememberLastVoiceTranscript(text, job = null) {
	const transcript = typeof text === "string" ? text.trim() : "";
	if (!transcript) return;
	const sessionId = typeof job?.sessionId === "string" && job.sessionId.trim()
		? job.sessionId.trim()
		: sessionCtrl?.getActiveSessionId?.() || "";
	setLastVoiceTranscript({
		text: transcript,
		updatedAt: Date.now(),
		sessionId,
		mode: normalizeVoiceInputMode(job?.mode),
	});
	updateAttachmentControls();
}

function restoreLastVoiceTranscript() {
	const sessionId = sessionCtrl?.getActiveSessionId?.() || null;
	const saved = getLastVoiceTranscript(sessionId);
	if (!saved?.text) {
		sessionCtrl?.appendNotice?.("No saved voice transcript yet.", "warning");
		return false;
	}
	if (input.disabled) {
		sessionCtrl?.appendNotice?.("Take over the session first to insert the saved voice transcript.", "warning");
		return false;
	}
	resetPromptHistoryNavigation();
	const inserted = appendTranscriptToComposer(saved.text);
	if (inserted) {
		const when = formatSavedVoiceTime(saved.updatedAt);
		sessionCtrl?.appendNotice?.(when ? `Inserted last voice transcript from ${when}.` : "Inserted last voice transcript.", "info");
	}
	return inserted;
}

async function handleVoiceTranscription(text, job = null) {
	const transcript = typeof text === "string" ? text.trim() : "";
	if (!transcript) return false;
	rememberLastVoiceTranscript(transcript, job);
	const mode = normalizeVoiceInputMode(job?.mode);
	if (mode === VOICE_INPUT_MODE_AUTO_SEND) {
		const sessionId = typeof job?.sessionId === "string" && job.sessionId.trim()
			? job.sessionId.trim()
			: sessionCtrl.getActiveSessionId();
		if (!sessionId) return false;
		const images = Array.isArray(job?.images)
			? job.images.filter((image) => image && typeof image === "object")
			: [];
		rememberPromptHistory(sessionId, transcript);
		// Fire-and-forget: don't block voice transcribing state on prompt delivery.
		// The job already has the transcript saved in IndexedDB, so it won't be re-transcribed.
		void sessionCtrl.sendPromptToSession(sessionId, transcript, images, {
			optimistic: sessionId === sessionCtrl.getActiveSessionId(),
			errorLabel: "Failed to send voice note",
		});
		return true;
	}
	if (document.visibilityState !== "visible" || input.disabled) return false;
	return appendTranscriptToComposer(transcript);
}

function resumePendingVoiceIfPossible() {
	if (!voiceRecorder || document.visibilityState !== "visible") return;
	void voiceRecorder.resumePending({ silent: true });
}

function updateAttachmentControls() {
	const hasSession = Boolean(sessionCtrl.getActiveSessionId());
	const isController = hasSession && sessionCtrl.isController();
	const actionBusy = sessionCtrl.getActionBusy ? sessionCtrl.getActionBusy() : null;
	const disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash";
	if (btnCommands) btnCommands.disabled = disabled;
	if (btnAttach) btnAttach.disabled = disabled;
	if (btnVoice) {
		btnVoice.disabled = disabled || !voiceUiReady || voiceRecorder?.isTranscribing?.();
		if (!voiceUiReady) btnVoice.title = "Voice loading…";
		else if (voiceRecorder?.isTranscribing?.()) btnVoice.title = "Transcribing…";
		else if (voiceRecorder?.isRecording?.()) btnVoice.title = voiceRecordingMode === "hold" ? "Release to stop" : "Tap to stop";
		else btnVoice.title = voiceInputMode === VOICE_INPUT_MODE_AUTO_SEND ? "Tap or hold to record and auto-send" : "Tap or hold to record";
	}
	if (btnLastVoice) {
		const sessionId = sessionCtrl?.getActiveSessionId?.() || null;
		const saved = getLastVoiceTranscript(sessionId);
		const when = saved ? formatSavedVoiceTime(saved.updatedAt) : "";
		btnLastVoice.hidden = !saved;
		btnLastVoice.disabled = disabled || !saved;
		btnLastVoice.title = saved
			? (when ? `Insert the last saved voice transcript from ${when}` : "Insert the last saved voice transcript")
			: "No saved voice transcript yet";
	}
	if (btnAttachClear) btnAttachClear.disabled = disabled || pendingAttachments.length === 0;
	if (imageInput) imageInput.disabled = disabled;
	if (!disabled && pendingAttachments.length === 0) {
		renderAttachmentBar();
	}
}

async function addImageFiles(files) {
	const list = Array.from(files || []).filter((file) => file && String(file.type || "").startsWith("image/"));
	if (list.length === 0) return;
	const remaining = Math.max(0, MAX_PENDING_ATTACHMENTS - pendingAttachments.length);
	if (remaining === 0) {
		sessionCtrl.appendNotice(`Attachment limit is ${MAX_PENDING_ATTACHMENTS} images.`, "warning");
		return;
	}
	const accepted = list.slice(0, remaining);
	for (const file of accepted) {
		const image = await fileToImageContent(file);
		pendingAttachments.push(image);
	}
	if (list.length > accepted.length) {
		sessionCtrl.appendNotice(`Added ${accepted.length} image${accepted.length === 1 ? "" : "s"}; ${list.length - accepted.length} over the ${MAX_PENDING_ATTACHMENTS}-image limit skipped.`, "warning");
	}
	renderAttachmentBar();
	updateControls();
}

function updateWorkingIndicator() {
	if (!workingIndicator) return;
	const activeState = sessionCtrl.getActiveState();
	const actionBusy = sessionCtrl.getActionBusy ? sessionCtrl.getActionBusy() : null;
	const show = sessionCtrl.getPendingPrompt() || Boolean(activeState && activeState.isStreaming) || Boolean(actionBusy);
	workingIndicator.classList.toggle("open", show);
	if (workingText) {
		workingText.textContent = actionBusy === "takeover"
			? "Taking over…"
			: actionBusy === "reconnect"
				? "Reconnecting…"
				: actionBusy === "release"
					? "Releasing…"
					: actionBusy === "compact"
						? "Compacting…"
						: actionBusy === "bash"
							? "Running shell…"
							: actionBusy === "abort"
								? "Aborting…"
								: "Working...";
	}

	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const updateFrame = () => {
		if (workingSpin) workingSpin.textContent = frames[workingFrame % frames.length];
		workingFrame = (workingFrame + 1) % frames.length;
	};

	if (show) {
		if (!workingIntervalId) {
			workingFrame = 0;
			updateFrame();
			workingIntervalId = setInterval(updateFrame, 80);
		}
	} else if (workingIntervalId) {
		clearInterval(workingIntervalId);
		workingIntervalId = null;
	}
}

function updateControls() {
	updateRolePill();

	const activeSessionId = sessionCtrl.getActiveSessionId();
	const activeState = sessionCtrl.getActiveState();
	const hasSession = Boolean(activeSessionId);
	const isController = hasSession && sessionCtrl.isController();
	const streaming = Boolean(activeState && activeState.isStreaming);
	const actionBusy = sessionCtrl.getActionBusy ? sessionCtrl.getActionBusy() : null;
	const canChangeSettings = hasSession && isController && !streaming && !actionBusy;
	const hasPromptHistory = hasSession && getSessionPromptHistory(activeSessionId).length > 0;
	uiPromptDialog?.reconcile?.(activeState?.pendingUiPromptIds || [], isController);
	terminalPane?.syncSession?.({
		sessionId: activeSessionId,
		cwd: activeState?.cwd || "",
		canWrite: hasSession ? isController : true,
	});

	btnAbort.disabled = !hasSession || Boolean(actionBusy && actionBusy !== "abort" && actionBusy !== "bash");
	btnTakeover.disabled = !hasSession || Boolean(actionBusy);
	if (btnCompact) btnCompact.disabled = !hasSession || !isController || streaming || Boolean(actionBusy);
	btnRelease.disabled = !hasSession || !isController || Boolean(actionBusy);
	input.disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash";
	if (btnModel) btnModel.disabled = !canChangeSettings;
	if (btnThinking) btnThinking.disabled = !canChangeSettings;
	if (btnHistory) btnHistory.disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash" || !hasPromptHistory;
	if (btnLoadMore) {
		const historyLoaded = sessionCtrl.isHistoryFullyLoaded ? sessionCtrl.isHistoryFullyLoaded() : false;
		btnLoadMore.style.display = (!hasSession || historyLoaded) ? "none" : "";
		btnLoadMore.disabled = Boolean(actionBusy);
	}
	if (btnTakeoverTxt) btnTakeoverTxt.textContent = actionBusy === "takeover" ? "Taking…" : actionBusy === "reconnect" ? "Reconnecting…" : isController ? "Reconnect" : "Take over";
	if (kbTakeoverTextNode) kbTakeoverTextNode.textContent = actionBusy === "takeover" ? " Taking…" : actionBusy === "reconnect" ? " Reconnecting…" : isController ? " Reconnect" : " Take over";
	if (btnAbortTxt) btnAbortTxt.textContent = actionBusy === "abort" ? "Aborting…" : actionBusy === "bash" ? "Stop" : "Abort";
	if (kbAbortTextNode) kbAbortTextNode.textContent = actionBusy === "abort" ? " Aborting…" : actionBusy === "bash" ? " Stop" : " Abort";
	if (btnCompactTxt) btnCompactTxt.textContent = actionBusy === "compact" ? "Compacting…" : "Compact";
	if (kbCompactTextNode) kbCompactTextNode.textContent = actionBusy === "compact" ? " Compacting…" : " Compact";
	if (btnReleaseTxt) btnReleaseTxt.textContent = actionBusy === "release" ? "Releasing…" : "Release";
	updateAttachmentControls();

	if (kbAbort) kbAbort.disabled = !hasSession || Boolean(actionBusy && actionBusy !== "abort" && actionBusy !== "bash");
	if (kbTakeover) kbTakeover.disabled = !hasSession || Boolean(actionBusy);
	if (kbRelease) kbRelease.disabled = !hasSession || !isController || Boolean(actionBusy);
	if (kbCompact) kbCompact.disabled = !hasSession || !isController || streaming || Boolean(actionBusy);
	if (kbEnter) kbEnter.disabled = !hasSession || !isController || actionBusy === "release" || actionBusy === "compact" || actionBusy === "bash";

	if (!hasSession) {
		input.placeholder = "";
	} else if (isController) {
		input.placeholder = streaming
			? "Streaming…"
			: "Message…";
	} else {
		input.placeholder = streaming ? "Streaming…" : "Viewer — take over to type";
	}

	if (btnTerminal) btnTerminal.classList.toggle("active", Boolean(terminalPane?.isOpen?.()));
	if (kbTerminal) kbTerminal.classList.toggle("active", Boolean(terminalPane?.isOpen?.()));

	updateTopSelectors();
	updateWorkingIndicator();
}

function autoResize(el) {
	if (!el.value) {
		el.style.height = "";
		return;
	}
	// Preserve msgs scroll position when editor grows/shrinks
	const oldH = el.offsetHeight;
	el.style.height = "auto";
	el.style.height = Math.min(el.scrollHeight, 200) + "px";
	const delta = el.offsetHeight - oldH;
	if (delta !== 0 && msgs) {
		msgs.scrollTop += delta;
	}
}

function fillBorders() {
	const chat = document.querySelector(".chat");
	const w = chat.getBoundingClientRect().width;
	const charW = 8.1;
	const count = Math.floor(w / charW);
	const dashes = "─".repeat(Math.max(10, count));
	document.querySelectorAll(".editor-border").forEach((el) => {
		el.textContent = dashes;
	});
}

async function sendPromptFromInput() {
	if (input.disabled) return false;
	const text = input.value;
	const images = pendingAttachments.map((attachment) => attachment.content);
	if (!text.trim() && images.length === 0) return false;
	const launcherCommand = handleLauncherSlashCommand(text);
	if (launcherCommand.matched) {
		if (launcherCommand.opened) {
			resetPromptHistoryNavigation();
			input.value = "";
			autoResize(input);
		}
		return launcherCommand.opened;
	}
	haptic();
	const snapshot = pendingAttachments.slice();
	const sessionId = sessionCtrl.getActiveSessionId();
	if (sessionId && text.trim()) rememberPromptHistory(sessionId, text);
	resetPromptHistoryNavigation();
	input.value = "";
	autoResize(input);
	if (sessionId) sessionDrafts.delete(sessionId);
	clearAttachments();
	const activeState = sessionCtrl.getActiveState?.();
	const deliverAs = activeState?.isStreaming ? getStreamingSendMode() : undefined;
	try {
		await sessionCtrl.sendPrompt(text, images, { deliverAs });
		return true;
	} catch (error) {
		pendingAttachments = snapshot;
		renderAttachmentBar();
		updateControls();
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
		return false;
	} finally {
		input.focus();
	}
}

function closeOpenOverlays() {
	let closed = false;
	if (menuOverlay?.classList?.contains("open")) {
		menuCtrl?.close?.();
		uiPromptDialog?.close?.();
		branchLauncher?.close?.();
		closed = true;
	}
	if (sidebar?.classList?.contains("open")) {
		sidebarCtrl?.setOpen?.(false);
		closed = true;
	}
	if (terminalPane?.isOverlayOpen?.()) {
		terminalPane.setOpen(false, { focus: false });
		closed = true;
	}
	return closed;
}

function handleEscapeAction() {
	if (closeOpenOverlays()) return;
	void sessionCtrl.abortRun();
}

const sessionCtrl = createSessionController({
	msgsEl: msgs,
	api,
	clientId,
	token,
	isPhoneLikeFn: isPhoneLike,
	onStateChange: () => {
		const currentSessionId = sessionCtrl.getActiveSessionId();
		if (currentSessionId !== lastBranchLauncherSessionId) {
			branchLauncher?.close?.();
			lastBranchLauncherSessionId = currentSessionId;
		}
		syncSessionUrl(currentSessionId);
		syncPromptHistoryState();
		updateFooter();
		updateControls();
		void pushCtrl?.syncActivity?.();
	},
	onCloseMenu: () => {
		if (menuOverlay?.dataset?.locked === "1") return;
		menuCtrl?.close();
	},
	onSidebarClose: () => sidebarCtrl?.setOpen(false),
	onSidebarRefresh: () => sidebarCtrl?.refresh(),
	onUiSelect: (uiId, title, options) => {
		if (uiPromptDialog) {
			uiPromptDialog.showSelect(uiId, title, options, (id, cancelled, value) => {
				void sessionCtrl.sendUiResponse(id, cancelled, value);
			});
		}
	},
	onUiInput: (uiId, title, placeholder) => {
		if (uiPromptDialog) {
			uiPromptDialog.showInput(uiId, title, placeholder, (id, cancelled, value) => {
				void sessionCtrl.sendUiResponse(id, cancelled, value);
			});
		}
	},
	onUiConfirm: (uiId, title, message) => {
		if (uiPromptDialog) {
			uiPromptDialog.showConfirm(uiId, title, message, (id, cancelled, value) => {
				void sessionCtrl.sendUiResponse(id, cancelled, value);
			});
		}
	},
	onUiPromptClosed: (uiId) => {
		uiPromptDialog?.close?.(uiId);
	},
	onReusePrompt: (text) => {
		reusePrompt(text);
	},
	onSessionEnded: (sessionId) => {
		uiPromptDialog?.close?.();
	},
	loadFullHistory: LOAD_FULL_SESSION_HISTORY,
	onUserTurn: (sessionId) => {
		// Mark session as needing attention when assistant finishes responding
		if (sessionId !== sessionCtrl.getActiveSessionId?.()) {
			sidebarCtrl?.markNeedsAttention?.(sessionId);
		}
	},
});

sidebarCtrl = createSidebar({
	sessionsList,
	sidebar,
	sidebarOverlay,
	sidebarLabel,
	btnSidebarLeft,
	btnSidebarRight,
	api,
	clientId,
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	onSelectSession: async (s) => {
		await sessionCtrl.selectSession(s);
		clearAttachments();
		// Clear attention marker when user views the session
		if (s?.id) sidebarCtrl?.clearAttention?.(s.id);
	},
	onSessionIdSelected: (sessionId) => {
		sessionCtrl.openSessionId(sessionId);
		clearAttachments();
		updateControls();

		// Clear attention marker when user opens the session
		if (sessionId) sidebarCtrl?.clearAttention?.(sessionId);
	},
	onRenameSession: async (session, name) => {
		if (!session) return;
		if (sessionCtrl.getActiveSessionId() !== session.id) {
			await sessionCtrl.selectSession(session);
		}
		await sessionCtrl.setSessionName(name);
	},
});

menuCtrl = createMenu({
	menuOverlay,
	menuScrim,
	menuPanel,
	btnModel,
	btnThinking,
	btnCommands,
	btnSettings,
	api,
	clientId,
	onNotice: sessionCtrl.appendNotice,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	getActiveState: () => sessionCtrl.getActiveState(),
	getPrefs: () => ({
		theme: document.body.classList.contains("light") ? "light" : "dark",
		sendOnEnter,
		fontScale,
		voiceInputMode,
		voiceTranscriptionMode: getVoiceTranscriptionMode(),
		webSpeechSupported: isWebSpeechSupported(),
		faceIdEnabled,
		pushSupported: pushCtrl?.isSupported?.() ?? false,
		pushSubscribed: pushCtrl?.isSubscribed?.() ?? false,
		steeringMode: sessionCtrl.getActiveState()?.steeringMode || null,
		followUpMode: sessionCtrl.getActiveState()?.followUpMode || null,
		hasSessionControl: Boolean(sessionCtrl.getActiveSessionId() && sessionCtrl.isController()),
	}),
	onToggleTheme: () => {
		const isLight = document.body.classList.toggle("light");
		setThemePreference(isLight ? "light" : "dark");
		if (btnTheme) btnTheme.textContent = isLight ? "☾" : "☀";
		terminalPane?.refreshTheme?.();
	},
	onToggleSendOnEnter: () => {
		sendOnEnter = !sendOnEnter;
		setSendOnEnterEnabled(sendOnEnter);
		updateControls();
	},
	onAdjustFontScale: (delta) => {
		fontScale = Math.max(0.85, Math.min(1.35, Math.round((fontScale + delta) * 100) / 100));
		setFontScalePreference(fontScale);
		document.documentElement.style.setProperty("--font-scale", String(fontScale));
	},
	onToggleVoiceInputMode: () => {
		voiceInputMode = voiceInputMode === VOICE_INPUT_MODE_AUTO_SEND ? VOICE_INPUT_MODE_COMPOSE : VOICE_INPUT_MODE_AUTO_SEND;
		setVoiceInputMode(voiceInputMode);
		updateControls();
	},
	onToggleVoiceTranscriptionMode: () => {
		const current = getVoiceTranscriptionMode();
		const next = current === "web-speech" ? "chatgpt" : "web-speech";
		setVoiceTranscriptionMode(next);
		// Recreate voice recorder with new setting
		if (voiceRecorder) {
			voiceRecorder = createVoiceRecorder({
				api,
				onTranscription: handleVoiceTranscription,
				onJobQueued: handleQueuedVoiceJob,
				onNotice: sessionCtrl.appendNotice,
				onStateChange: updateVoiceButtonState,
				useWebSpeech: next === "web-speech",
			});
		}
	},
	onTogglePush: async () => {
		if (!pushCtrl) return;
		await pushCtrl.toggle();
	},
	onTestPush: async () => {
		if (!pushCtrl) return;
		await pushCtrl.test();
	},
	onSetSteeringMode: async (mode) => {
		await sessionCtrl.setSteeringMode(mode);
	},
	onSetFollowUpMode: async (mode) => {
		await sessionCtrl.setFollowUpMode(mode);
	},
	onInsertCommand: (value) => {
		if (input.disabled) return;
		input.value = value;
		autoResize(input);
		input.focus();
	},
	onExecuteCommand: async (value) => {
		const launcherCommand = handleLauncherSlashCommand(value);
		if (launcherCommand.matched) return;
		await sessionCtrl.sendPrompt(value);
	},
	onRunTree: () => {
		openTreeLauncher();
	},
	onRunFork: () => {
		openForkLauncher();
	},
});

uiPromptDialog = createUiPromptDialog({ menuOverlay, menuScrim, menuPanel });
branchLauncher = createSessionBranchLauncher({
	menuOverlay,
	menuPanel,
	api,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	onNotice: (message, level = "info") => sessionCtrl.appendNotice(message, level),
	onNavigate: async ({ targetId, summarize, customInstructions, replaceInstructions, label }) => {
		const result = await sessionCtrl.navigateTree({ targetId, summarize, customInstructions, replaceInstructions, label });
		if (!result || result.cancelled) return false;
		clearAttachments();
		const currentSessionId = sessionCtrl.getActiveSessionId?.();
		if (typeof result.editorText === "string") {
			if (currentSessionId) sessionDrafts.set(currentSessionId, result.editorText);
			resetPromptHistoryNavigation();
			setComposerText(result.editorText);
		} else {
			if (currentSessionId) sessionDrafts.delete(currentSessionId);
			resetPromptHistoryNavigation();
			setComposerText("");
		}
		return true;
	},
	onFork: async ({ entryId }) => {
		const previousSessionId = sessionCtrl.getActiveSessionId?.();
		const result = await sessionCtrl.forkSession(entryId);
		if (!result || result.cancelled || !result.sessionId) return false;
		clearAttachments();
		if (typeof result.selectedText === "string" && result.selectedText.trim()) {
			sessionDrafts.set(result.sessionId, result.selectedText);
		} else {
			sessionDrafts.delete(result.sessionId);
		}
		try {
			sessionCtrl.openSessionId(result.sessionId);
			await sessionCtrl.refreshState({ silent: true, syncMessages: false });
			return true;
		} catch (error) {
			if (previousSessionId) {
				sessionCtrl.openSessionId(previousSessionId);
				await sessionCtrl.refreshState({ silent: true, syncMessages: false }).catch(() => {});
			}
			sessionCtrl.appendNotice(`Fork was created, but opening it failed. You were returned to the previous session. You can reopen ${result.sessionId} from the sidebar.`, "warning");
			throw error;
		}
	},
});

// Keep the optional terminal isolated from the main app boot path.
// If xterm assets are missing, sessions should still load normally.
let terminalPaneLoadPromise = null;
let terminalPaneLoadFailed = false;
let terminalPaneStylesRequested = false;
const restoreTerminalPaneOnStartup = !isStandalonePwa() && getTerminalPaneOpen();
if (isStandalonePwa()) setTerminalPaneOpen(false);

function ensureTerminalPaneStylesLoaded() {
	if (terminalPaneStylesRequested) return;
	terminalPaneStylesRequested = true;
	if (document.querySelector('link[data-terminal-pane-style="xterm"]')) return;
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = "/vendor/xterm/xterm.css";
	link.dataset.terminalPaneStyle = "xterm";
	document.head.appendChild(link);
}

function setTerminalButtonAvailability(unavailable) {
	if (btnTerminal) {
		btnTerminal.disabled = unavailable;
		btnTerminal.title = unavailable ? "Terminal unavailable" : "Toggle terminal pane";
	}
	if (kbTerminal) {
		kbTerminal.disabled = unavailable;
		kbTerminal.title = unavailable ? "Terminal unavailable" : "Terminal";
	}
}

function getTerminalPaneStateSnapshot() {
	const activeSessionId = sessionCtrl.getActiveSessionId();
	const activeState = sessionCtrl.getActiveState();
	return {
		sessionId: activeSessionId,
		cwd: activeState?.cwd || "",
		canWrite: activeSessionId ? sessionCtrl.isController() : true,
	};
}

async function ensureTerminalPaneLoaded({ showNotice = false } = {}) {
	if (terminalPane) return terminalPane;
	if (terminalPaneLoadFailed) {
		if (showNotice) sessionCtrl.appendNotice("Terminal is unavailable. Reinstall dependencies and reload the page.", "warning");
		return null;
	}
	if (!terminalPaneLoadPromise) {
		ensureTerminalPaneStylesLoaded();
		terminalPaneLoadPromise = import("./terminal/pane.js?v=1776100002")
			.then((module) => {
				if (typeof module?.createTerminalPane !== "function") {
					throw new Error("Terminal pane module is missing createTerminalPane().");
				}
				terminalPane = module.createTerminalPane({
					rootEl: document.getElementById("terminal-pane"),
					clientId,
					token,
					isPhoneLikeFn: isPhoneLike,
					onNotice: (message, level = "info") => sessionCtrl.appendNotice(message, level),
					onOpenChange: (open) => {
						setTerminalPaneOpen(open);
						if (sidebarCtrl && open) sidebarCtrl.setOpen(false);
						updateControls();
					},
				});
				terminalPane.syncSession(getTerminalPaneStateSnapshot());
				setTerminalButtonAvailability(false);
				updateControls();
				return terminalPane;
			})
			.catch((error) => {
				terminalPaneLoadFailed = true;
				setTerminalPaneOpen(false);
				setTerminalButtonAvailability(true);
				updateControls();
				console.error("Failed to initialize terminal pane", error);
				if (showNotice) sessionCtrl.appendNotice("Terminal is unavailable. Reinstall dependencies and reload the page.", "warning");
				return null;
			})
			.finally(() => {
				terminalPaneLoadPromise = null;
			});
	}
	return terminalPaneLoadPromise;
}

async function toggleTerminalPane() {
	const pane = await ensureTerminalPaneLoaded({ showNotice: true });
	pane?.toggle?.();
}

function setSidebarOpenFromUi(open) {
	const next = Boolean(open);
	if (next && terminalPane?.isOverlayOpen?.()) {
		terminalPane.setOpen(false, { focus: false });
	}
	sidebarCtrl?.setOpen?.(next);
}

function toggleSidebarFromUi() {
	const isOpen = sidebarCtrl?.isOpen?.() || sidebar?.classList?.contains("open");
	setSidebarOpenFromUi(!isOpen);
}

void (async () => {
	if (!restoreTerminalPaneOnStartup) return;
	const pane = await ensureTerminalPaneLoaded({ showNotice: true });
	pane?.setOpen?.(true, { focus: false });
})();

pushCtrl = installPushNotifications({
	api,
	btnNotify,
	lblNotify,
	clientId,
	getActiveSessionId: () => sessionCtrl.getActiveSessionId(),
	onNotice: sessionCtrl.appendNotice,
});
void pushCtrl.start();

let voiceRecordingMode = null;
let voiceUiReady = false;
let voiceRecorder = null;

function updateVoiceButtonState() {
	if (btnVoice && voiceRecorder) {
		const rec = voiceRecorder.isRecording();
		const trans = voiceRecorder.isTranscribing();
		if (!rec) voiceRecordingMode = null;
		btnVoice.classList.toggle("recording", rec);
		btnVoice.classList.toggle("transcribing", voiceUiReady && trans);
		btnVoice.classList.toggle("pending", !voiceUiReady && !rec);
		btnVoice.disabled = trans || !voiceUiReady;
		btnVoice.textContent = !voiceUiReady ? "\uD83C\uDF99" : trans ? "⏳" : "\uD83C\uDF99";
		btnVoice.title = !voiceUiReady
			? "Voice loading…"
			: trans
				? "Transcribing…"
				: rec
					? (voiceRecordingMode === "hold" ? "Release to stop" : "Tap to stop")
					: voiceInputMode === VOICE_INPUT_MODE_AUTO_SEND
						? "Tap or hold to record and auto-send"
						: "Tap or hold to record";
	}
}

voiceRecorder = createVoiceRecorder({
	api,
	onTranscription: handleVoiceTranscription,
	onJobQueued: handleQueuedVoiceJob,
	onNotice: sessionCtrl.appendNotice,
	onStateChange: updateVoiceButtonState,
	useWebSpeech: getVoiceTranscriptionMode() === "web-speech",
});

// Set UI ready immediately - don't block on resumePending (fixes hourglass bug)
voiceUiReady = true;
if (btnVoice && voiceRecorder) {
	btnVoice.classList.toggle("pending", false);
	btnVoice.textContent = voiceRecorder.isTranscribing() ? "⏳" : "\uD83C\uDF99";
}
updateControls();

// Resume pending jobs in background with timeout protection
void Promise.race([
	voiceRecorder.resumePending({ silent: true }),
	new Promise((_, reject) => setTimeout(() => reject(new Error("resume timeout")), 5000))
]).catch(() => {
	// Silently ignore - will retry on visibility change
});

resumePendingVoiceIfPossible();
let voiceWasHidden = false;
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "hidden") {
		voiceWasHidden = true;
		return;
	}
	if (document.visibilityState === "visible" && voiceWasHidden) {
		voiceWasHidden = false;
		resumePendingVoiceIfPossible();
		// Force refresh voice button state in case transcribing finished while app was hidden
		updateVoiceButtonState();
	}
});

btnAbort.addEventListener("click", () => { haptic(15); void sessionCtrl.abortRun(); });
if (btnCompact) btnCompact.addEventListener("click", () => {
	void sessionCtrl.compact();
});
if (btnTerminal) btnTerminal.addEventListener("click", () => {
	void toggleTerminalPane();
});
btnTakeover.addEventListener("click", () => {
	void sessionCtrl.takeOver().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
btnRelease.addEventListener("click", () => {
	void sessionCtrl.release().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
if (btnAttach) btnAttach.addEventListener("click", () => imageInput?.click());
if (btnHistory) btnHistory.addEventListener("click", () => openPromptHistoryDialog());
if (btnLoadMore) btnLoadMore.addEventListener("click", () => {
	void sessionCtrl.loadFullHistory();
});
if (btnLastVoice) btnLastVoice.addEventListener("click", () => { restoreLastVoiceTranscript(); });
if (btnVoice) {
	let pressActive = false;
	let holdStarting = false;
	let holdTimer = null;
	let activePointerId = null;
	const HOLD_DELAY_MS = 220;
	const pulseHaptic = () => {
		try { navigator.vibrate?.(12); } catch {}
	};
	const clearHoldTimer = () => {
		if (holdTimer) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	};

	const startVoiceRecording = async (mode, e) => {
		if (btnVoice.disabled || holdStarting || voiceRecorder.isRecording() || voiceRecorder.isTranscribing()) return;
		e?.preventDefault?.();
		holdStarting = true;
		voiceRecordingMode = mode;
		if (mode === "hold") {
			btnVoice.classList.add("holding");
			pulseHaptic();
			if (typeof activePointerId === "number" && btnVoice.setPointerCapture) {
				try { btnVoice.setPointerCapture(activePointerId); } catch {}
			}
		}
		try {
			const result = await voiceRecorder.start({ jobMeta: buildVoiceJobMeta() });
			if (result?.primed) {
				voiceRecordingMode = null;
				btnVoice.classList.remove("holding");
				return;
			}
		} finally {
			holdStarting = false;
			if (mode === "hold" && !pressActive && voiceRecorder.isRecording()) {
				pulseHaptic();
				voiceRecorder.stop();
			}
			if (!pressActive) btnVoice.classList.remove("holding");
		}
	};

	const stopVoiceHold = (e) => {
		if (voiceRecordingMode !== "hold" && !holdStarting && !pressActive) return;
		e?.preventDefault?.();
		clearHoldTimer();
		pressActive = false;
		activePointerId = null;
		btnVoice.classList.remove("holding");
		if (voiceRecordingMode === "hold" && voiceRecorder.isRecording()) {
			pulseHaptic();
			voiceRecorder.stop();
		}
	};

	const toggleTapRecording = async (e) => {
		if (btnVoice.disabled || holdStarting || voiceRecorder.isTranscribing()) return;
		e?.preventDefault?.();
		clearHoldTimer();
		if (voiceRecorder.isRecording()) {
			if (voiceRecordingMode === "tap") {
				pulseHaptic();
				voiceRecorder.stop();
			}
			return;
		}
		pulseHaptic();
		await startVoiceRecording("tap", e);
	};

	btnVoice.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || btnVoice.disabled || voiceRecorder.isTranscribing()) return;
		pressActive = true;
		activePointerId = e.pointerId;
		clearHoldTimer();
		holdTimer = setTimeout(() => {
			holdTimer = null;
			if (pressActive && !voiceRecorder.isRecording() && !voiceRecorder.isTranscribing()) {
				void startVoiceRecording("hold", e);
			}
		}, HOLD_DELAY_MS);
	});
	btnVoice.addEventListener("pointerup", async (e) => {
		const wasPendingTap = Boolean(pressActive && holdTimer);
		if (wasPendingTap) {
			pressActive = false;
			activePointerId = null;
			clearHoldTimer();
			await toggleTapRecording(e);
			return;
		}
		stopVoiceHold(e);
	});
	btnVoice.addEventListener("pointercancel", stopVoiceHold);
	window.addEventListener("pointerup", (e) => {
		if (voiceRecordingMode === "hold" || holdStarting) stopVoiceHold(e);
	});
	window.addEventListener("pointercancel", stopVoiceHold);
	window.addEventListener("pagehide", stopVoiceHold);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") stopVoiceHold();
	});
	btnVoice.addEventListener("keydown", async (e) => {
		if ((e.key === " " || e.key === "Enter") && !e.repeat) {
			e.preventDefault();
			if (voiceRecorder.isRecording() && voiceRecordingMode === "tap") {
				pulseHaptic();
				voiceRecorder.stop();
				return;
			}
			await toggleTapRecording(e);
		}
	});
}
if (btnAttachClear) btnAttachClear.addEventListener("click", () => clearAttachments());
if (btnTheme) btnTheme.addEventListener("click", () => {
	const isLight = document.body.classList.toggle("light");
	setThemePreference(isLight ? "light" : "dark");
	btnTheme.textContent = isLight ? "☾" : "☀";
	terminalPane?.refreshTheme?.();
});
if (btnTheme && document.body.classList.contains("light")) btnTheme.textContent = "☾";
if (btnSettings) btnSettings.addEventListener("click", () => menuCtrl.openSettingsMenu());
if (imageInput) {
	imageInput.addEventListener("change", async () => {
		try {
			await addImageFiles(imageInput.files || []);
		} catch (error) {
			sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
		} finally {
			imageInput.value = "";
		}
	});
}
if (btnModel) btnModel.addEventListener("click", () => void menuCtrl.openModelMenu());
if (btnThinking) btnThinking.addEventListener("click", () => menuCtrl.openThinkingMenu());
if (btnCommands) {
	btnCommands.addEventListener("mousedown", (e) => e.preventDefault());
	btnCommands.addEventListener("click", () => {
		if (document.activeElement === input) input.blur();
		setTimeout(() => menuCtrl?.openCommandsMenu?.(), 50);
	});
}

if (kbMenu) kbMenu.addEventListener("click", () => toggleSidebarFromUi());
if (btnMenuHeader) btnMenuHeader.addEventListener("click", () => toggleSidebarFromUi());
if (kbAbort) kbAbort.addEventListener("click", () => void sessionCtrl.abortRun());
if (kbCompact) kbCompact.addEventListener("click", () => {
	void sessionCtrl.compact();
});
if (kbTerminal) kbTerminal.addEventListener("click", () => {
	void toggleTerminalPane();
});
if (kbTakeover) kbTakeover.addEventListener("click", () => {
	void sessionCtrl.takeOver().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
if (kbRelease) kbRelease.addEventListener("click", () => {
	void sessionCtrl.release().catch((error) => {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	});
});
if (kbEnter) kbEnter.addEventListener("click", () => sendPromptFromInput());

// Composer "+" button — toggle action tray
{
	const plusBtn = document.getElementById("btn-composer-plus");
	const actionsTray = document.getElementById("composer-actions");
	if (plusBtn && actionsTray) {
		plusBtn.addEventListener("click", () => {
			const open = actionsTray.hidden;
			actionsTray.hidden = !open;
			plusBtn.classList.toggle("open", open);
		});
	}
}

if (sidebarOverlay) sidebarOverlay.addEventListener("click", () => setSidebarOpenFromUi(false));

// Scroll-to-bottom floating button with unread badge
if (btnScrollBottom && msgs) {
	let scrollBtnRaf = 0;
	let unreadCount = 0;
	let wasNearBottom = true;
	// Create badge element
	const badge = document.createElement("span");
	badge.className = "scroll-badge";
	badge.hidden = true;
	btnScrollBottom.appendChild(badge);

	const isNearBottom = () => {
		const remaining = Math.max(0, msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight);
		return remaining <= 400;
	};
	const updateScrollBtn = () => {
		scrollBtnRaf = 0;
		const scrollable = msgs.scrollHeight > msgs.clientHeight + 24;
		const near = isNearBottom();
		btnScrollBottom.hidden = !scrollable || near;
		if (near) { unreadCount = 0; badge.hidden = true; }
		wasNearBottom = near;
	};
	const scheduleScrollBtnUpdate = () => {
		if (scrollBtnRaf) return;
		scrollBtnRaf = requestAnimationFrame(updateScrollBtn);
	};
	// Track new messages arriving while scrolled up
	new MutationObserver(() => {
		if (!isNearBottom()) {
			const newBlocks = msgs.querySelectorAll(".user-msg, .assistant-block");
			const total = newBlocks.length;
			if (total > 0 && !wasNearBottom) {
				unreadCount++;
				badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
				badge.hidden = false;
			}
		}
		scheduleScrollBtnUpdate();
	}).observe(msgs, { childList: true });
	msgs.addEventListener("scroll", scheduleScrollBtnUpdate, { passive: true });
	new ResizeObserver(scheduleScrollBtnUpdate).observe(msgs);
	window.addEventListener("resize", scheduleScrollBtnUpdate);
	btnScrollBottom.addEventListener("click", () => {
		haptic();
		msgs.scrollTop = msgs.scrollHeight;
		unreadCount = 0;
		badge.hidden = true;
		scheduleScrollBtnUpdate();
	});
	scheduleScrollBtnUpdate();
}

input.addEventListener("input", () => {
	autoResize(input);
	resetPromptHistoryNavigation();
	updateSlashAutocomplete();
});
input.addEventListener("keydown", (e) => {
	if (!e.isComposing && isSlashAutocompleteVisible()) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSlashSelectedIndex(slashSelectedIndex + 1);
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setSlashSelectedIndex(slashSelectedIndex - 1);
			return;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			insertSelectedSlashCommand();
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			hideSlashAutocomplete();
			return;
		}
	}
	if (!e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
		if (e.key === "ArrowUp" && navigatePromptHistory("up")) {
			e.preventDefault();
			return;
		}
		if (e.key === "ArrowDown" && navigatePromptHistory("down")) {
			e.preventDefault();
			return;
		}
	}
	if (e.key !== "Enter" || e.isComposing) return;
	if (sendOnEnter) {
		if (!e.shiftKey) {
			e.preventDefault();
			sendPromptFromInput();
		}
		return;
	}
	if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
		e.preventDefault();
		sendPromptFromInput();
	}
});
input.addEventListener("click", updateSlashAutocomplete);
input.addEventListener("blur", () => setTimeout(hideSlashAutocomplete, 0));

window.addEventListener("paste", async (e) => {
	const files = Array.from(e.clipboardData?.files || []).filter((file) => file && String(file.type || "").startsWith("image/"));
	if (files.length === 0) return;
	e.preventDefault();
	try {
		await addImageFiles(files);
	} catch (error) {
		sessionCtrl.appendNotice(error instanceof Error ? error.message : String(error), "error");
	}
});

window.addEventListener("keydown", (e) => {
	if (e.altKey && e.key === "p" && !e.ctrlKey && !e.metaKey) {
		e.preventDefault();
		void menuCtrl.openModelMenu();
		return;
	}
	if (e.key === "Escape") {
		if (terminalPane?.handleGlobalKeydown?.(e)) return;
		e.preventDefault();
		handleEscapeAction();
	}
});

fillBorders();
window.addEventListener("resize", fillBorders);
window.addEventListener("resize", () => sidebarCtrl.setOpen(false));
window.addEventListener("pagehide", () => sidebarCtrl?.setOpen?.(false));
window.addEventListener("beforeunload", () => sidebarCtrl?.setOpen?.(false));

updateFooter();
updateControls();

function installNotificationSessionOpener() {
	if (!navigator.serviceWorker || typeof navigator.serviceWorker.addEventListener !== "function") return;
	navigator.serviceWorker.addEventListener("message", (event) => {
		const data = event?.data;
		if (!data || data.type !== "open_notification_session") return;
		const targetSessionId = typeof data.sessionId === "string" && data.sessionId.trim()
			? data.sessionId.trim()
			: extractSessionIdFromUrl(data.url);
		if (!targetSessionId) return;
		void openSessionTarget(targetSessionId);
	});
}

async function openSessionFromParam() {
	if (!sessionParam) return;
	await openSessionTarget(sessionParam);
}

installNotificationSessionOpener();

function installSidebarSwipeGestures() {
	let tracking = null;
	const edgeThreshold = 72;
	const commitThreshold = 32;

	const shouldCommit = () => {
		if (!tracking) return;
		const dx = tracking.lastX - tracking.x;
		const dy = tracking.lastY - tracking.y;
		if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy)) return;
		if (tracking.mode === "open" && dx > commitThreshold) {
			setSidebarOpenFromUi(true);
			tracking = null;
			return;
		}
		if (tracking.mode === "close" && dx < -commitThreshold) {
			setSidebarOpenFromUi(false);
			tracking = null;
		}
	};

	document.addEventListener("touchstart", (e) => {
		if (!sidebarCtrl || !e.touches || e.touches.length !== 1) return;
		const touch = e.touches[0];
		const sidebarOpen = sidebarCtrl.isOpen?.() || sidebar?.classList?.contains("open");
		const inSidebar = sidebar?.contains?.(e.target);
		const inOverlay = sidebarOverlay?.contains?.(e.target);
		if (!sidebarOpen && touch.clientX <= edgeThreshold) {
			tracking = { mode: "open", x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
			return;
		}
		if (sidebarOpen && (inSidebar || inOverlay)) {
			tracking = { mode: "close", x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY };
		}
	}, { passive: true });

	document.addEventListener("touchmove", (e) => {
		if (!tracking || !e.touches || e.touches.length !== 1) return;
		const touch = e.touches[0];
		tracking.lastX = touch.clientX;
		tracking.lastY = touch.clientY;
		shouldCommit();
	}, { passive: true });

	const reset = () => { tracking = null; };
	document.addEventListener("touchend", () => {
		shouldCommit();
		reset();
	}, { passive: true });
	document.addEventListener("touchcancel", reset, { passive: true });

	document.addEventListener("touchmove", (e) => {
		if (!sidebarCtrl?.isOpen?.() || !e.touches || e.touches.length !== 1) return;
		const target = e.target;
		if (!sidebar?.contains?.(target)) {
			e.preventDefault();
			return;
		}
		const scroller = target?.closest?.(".sessions") || sessionsList;
		if (!scroller) {
			e.preventDefault();
			return;
		}
		const touch = e.touches[0];
		const prevY = tracking?.lastY ?? touch.clientY;
		const dy = touch.clientY - prevY;
		const atTop = scroller.scrollTop <= 0;
		const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
		if ((atTop && dy > 0) || (atBottom && dy < 0)) {
			e.preventDefault();
		}
	}, { passive: false });
}
// Disabled: left-edge swipe-to-open conflicts with text selection on phones.
// Use the Sessions button instead.

if (replayName) {
	clearAttachments();
	void sessionCtrl.runReplay(replayName);
} else {
	void sidebarCtrl.refresh().then(() => openSessionFromParam());
}

if (faceIdEnabled) void faceIdGuard.start();

// Prevent pinch zoom and double-tap zoom
document.addEventListener("touchstart", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
