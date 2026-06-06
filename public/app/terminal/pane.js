import { Terminal } from "/vendor/xterm/xterm.mjs"
import { FitAddon } from "/vendor/xterm/addon-fit.mjs"
import { SearchAddon } from "/vendor/xterm/addon-search.mjs"
import { WebLinksAddon } from "/vendor/xterm/addon-web-links.mjs"

function wsUrlForSession(sessionId, clientId, token) {
	const base = window.location.protocol === "https:" ? "wss" : "ws"
	const terminalPath = sessionId
		? `/api/sessions/${encodeURIComponent(sessionId)}/terminal`
		: "/api/sessions/scratch/terminal"
	const url = new URL(`${base}://${window.location.host}${terminalPath}`)
	url.searchParams.set("clientId", clientId)
	if (token) url.searchParams.set("token", token)
	return url.toString()
}

const TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
const DESKTOP_TERMINAL_FONT_SIZE = 14
const MOBILE_TERMINAL_FONT_SIZE = 13
const TERMINAL_PADDING_X = 24
const TERMINAL_PADDING_Y = 18
const TERMINAL_OVERVIEW_RULER_WIDTH = 14
const MIN_TERMINAL_COLS = 20
const MIN_TERMINAL_ROWS = 6
const TERMINAL_RECONNECT_INITIAL_DELAY_MS = 1000
const TERMINAL_RECONNECT_MAX_DELAY_MS = 15000
const TERMINAL_RESIZE_DEBOUNCE_MS = 200

function getTerminalFontSize(mobileMode) {
	return mobileMode ? MOBILE_TERMINAL_FONT_SIZE : DESKTOP_TERMINAL_FONT_SIZE
}

function measureTerminalCell(stageEl, mobileMode) {
	if (!stageEl || typeof document === "undefined") return null
	const probe = document.createElement("span")
	probe.textContent = "W".repeat(32)
	probe.setAttribute("aria-hidden", "true")
	probe.style.position = "absolute"
	probe.style.visibility = "hidden"
	probe.style.pointerEvents = "none"
	probe.style.whiteSpace = "pre"
	probe.style.padding = "0"
	probe.style.margin = "0"
	probe.style.top = "0"
	probe.style.left = "0"
	probe.style.fontFamily = TERMINAL_FONT_FAMILY
	probe.style.fontSize = `${getTerminalFontSize(mobileMode)}px`
	probe.style.fontKerning = "none"
	probe.style.lineHeight = "normal"
	stageEl.appendChild(probe)
	try {
		const rect = probe.getBoundingClientRect()
		const cellWidth = rect.width / 32
		const cellHeight = rect.height
		if (!Number.isFinite(cellWidth) || cellWidth <= 0 || !Number.isFinite(cellHeight) || cellHeight <= 0) return null
		return { cellWidth, cellHeight }
	} finally {
		probe.remove()
	}
}

function estimateTerminalSize(stageEl, mobileMode) {
	const rect = stageEl?.getBoundingClientRect?.() || { width: 0, height: 0 }
	const measured = measureTerminalCell(stageEl, mobileMode)
	const cellWidth = measured?.cellWidth || (mobileMode ? 7.6 : 8.2)
	const cellHeight = measured?.cellHeight || (mobileMode ? 16 : 17)
	const cols = Math.max(
		MIN_TERMINAL_COLS,
		Math.floor(Math.max(0, rect.width - TERMINAL_PADDING_X - TERMINAL_OVERVIEW_RULER_WIDTH) / cellWidth),
	)
	const rows = Math.max(MIN_TERMINAL_ROWS, Math.floor(Math.max(0, rect.height - TERMINAL_PADDING_Y) / cellHeight))
	return { cols, rows }
}

function buildTerminalTheme() {
	const css = getComputedStyle(document.body)
	const isLight = document.body.classList.contains("light")
	const foreground = isLight ? "#111111" : "#f1f1f1"
	const accent = (css.getPropertyValue("--accent") || (isLight ? "#2D8A7E" : "#7EC8C0")).trim() || (isLight ? "#2D8A7E" : "#7EC8C0")
	const accentStrong = (css.getPropertyValue("--accent-strong") || accent).trim() || accent
	const muted = isLight ? "#555566" : "#aaaaaa"
	if (isLight) {
		return {
			background: "#ffffff",
			foreground,
			cursor: "#000000",
			cursorAccent: "#ffffff",
			selectionBackground: "rgba(45, 138, 126, 0.3)",
			black: "#000000",
			red: "#cc0000",
			green: "#4e9a06",
			yellow: "#c4a000",
			blue: "#3465a4",
			magenta: "#75507b",
			cyan: "#06989a",
			white: "#d3d7cf",
			brightBlack: muted,
			brightRed: "#ef2929",
			brightGreen: "#8ae234",
			brightYellow: "#fce94f",
			brightBlue: "#729fcf",
			brightMagenta: "#ad7fa8",
			brightCyan: "#34e2e2",
			brightWhite: "#eeeeec",
		}
	}
	return {
		background: "#000000",
		foreground,
		cursor: "#ffffff",
		cursorAccent: "#000000",
		selectionBackground: "rgba(126, 200, 192, 0.4)",
		black: "#2e3436",
		red: "#cc0000",
		green: "#4e9a06",
		yellow: "#c4a000",
		blue: "#3465a4",
		magenta: "#75507b",
		cyan: "#06989a",
		white: "#d3d7cf",
		brightBlack: muted,
		brightRed: "#ef2929",
		brightGreen: "#8ae234",
		brightYellow: "#fce94f",
		brightBlue: "#729fcf",
		brightMagenta: "#ad7fa8",
		brightCyan: "#34e2e2",
		brightWhite: "#eeeeec",
	}
}

function buildSearchOptions() {
	return {
		decorations: {
			matchBackground: "rgba(126, 200, 192, 0.12)",
			matchBorder: "rgba(126, 200, 192, 0.2)",
			matchOverviewRuler: "rgba(126, 200, 192, 0.28)",
			activeMatchBackground: "rgba(126, 200, 192, 0.28)",
			activeMatchBorder: "rgba(126, 200, 192, 0.55)",
			activeMatchColorOverviewRuler: "rgba(126, 200, 192, 0.55)",
		},
	}
}

const TERMINAL_SYNC_START = "\x1b[?2026h"
const TERMINAL_SYNC_END = "\x1b[?2026l"
const TERMINAL_SYNC_SEQUENCES = [TERMINAL_SYNC_START, TERMINAL_SYNC_END]
const TERMINAL_SYNC_SEQUENCE_MAX_PREFIX = Math.max(...TERMINAL_SYNC_SEQUENCES.map((sequence) => sequence.length - 1))
const TERMINAL_SCROLL_BOTTOM_THRESHOLD_PX = 5

function extractTrailingSyncPrefix(value) {
	const text = String(value || "")
	const maxPrefixLength = Math.min(text.length, TERMINAL_SYNC_SEQUENCE_MAX_PREFIX)
	for (let size = maxPrefixLength; size > 0; size -= 1) {
		const suffix = text.slice(-size)
		if (TERMINAL_SYNC_SEQUENCES.some((sequence) => sequence.startsWith(suffix) && sequence !== suffix)) {
			return suffix
		}
	}
	return ""
}

class TerminalWriter {
	constructor(term) {
		this.term = term
		this.queue = ""
		this.rafId = 0
		this.syncMode = false
		this.syncBuffer = ""
		this.pendingControl = ""
		this.viewport = null
		this.scrollHandler = null
		requestAnimationFrame(() => {
			const viewport = this.getViewport()
			if (!viewport) return
			this.scrollHandler = () => {
				if (this.term?.buffer?.active?.type === "alternate" && viewport.scrollTop !== 0) {
					viewport.scrollTop = 0
				}
			}
			viewport.addEventListener("scroll", this.scrollHandler, { passive: true })
		})
	}

	getViewport() {
		if (!this.viewport || !this.viewport.isConnected) {
			this.viewport = this.term?.element?.querySelector?.(".xterm-viewport") || null
		}
		return this.viewport
	}

	write(data) {
		if (typeof data !== "string" || data.length === 0) return
		let chunk = `${this.pendingControl}${data}`
		this.pendingControl = ""
		const trailingPrefix = extractTrailingSyncPrefix(chunk)
		if (trailingPrefix) {
			this.pendingControl = trailingPrefix
			chunk = chunk.slice(0, -trailingPrefix.length)
		}
		if (!chunk) return
		this.processChunk(chunk)
	}

	processChunk(data) {
		const syncStartIndex = data.indexOf(TERMINAL_SYNC_START)
		const syncEndIndex = data.indexOf(TERMINAL_SYNC_END)
		if (syncStartIndex !== -1 && !this.syncMode) {
			if (syncStartIndex > 0) this.enqueue(data.slice(0, syncStartIndex))
			this.syncMode = true
			const remainder = data.slice(syncStartIndex + TERMINAL_SYNC_START.length)
			if (remainder) this.processChunk(remainder)
			return
		}
		if (this.syncMode) {
			if (syncEndIndex !== -1) {
				this.syncBuffer += data.slice(0, syncEndIndex)
				this.syncMode = false
				if (this.syncBuffer) this.enqueue(this.syncBuffer)
				this.syncBuffer = ""
				const afterSync = data.slice(syncEndIndex + TERMINAL_SYNC_END.length)
				if (afterSync) this.processChunk(afterSync)
			} else {
				this.syncBuffer += data
			}
			return
		}
		this.enqueue(data)
	}

	enqueue(data) {
		if (!data) return
		this.queue += data
		if (this.rafId) return
		this.rafId = requestAnimationFrame(() => this.flush())
	}

	flush() {
		this.rafId = 0
		if (!this.queue) return
		const data = this.queue
		this.queue = ""
		const viewport = this.getViewport()
		let savedScrollTop = 0
		let restoreScroll = false
		if (viewport) {
			savedScrollTop = viewport.scrollTop
			const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
			restoreScroll = this.term?.buffer?.active?.type !== "alternate"
				&& savedScrollTop < maxScrollTop - TERMINAL_SCROLL_BOTTOM_THRESHOLD_PX
		}
		this.term.write(data, () => {
			const activeViewport = this.getViewport()
			if (!activeViewport) return
			if (this.term?.buffer?.active?.type === "alternate") {
				activeViewport.scrollTop = 0
				return
			}
			if (!restoreScroll) return
			const maxScrollTop = Math.max(0, activeViewport.scrollHeight - activeViewport.clientHeight)
			activeViewport.scrollTop = Math.min(savedScrollTop, maxScrollTop)
		})
		if (this.queue) {
			this.rafId = requestAnimationFrame(() => this.flush())
		}
	}

	dispose() {
		if (this.rafId) {
			cancelAnimationFrame(this.rafId)
			this.rafId = 0
		}
		const viewport = this.getViewport()
		if (viewport && this.scrollHandler) {
			viewport.removeEventListener("scroll", this.scrollHandler)
		}
		this.scrollHandler = null
		const remaining = `${this.syncBuffer}${this.pendingControl}${this.queue}`
		this.syncBuffer = ""
		this.pendingControl = ""
		this.queue = ""
		this.viewport = null
		if (remaining) {
			try { this.term.write(remaining) } catch {}
		}
	}
}

function decodeTerminalSequence(raw) {
	return String(raw || "")
		.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\t/g, "\t")
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
}

function ctrlSequenceForKeyEvent(event) {
	const key = String(event?.key || "")
	if (!key) return null
	if (key.length === 1) {
		const upper = key.toUpperCase()
		if (upper >= "A" && upper <= "Z") return String.fromCharCode(upper.charCodeAt(0) - 64)
		if (upper === "@" || key === "2" || key === " ") return "\x00"
		if (key === "[") return "\x1b"
		if (key === "\\") return "\x1c"
		if (key === "]") return "\x1d"
		if (key === "6" || key === "^") return "\x1e"
		if (key === "-" || key === "_") return "\x1f"
	}
	if (key === "Enter") return "\n"
	return null
}

function formatTabStatus(snapshot) {
	if (!snapshot) return ""
	if (snapshot.status === "exited") {
		const code = snapshot.exitCode
		const signal = snapshot.signal
		if (code !== null && code !== undefined) return `Exited · code ${code}`
		if (signal !== null && signal !== undefined && signal !== "") return `Exited · signal ${signal}`
		return "Exited"
	}
	return "Running"
}

export function createTerminalPane({
	rootEl,
	clientId,
	token,
	isPhoneLikeFn,
	onNotice,
	onOpenChange,
}) {
	const isOverlayLayout = () => !window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 1025px)").matches
	const tabsEl = rootEl.querySelector("#terminal-tabs")
	const stageEl = rootEl.querySelector("#terminal-stage")
	const emptyEl = rootEl.querySelector("#terminal-empty")
	const statusEl = rootEl.querySelector("#terminal-status")
	const searchEl = rootEl.querySelector("#terminal-search")
	const searchInput = rootEl.querySelector("#terminal-search-input")
	const btnClose = rootEl.querySelector("#btn-terminal-close")
	const btnFind = rootEl.querySelector("#btn-terminal-find")
	const btnCopy = rootEl.querySelector("#btn-terminal-copy")
	const btnPaste = rootEl.querySelector("#btn-terminal-paste")
	const btnNew = rootEl.querySelector("#btn-terminal-new")
	const btnSearchPrev = rootEl.querySelector("#btn-terminal-search-prev")
	const btnSearchNext = rootEl.querySelector("#btn-terminal-search-next")
	const btnSearchClose = rootEl.querySelector("#btn-terminal-search-close")
	const btnCtrl = rootEl.querySelector("#terminal-key-ctrl")
	const mobileKeyButtons = Array.from(rootEl.querySelectorAll(".terminal-key[data-seq]"))

	const state = {
		open: false,
		sessionId: null,
		cwd: "",
		canWrite: false,
		ws: null,
		connecting: false,
		connected: false,
		reconnectTimer: null,
		reconnectAttempts: 0,
		tabs: new Map(),
		activeTabId: null,
		stickyCtrl: false,
		searchOpen: false,
		expectNewTabFocus: false,
		lastStatus: "",
		lastStatusKind: "",
		keyboardInset: 0,
		keyboardSyncTimer: null,
		fitFrame: 0,
		resizeDebounceTimer: null,
		pendingInputMessages: [],
	}

	function notice(message, kind = "info") {
		if (typeof onNotice === "function") onNotice(message, kind)
	}

	function activeElementInsideTerminal() {
		const active = document.activeElement
		return Boolean(active && rootEl.contains(active))
	}

	function applyKeyboardInset() {
		const viewport = window.visualViewport
		let nextInset = 0
		if (state.open && isOverlayLayout() && viewport && activeElementInsideTerminal()) {
			const rawInset = Math.max(0, Math.round(window.innerHeight - viewport.height - Math.max(0, viewport.offsetTop || 0)))
			if (rawInset >= 80) nextInset = rawInset
		}
		const previousInset = state.keyboardInset
		if (previousInset === nextInset) return
		state.keyboardInset = nextInset
		rootEl.style.setProperty("--terminal-keyboard-offset", `${nextInset}px`)
		if (previousInset > 0 && nextInset === 0 && document.activeElement === searchInput) {
			try { searchInput.blur() } catch {}
		}
		scheduleFitActiveTerminal()
	}

	function scheduleKeyboardInsetSync() {
		requestAnimationFrame(() => applyKeyboardInset())
		if (state.keyboardSyncTimer) clearTimeout(state.keyboardSyncTimer)
		state.keyboardSyncTimer = setTimeout(() => {
			state.keyboardSyncTimer = null
			applyKeyboardInset()
		}, 90)
	}

	function clearReconnectTimer() {
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer)
			state.reconnectTimer = null
		}
	}

	function clearResizeDebounceTimer() {
		if (state.resizeDebounceTimer) {
			clearTimeout(state.resizeDebounceTimer)
			state.resizeDebounceTimer = null
		}
	}

	function clearLocalTabs() {
		for (const local of state.tabs.values()) {
			if (local.refreshFrame) cancelAnimationFrame(local.refreshFrame)
			try { local.writer?.dispose?.() } catch {}
			try { local.term.dispose() } catch {}
			try { local.buttonEl.remove() } catch {}
			try { local.viewEl.remove() } catch {}
		}
		state.tabs.clear()
		state.activeTabId = null
	}

	function setStatus(text, kind = "") {
		state.lastStatus = text || ""
		state.lastStatusKind = kind || ""
		statusEl.textContent = state.lastStatus || ""
		if (state.lastStatusKind) statusEl.dataset.kind = state.lastStatusKind
		else delete statusEl.dataset.kind
	}

	function renderEmptyState() {
		const hasTabs = state.tabs.size > 0
		emptyEl.hidden = hasTabs
		if (hasTabs) return
		if (!state.connected && !state.connecting) {
			emptyEl.textContent = "Connecting home terminal…"
			setStatus("Connecting home terminal…")
			return
		}
		if (state.connecting) {
			emptyEl.textContent = state.sessionId ? "Connecting terminal…" : "Connecting home terminal…"
			setStatus(state.sessionId ? "Connecting terminal…" : "Connecting home terminal…")
			return
		}
		if (!state.connected) {
			emptyEl.textContent = "Reconnecting terminal…"
			setStatus("Reconnecting terminal…")
			return
		}
		if (state.canWrite) {
			emptyEl.textContent = state.cwd
				? `No terminal tabs yet. Use ＋ to start one in ${state.cwd}.`
				: "No terminal tabs yet. Use ＋ to start one."
			setStatus(state.cwd ? `Ready · ${state.cwd}` : "Ready", "ok")
			return
		}
		emptyEl.textContent = "Take over the session to create a terminal tab."
		setStatus("Read-only terminal", "warning")
	}

	function updateTerminalPermissions() {
		for (const local of state.tabs.values()) {
			local.term.options.disableStdin = !state.canWrite || local.snapshot.status !== "running"
		}
		renderCtrlState()
		renderStatus()
	}

	function renderStatus() {
		if (!state.connected) {
			setStatus(state.connecting ? "Connecting terminal…" : "Reconnecting terminal…")
			return
		}
		const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
		if (!active) {
			renderEmptyState()
			return
		}
		const mode = state.canWrite ? "interactive" : "read-only"
		const detail = active.snapshot.cwd || state.cwd || ""
		setStatus(
			`${formatTabStatus(active.snapshot)} · ${mode}${detail ? ` · ${detail}` : ""}`,
			active.snapshot.status === "running" ? (state.canWrite ? "ok" : "warning") : "warning",
		)
	}

	function fitActiveTerminal(retries = 6) {
		const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
		if (!active || !state.open) return
		if (state.fitFrame) cancelAnimationFrame(state.fitFrame)
		const attemptFit = (remaining) => {
			if (!state.open || state.activeTabId !== active.id) {
				state.fitFrame = 0
				return
			}
			const proposed = active.fitAddon?.proposeDimensions?.()
			if ((!proposed || !proposed.cols || !proposed.rows) && remaining > 0) {
				state.fitFrame = requestAnimationFrame(() => attemptFit(remaining - 1))
				return
			}
			state.fitFrame = 0
			try { active.term.clearTextureAtlas?.() } catch {}
			if (proposed?.cols && proposed?.rows) {
				try {
					active.fitAddon.fit()
				} catch {}
			}
			queueTerminalRefresh(active, { force: true })
		}
		state.fitFrame = requestAnimationFrame(() => {
			state.fitFrame = requestAnimationFrame(() => attemptFit(retries))
		})
	}

	function scheduleFitActiveTerminal(delay = TERMINAL_RESIZE_DEBOUNCE_MS) {
		clearResizeDebounceTimer()
		state.resizeDebounceTimer = setTimeout(() => {
			state.resizeDebounceTimer = null
			fitActiveTerminal()
		}, delay)
	}

	function selectTab(tabId, options = {}) {
		if (!state.tabs.has(tabId)) return
		state.activeTabId = tabId
		for (const local of state.tabs.values()) {
			const active = local.id === tabId
			local.viewEl.classList.toggle("active", active)
			local.buttonEl.classList.toggle("active", active)
		}
		renderStatus()
		fitActiveTerminal()
		if (options.focus !== false) focusActiveTerminal()
	}

	function applyTheme() {
		const theme = buildTerminalTheme()
		for (const local of state.tabs.values()) {
			local.term.options.theme = theme
			try {
				local.term.refresh(0, Math.max(0, local.term.rows - 1))
			} catch {}
		}
	}

	function closeSearch() {
		state.searchOpen = false
		searchEl.hidden = true
		for (const local of state.tabs.values()) {
			if (typeof local.searchAddon.clearDecorations === "function") local.searchAddon.clearDecorations()
		}
		focusActiveTerminal()
	}

	function openSearch() {
		if (!activeLocalTab()) {
			notice("Open a terminal tab first", "warning")
			return
		}
		state.searchOpen = true
		searchEl.hidden = false
		searchInput.focus()
		searchInput.select()
	}

	function performSearch(direction = "next") {
		const active = state.activeTabId ? state.tabs.get(state.activeTabId) : null
		if (!active) return false
		const query = String(searchInput.value || "")
		if (!query.trim()) {
			if (typeof active.searchAddon.clearDecorations === "function") active.searchAddon.clearDecorations()
			return false
		}
		const opts = buildSearchOptions()
		return direction === "prev"
			? active.searchAddon.findPrevious(query, opts)
			: active.searchAddon.findNext(query, opts)
	}

	function renderCtrlState() {
		btnCtrl.classList.toggle("active", Boolean(state.stickyCtrl && state.canWrite))
		btnCtrl.disabled = !state.canWrite || state.tabs.size === 0
	}

	function activeLocalTab() {
		return state.activeTabId ? state.tabs.get(state.activeTabId) : null
	}

	function syncLocalTerminalSize(local, cols, rows) {
		if (!local || !Number.isFinite(cols) || !Number.isFinite(rows)) return false
		const nextCols = Math.max(2, Math.floor(Number(cols)))
		const nextRows = Math.max(2, Math.floor(Number(rows)))
		if (local.term.cols === nextCols && local.term.rows === nextRows) return false
		try {
			local.term.resize(nextCols, nextRows)
			return true
		} catch {
			return false
		}
	}

	function queueTerminalRefresh(local, { force = false } = {}) {
		if (!local || (!force && !isPhoneLikeFn())) return
		if (local.refreshFrame) cancelAnimationFrame(local.refreshFrame)
		local.refreshFrame = requestAnimationFrame(() => {
			local.refreshFrame = 0
			try {
				local.term.refresh(0, Math.max(0, local.term.rows - 1))
			} catch {}
		})
	}

	function updateTabButton(local) {
		local.buttonEl.classList.toggle("exited", local.snapshot.status === "exited")
		local.labelEl.textContent = local.snapshot.label
		local.closeBtn.disabled = !state.canWrite
		local.term.options.disableStdin = !state.canWrite || local.snapshot.status !== "running"
	}

	function handleCustomKey(local, event) {
		if (event.type !== "keydown") return true
		if (state.searchOpen && event.key === "Escape") {
			closeSearch()
			event.preventDefault()
			return false
		}
		if (!state.canWrite || local.snapshot.status !== "running") return true
		if (!state.stickyCtrl) return true
		const seq = ctrlSequenceForKeyEvent(event)
		state.stickyCtrl = false
		renderCtrlState()
		if (!seq) return true
		event.preventDefault()
		send({ type: "input", tabId: local.id, data: seq })
		return false
	}

	function createLocalTab(snapshot) {
		const viewEl = document.createElement("div")
		viewEl.className = "terminal-view"
		stageEl.appendChild(viewEl)

		const buttonEl = document.createElement("button")
		buttonEl.className = "terminal-tab"
		buttonEl.type = "button"
		const iconEl = document.createElement("span")
		iconEl.className = "terminal-tab-ico"
		iconEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16v10H4z"/><path d="M8 11l2 2-2 2"/><path d="M12 15h4"/></svg>'
		const labelEl = document.createElement("span")
		labelEl.className = "terminal-tab-label"
		const closeBtn = document.createElement("button")
		closeBtn.className = "terminal-tab-close"
		closeBtn.type = "button"
		closeBtn.title = "Close terminal tab"
		closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'
		buttonEl.appendChild(iconEl)
		buttonEl.appendChild(labelEl)
		buttonEl.appendChild(closeBtn)
		tabsEl.appendChild(buttonEl)

		const mobileMode = isPhoneLikeFn()
		const initialCols = Number.isFinite(snapshot.cols) ? Math.max(2, Math.floor(snapshot.cols)) : 80
		const initialRows = Number.isFinite(snapshot.rows) ? Math.max(2, Math.floor(snapshot.rows)) : 24
		const term = new Terminal({
			allowTransparency: false,
			cols: initialCols,
			rows: initialRows,
			convertEol: false,
			cursorBlink: !mobileMode,
			cursorStyle: mobileMode ? "bar" : "block",
			customGlyphs: !mobileMode,
			rescaleOverlappingGlyphs: false,
			disableStdin: !state.canWrite || snapshot.status !== "running",
			fontFamily: TERMINAL_FONT_FAMILY,
			fontSize: getTerminalFontSize(mobileMode),
			scrollback: 3000,
			theme: buildTerminalTheme(),
		})
		const fitAddon = new FitAddon()
		const searchAddon = new SearchAddon({ highlightLimit: 500 })
		const linksAddon = new WebLinksAddon((event, url) => {
			window.open(url, "_blank", "noopener")
		})
		const writer = new TerminalWriter(term)
		const local = {
			id: snapshot.id,
			snapshot: { ...snapshot },
			term,
			fitAddon,
			searchAddon,
			writer,
			viewEl,
			buttonEl,
			labelEl,
			closeBtn,
			refreshFrame: 0,
		}
		term.loadAddon(fitAddon)
		term.loadAddon(searchAddon)
		term.loadAddon(linksAddon)
		term.attachCustomKeyEventHandler((event) => handleCustomKey(local, event))
		term.open(viewEl)
		term.focus()
		term.onData((data) => {
			if (!state.canWrite || local.snapshot.status !== "running") return
			send({ type: "input", tabId: local.id, data })
		})
		term.onResize(({ cols, rows }) => {
			send({ type: "resize", tabId: local.id, cols, rows })
		})
		if (snapshot.history) {
			writer.write(snapshot.history)
			requestAnimationFrame(() => queueTerminalRefresh(local, { force: true }))
		}
		queueTerminalRefresh(local, { force: true })

		buttonEl.addEventListener("click", () => selectTab(local.id))
		closeBtn.addEventListener("click", (event) => {
			event.stopPropagation()
			if (!state.canWrite) {
				notice("Take over the session to close terminal tabs", "warning")
				return
			}
			send({ type: "close_tab", tabId: local.id })
		})
		viewEl.addEventListener("mousedown", () => selectTab(local.id, { focus: false }))
		viewEl.addEventListener("click", () => {
			selectTab(local.id, { focus: true })
			term.focus()
		})

		state.tabs.set(local.id, local)
		updateTabButton(local)
		return local
	}

	function flushPendingInputMessages() {
		if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.pendingInputMessages.length === 0) return
		const pending = state.pendingInputMessages.splice(0, state.pendingInputMessages.length)
		for (const message of pending) {
			if (!message?.tabId || !state.tabs.has(message.tabId)) continue
			try { state.ws.send(JSON.stringify(message)) } catch {
				state.pendingInputMessages.unshift(message)
				break
			}
		}
	}

	function handleInit(message) {
		const prevActive = state.activeTabId
		clearLocalTabs()
		for (const tab of message.tabs || []) {
			createLocalTab(tab)
		}
		const fallbackTabId = prevActive && state.tabs.has(prevActive)
			? prevActive
			: state.tabs.size > 0
				? [...state.tabs.keys()][0]
				: null
		if (fallbackTabId) selectTab(fallbackTabId, { focus: false })
		renderEmptyState()
		renderStatus()
		applyTheme()
		if (state.tabs.size === 0 && state.canWrite) {
			createNewTab()
		} else {
			flushPendingInputMessages()
		}
	}

	function handleTabOpened(message) {
		const local = createLocalTab(message.tab)
		if (!state.activeTabId || state.expectNewTabFocus) {
			selectTab(local.id)
		}
		state.expectNewTabFocus = false
		renderEmptyState()
		renderStatus()
	}

	function handleTabUpdated(message) {
		const local = state.tabs.get(message.tab?.id)
		if (!local) return
		local.snapshot = { ...local.snapshot, ...message.tab }
		updateTabButton(local)
		if (local.snapshot.status === "exited") state.stickyCtrl = false
		const didResize = syncLocalTerminalSize(local, local.snapshot.cols, local.snapshot.rows)
		if (didResize) queueTerminalRefresh(local, { force: true })
		renderCtrlState()
		renderStatus()
	}

	function handleTabOutput(message) {
		const local = state.tabs.get(message.tabId)
		if (!local || typeof message.data !== "string" || message.data.length === 0) return
		local.writer.write(message.data)
		queueTerminalRefresh(local)
	}

	function handleTabClosed(message) {
		const local = state.tabs.get(message.tabId)
		if (!local) return
		const closingActive = state.activeTabId === message.tabId
		if (local.refreshFrame) cancelAnimationFrame(local.refreshFrame)
		try { local.writer?.dispose?.() } catch {}
		try { local.term.dispose() } catch {}
		try { local.buttonEl.remove() } catch {}
		try { local.viewEl.remove() } catch {}
		state.tabs.delete(message.tabId)
		if (closingActive) {
			const next = state.tabs.size > 0 ? [...state.tabs.keys()][0] : null
			if (next) selectTab(next)
			else {
				state.activeTabId = null
				renderEmptyState()
				renderStatus()
			}
		}
		renderEmptyState()
		renderStatus()
		// Hide terminal pane when last tab is closed
		if (state.tabs.size === 0) {
			setOpen(false, { focus: false })
		}
	}

	function handleServerError(message) {
		if (message?.message) notice(message.message, message.code === "not_controller" ? "warning" : "error")
		renderStatus()
	}

	function handleMessage(event) {
		let payload = null
		try {
			payload = JSON.parse(event.data)
		} catch {
			notice("Received invalid terminal payload", "error")
			return
		}
		if (!payload || typeof payload.type !== "string") return
		if (payload.type === "init") {
			state.connected = true
			state.connecting = false
			state.reconnectAttempts = 0
			handleInit(payload)
			return
		}
		if (payload.type === "tab_opened") {
			handleTabOpened(payload)
			return
		}
		if (payload.type === "tab_updated") {
			handleTabUpdated(payload)
			return
		}
		if (payload.type === "tab_output") {
			handleTabOutput(payload)
			return
		}
		if (payload.type === "tab_closed") {
			handleTabClosed(payload)
			return
		}
		if (payload.type === "error") {
			handleServerError(payload)
		}
	}

	function scheduleReconnect() {
		if (!state.open || state.ws || state.connecting || state.reconnectTimer) return
		if (document.visibilityState === "hidden") return
		const delay = Math.min(
			TERMINAL_RECONNECT_MAX_DELAY_MS,
			TERMINAL_RECONNECT_INITIAL_DELAY_MS * (2 ** Math.max(0, state.reconnectAttempts - 1)),
		)
		state.reconnectTimer = setTimeout(() => {
			state.reconnectTimer = null
			connect()
		}, delay)
	}

	function closeSocket({ clearTabs = true } = {}) {
		clearReconnectTimer()
		const ws = state.ws
		state.ws = null
		state.connected = false
		state.connecting = false
		if (ws) {
			ws.onopen = null
			ws.onclose = null
			ws.onerror = null
			ws.onmessage = null
			try { ws.close() } catch {}
		}
		if (clearTabs) {
			clearLocalTabs()
			state.pendingInputMessages = []
		}
		state.stickyCtrl = false
		renderCtrlState()
		clearResizeDebounceTimer()
		renderEmptyState()
	}

	function connect() {
		if (!state.open || state.ws || state.connecting) return
		if (document.visibilityState === "hidden") return
		clearReconnectTimer()
		state.connecting = true
		renderEmptyState()
		try {
			const ws = new WebSocket(wsUrlForSession(state.sessionId, clientId, token))
			state.ws = ws
			ws.onopen = () => {
				state.connecting = false
				renderStatus()
			}
			ws.onmessage = handleMessage
			ws.onerror = () => {
				// Close handler owns reconnection.
			}
			ws.onclose = () => {
				if (state.ws !== ws) return
				state.ws = null
				state.connected = false
				state.connecting = false
				state.reconnectAttempts += 1
				renderEmptyState()
				scheduleReconnect()
			}
		} catch (error) {
			state.connecting = false
			state.reconnectAttempts += 1
			renderEmptyState()
			scheduleReconnect()
		}
	}

	function send(message) {
		if (!state.open) return false
		if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
			if (message?.type === "input") state.pendingInputMessages.push(message)
			connect()
			return message?.type === "input"
		}
		try {
			state.ws.send(JSON.stringify(message))
			return true
		} catch (error) {
			if (message?.type === "input") state.pendingInputMessages.push(message)
			return message?.type === "input"
		}
	}

	function createNewTab() {
		if (!state.canWrite) {
			notice(state.sessionId ? "Take over the session to open a terminal" : "Terminal is not writable", "warning")
			return false
		}
		const active = activeLocalTab()
		const size = active?.fitAddon?.proposeDimensions?.() || estimateTerminalSize(stageEl, isPhoneLikeFn())
		state.expectNewTabFocus = true
		const sent = send({
			type: "create_tab",
			cwd: state.cwd || undefined,
			cols: size.cols,
			rows: size.rows,
		})
		if (!sent) renderEmptyState()
		return sent
	}

	function focusActiveTerminal() {
		const active = activeLocalTab()
		if (!active) return
		if (state.searchOpen) {
			searchInput.focus()
			return
		}
		try { active.term.focus() } catch {}
	}

	async function copySelection() {
		const active = activeLocalTab()
		if (!active) return
		let text = active.term.getSelection?.() || ""
		if (!text) {
			active.term.selectAll()
			text = active.term.getSelection?.() || ""
			active.term.clearSelection?.()
		}
		if (!text) {
			notice("Nothing to copy from the terminal yet", "warning")
			return
		}
		try {
			await navigator.clipboard.writeText(text)
			setStatus("Copied terminal text", "ok")
		} catch (error) {
			notice(error instanceof Error ? error.message : String(error), "error")
		}
	}

	async function pasteClipboard() {
		if (!state.canWrite) {
			notice("Take over the session to paste into the terminal", "warning")
			return
		}
		const active = activeLocalTab()
		if (!active) return
		try {
			const text = await navigator.clipboard.readText()
			if (!text) return
			send({ type: "input", tabId: active.id, data: text })
			focusActiveTerminal()
		} catch (error) {
			notice(error instanceof Error ? error.message : String(error), "error")
		}
	}

	function sendMobileSequence(sequence) {
		if (!state.canWrite) {
			notice("Take over the session to use the terminal", "warning")
			return
		}
		const active = activeLocalTab()
		if (!active) return
		state.stickyCtrl = false
		renderCtrlState()
		send({ type: "input", tabId: active.id, data: sequence })
		focusActiveTerminal()
	}

	function setOpen(open, options = {}) {
		const next = Boolean(open)
		if (state.open === next) {
			if (state.open && options.focus !== false) focusActiveTerminal()
			return
		}
		state.open = next
		rootEl.classList.toggle("open", next)
		document.body.classList.toggle("terminal-open", next && isOverlayLayout())
		if (typeof onOpenChange === "function") onOpenChange(next)
		if (!next) {
			state.keyboardInset = 0
			rootEl.style.setProperty("--terminal-keyboard-offset", "0px")
			if (state.keyboardSyncTimer) {
				clearTimeout(state.keyboardSyncTimer)
				state.keyboardSyncTimer = null
			}
			closeSearch()
			closeSocket({ clearTabs: true })
			state.pendingInputMessages = []
			return
		}
		renderEmptyState()
		connect()
		scheduleKeyboardInsetSync()
		fitActiveTerminal()
		if (options.focus !== false) focusActiveTerminal()
	}

	function syncSession({ sessionId, cwd, canWrite }) {
		const normalizedSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null
		const normalizedCwd = typeof cwd === "string" ? cwd : ""
		const changedSession = normalizedSessionId !== state.sessionId
		state.sessionId = normalizedSessionId
		state.cwd = normalizedCwd
		state.canWrite = Boolean(canWrite)
		if (changedSession) {
			closeSearch()
			closeSocket({ clearTabs: true })
		}
		updateTerminalPermissions()
		if (state.open) connect()
		renderEmptyState()
		renderStatus()
	}

	function toggle() {
		setOpen(!state.open)
	}

	function handleGlobalKeydown(event) {
		if (!state.open) return false
		if (state.searchOpen && event.key === "Escape") {
			event.preventDefault()
			closeSearch()
			return true
		}
		const focusedInside = rootEl.contains(document.activeElement)
		if (state.stickyCtrl && event.key === "Escape" && focusedInside) {
			state.stickyCtrl = false
			renderCtrlState()
			event.preventDefault()
			return true
		}
		if (event.key === "Escape" && focusedInside) {
			return true
		}
		if (isOverlayLayout() && event.key === "Escape" && !focusedInside) {
			event.preventDefault()
			setOpen(false, { focus: false })
			return true
		}
		return false
	}

	btnClose.addEventListener("click", () => setOpen(false, { focus: false }))
	btnFind.addEventListener("click", () => {
		if (state.searchOpen) closeSearch()
		else openSearch()
	})
	btnCopy.addEventListener("click", () => { void copySelection() })
	btnPaste.addEventListener("click", () => { void pasteClipboard() })
	btnNew.addEventListener("click", () => { createNewTab() })
	btnSearchPrev.addEventListener("click", () => performSearch("prev"))
	btnSearchNext.addEventListener("click", () => performSearch("next"))
	btnSearchClose.addEventListener("click", () => closeSearch())
	searchInput.addEventListener("input", () => { performSearch("next") })
	searchInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault()
			performSearch(event.shiftKey ? "prev" : "next")
			return
		}
		if (event.key === "Escape") {
			event.preventDefault()
			closeSearch()
		}
	})
	btnCtrl.addEventListener("click", () => {
		if (!state.canWrite) {
			notice("Take over the session to use the terminal", "warning")
			return
		}
		state.stickyCtrl = !state.stickyCtrl
		renderCtrlState()
		focusActiveTerminal()
	})
	for (const button of mobileKeyButtons) {
		button.addEventListener("click", () => {
			sendMobileSequence(decodeTerminalSequence(button.dataset.seq || ""))
		})
	}

	new ResizeObserver(() => scheduleFitActiveTerminal()).observe(stageEl)
	window.addEventListener("resize", () => {
		scheduleFitActiveTerminal()
		scheduleKeyboardInsetSync()
	})
	window.addEventListener("orientationchange", () => {
		scheduleFitActiveTerminal()
		scheduleKeyboardInsetSync()
	})
	window.visualViewport?.addEventListener("resize", () => {
		scheduleFitActiveTerminal()
		scheduleKeyboardInsetSync()
	})
	document.fonts?.ready?.then(() => fitActiveTerminal()).catch(() => {})
	document.fonts?.addEventListener?.("loadingdone", () => fitActiveTerminal())
	document.addEventListener("focusin", () => scheduleKeyboardInsetSync(), true)
	document.addEventListener("focusout", () => scheduleKeyboardInsetSync(), true)
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			scheduleKeyboardInsetSync()
			if (state.open && !state.ws) connect()
		}
	})

	rootEl.style.setProperty("--terminal-keyboard-offset", "0px")
	renderCtrlState()
	renderEmptyState()

	return {
		setOpen,
		toggle,
		isOpen: () => state.open,
		isOverlayOpen: () => state.open && isOverlayLayout(),
		syncSession,
		refreshTheme: applyTheme,
		handleGlobalKeydown,
	}
}
