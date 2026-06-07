function formatRelativeTime(iso) {
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return "just now";
	const s = Math.floor(ms / 1000);
	if (s < 10) return "just now";
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d === 1) return "yesterday";
	return `${d}d ago`;
}

function shortPath(cwd) {
	if (!cwd) return "";
	return cwd.replace(/^\/root\//, "~/").replace(/^\/home\/[^/]+\//, "~/");
}

function isWorktreePath(cwd) {
	return typeof cwd === "string" && /\/.worktrees\/worktree-/.test(cwd);
}

function fuzzyMatchSession(query, hay) {
	if (!query) return true;
	const q = query.toLowerCase();
	const h = hay.toLowerCase();
	// Exact substring match
	if (h.includes(q)) return true;
	// Token match: all query tokens must appear somewhere
	const tokens = q.split(/\s+/).filter(Boolean);
	if (tokens.length > 1 && tokens.every((t) => h.includes(t))) return true;
	// Fuzzy char match: all query chars appear in order
	let qi = 0;
	for (let i = 0; i < h.length && qi < q.length; i++) {
		if (h[i] === q[qi]) qi++;
	}
	return qi === q.length;
}

function searchPathWithoutDotDirs(path) {
	const parts = String(path || "").split("/");
	const filtered = parts.filter((part, index) => {
		if (index === 0) return true;
		if (!part || part === "." || part === "..") return Boolean(part);
		return !part.startsWith(".");
	});
	return filtered.join("/");
}

function buildSessionSearchHaystack(session, query) {
	const trimmedQuery = String(query || "").trim();
	const includeDotDirs = trimmedQuery.startsWith(".");
	const cwd = includeDotDirs ? String(session?.cwd || "") : searchPathWithoutDotDirs(session?.cwd || "");
	return [session?.name || "", session?.startAgent || "", session?.firstMessage || "", cwd, session?.id || ""].join(" ");
}

function shouldShowSession(s) {
	if (!s || typeof s !== "object") return false;
	if (s.isRunning) return true;
	const name = typeof s.name === "string" ? s.name.trim() : "";
	if (name) return true;
	const first = typeof s.firstMessage === "string" ? s.firstMessage.trim() : "";
	return first && first !== "(no messages)";
}

function resolveProjectDialogBackHandler(options, fallback) {
	return typeof options?.onBack === "function" ? options.onBack : fallback;
}

export function createSidebar({
	sessionsList,
	sidebar,
	sidebarOverlay,
	sidebarLabel,
	btnSidebarLeft,
	btnSidebarRight,
	api,
	clientId,
	onNotice,
	getActiveSessionId,
	onSelectSession,
	onSessionIdSelected,
	onRenameSession,
}) {
	let isOpen = false;
	let viewMode = "sessions";
	let activeDeleteButton = null;
	let activeDeleteTimer = null;
	let lastRenderedSessions = [];
	let lastFetchedSessions = [];
	let sessionSearchQuery = "";
	let showArchivedSessions = false;
	const collapsedSessionGroups = new Set();
	const expandedExtraGroups = new Set();
	let consecutiveRefreshFailures = 0;
	const sessionsNeedingAttention = new Set(); // sessionIds with pending asks/notifications
	const previouslyStreaming = new Set(); // sessionIds that were streaming last poll
	let attentionPollTimer = null;
	let sessionLaunchInProgress = false;

	function isSessionLaunchInProgress() {
		return sessionLaunchInProgress;
	}

	function beginSessionLaunch() {
		if (sessionLaunchInProgress) return false;
		sessionLaunchInProgress = true;
		return true;
	}

	function endSessionLaunch() {
		sessionLaunchInProgress = false;
	}

	function resetDeleteButton(button) {
		if (!button) return;
		button.disabled = false;
		button.classList.remove("si-del-sure", "si-del-busy");
		button.textContent = "✕";
	}

	function armDeleteButton(button) {
		if (activeDeleteTimer) {
			clearTimeout(activeDeleteTimer);
			activeDeleteTimer = null;
		}
		if (activeDeleteButton && activeDeleteButton !== button) {
			resetDeleteButton(activeDeleteButton);
		}
		activeDeleteButton = button;
		button.classList.remove("si-del-busy");
		button.classList.add("si-del-sure");
		button.textContent = "Sure?";
		activeDeleteTimer = setTimeout(() => {
			if (activeDeleteButton === button) activeDeleteButton = null;
			resetDeleteButton(button);
			activeDeleteTimer = null;
		}, 2500);
	}

	async function renameSessionRow(session) {
		if (typeof onRenameSession !== "function") return;
		const currentLabel = (typeof session?.name === "string" && session.name.trim())
			|| (typeof session?.firstMessage === "string" && session.firstMessage.trim())
			|| "";
		const next = window.prompt("Rename session", currentLabel);
		if (next === null) return;
		const trimmed = next.trim();
		if (!trimmed) {
			onNotice("Session name cannot be empty", "error");
			return;
		}
		try {
			await onRenameSession(session, trimmed);
			await refresh({ force: true });
		} catch (err) {
			onNotice(err instanceof Error ? err.message : String(err), "error");
		}
	}

	async function deleteSessionRow(session, button, row) {
		if (activeDeleteTimer) {
			clearTimeout(activeDeleteTimer);
			activeDeleteTimer = null;
		}
		activeDeleteButton = button;

		// Extra warning for worktree sessions with uncommitted/unmerged work
		if (isWorktreePath(session.cwd)) {
			const wtName = extractWorktreeName(session.cwd) || session.cwd;
			const msg = `Delete worktree "${wtName}"?\n\nThis will remove the git worktree, its branch, and all uncommitted changes. Unmerged commits will be lost.\n\nAre you sure?`;
			if (!window.confirm(msg)) {
				if (activeDeleteButton === button) activeDeleteButton = null;
				resetDeleteButton(button);
				return;
			}
		}

		if (row) row.remove();
		try {
			if (session.isRunning) {
				await api.postJson(`/api/sessions/${encodeURIComponent(session.id)}/stop`, {});
			}
			if (session.path) {
				const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/delete?path=${encodeURIComponent(session.path)}`, {
					method: "DELETE",
					headers: api.headers(),
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) {
					throw new Error(body.error || `${res.status} ${res.statusText}`);
				}
			}
			// If this is a worktree session, also delete the git worktree + branch
			if (isWorktreePath(session.cwd)) {
				try {
					await fetch(`/api/worktree?path=${encodeURIComponent(session.cwd)}`, { method: "DELETE", headers: api.headers() });
				} catch { /* best effort */ }
			}
			if (session.id === getActiveSessionId()) {
				onSelectSession(null);
			}
			await refresh();
		} catch (err) {
			await refresh({ force: true });
			onNotice(err instanceof Error ? err.message : String(err), "error");
			return;
		} finally {
			if (activeDeleteButton === button) activeDeleteButton = null;
		}
	}

	function setOpen(open) {
		if (!sidebar) return;
		isOpen = Boolean(open);
		sidebar.classList.toggle("open", isOpen);
		if (sidebarOverlay) sidebarOverlay.classList.toggle("open", isOpen);
		document.body?.classList?.toggle("sidebar-open", isOpen);
		// Reset picker state when closing so the sidebar always reopens to the session list
		if (!open && viewMode === "picker") {
			viewMode = "sessions";
			if (sidebarLabel) sidebarLabel.textContent = "Sessions";
			void refresh({ force: true });
		}
	}

	function toggleOpen() { setOpen(!isOpen); }

	function highlightSessionRow(sessionId) {
		sessionsList.querySelectorAll(".si").forEach((row) => {
			row.classList.toggle("active", row.dataset.sessionId === sessionId);
		});
	}

	function extractWorktreeName(cwd) {
		const match = String(cwd || "").match(/\/\.worktrees\/worktree-([^/]+)(?:\/merged)?$/);
		return match ? match[1] : null;
	}

	function renderSessionRow(s) {
		const isWt = isWorktreePath(s.cwd);
		const wtName = isWt ? extractWorktreeName(s.cwd) : null;

		const row = document.createElement("div");
		row.className = `si${isWt ? " si-wt" : ""}${s.id === getActiveSessionId() ? " active" : ""}`;
		row.dataset.sessionId = s.id;

		const sessionLabel = (typeof s.name === "string" && s.name.trim())
			|| (typeof s.firstMessage === "string" && s.firstMessage.trim())
			|| s.id.slice(0, 8);
		const label = isWt
			? `\ud83c\udf3f ${wtName || sessionLabel}`
			: String(sessionLabel).replace(/\s+/g, " ").trim().slice(0, 60);

		const rel = formatRelativeTime(s.modified);
		const needsAttention = sessionsNeedingAttention.has(s.id);

		const name = document.createElement("div");
		name.className = "si-name";
		name.textContent = label;
		if (needsAttention) {
			const attention = document.createElement("span");
			attention.className = "si-attention";
			attention.textContent = "🔔";
			name.appendChild(attention);
		}
		name.title = isWt
			? `${wtName} \u2014 ${String(sessionLabel).slice(0, 60)}${s.startAgent ? ` \u2014 ${s.startAgent}` : ""}`
			: `${label}${s.startAgent ? ` \u2014 ${s.startAgent}` : ""}`;

		const meta = document.createElement("div");
		meta.className = "si-meta";
		meta.textContent = s.archived ? `${rel} • archived` : rel;
		if (s.isRunning) {
			const running = document.createElement("span");
			running.className = "si-run";
			running.textContent = " • running";
			meta.appendChild(running);
		}
		if (s.startAgent) {
			const agent = document.createElement("span");
			agent.className = "si-agent";
			agent.textContent = ` • ${s.startAgent}`;
			meta.appendChild(agent);
		}

		row.appendChild(name);
		row.appendChild(meta);

		// Desktop: ⋯ button visible on hover
		const moreBtn = document.createElement("button");
		moreBtn.className = "si-more";
		moreBtn.type = "button";
		moreBtn.textContent = "\u2022\u2022";
		moreBtn.title = "Actions";
		moreBtn.addEventListener("click", (e) => { e.stopPropagation(); showSessionActions(s, row); });
		row.appendChild(moreBtn);

		row.addEventListener("click", async () => {
			highlightSessionRow(s.id);
			try {
				await onSelectSession(s);
			} catch (err) {
				onNotice(err instanceof Error ? err.message : String(err), "error");
				highlightSessionRow(null);
			}
			if (window.matchMedia("(hover: none) and (pointer: coarse) and (max-width: 1024px)").matches) {
				setOpen(false);
			}
		});

		// Long-press or right-click for actions
		let lpTimer = null;
		row.addEventListener("pointerdown", () => {
			lpTimer = setTimeout(() => { lpTimer = null; showSessionActions(s, row); }, 500);
		});
		row.addEventListener("pointerup", () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
		row.addEventListener("pointercancel", () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
		row.addEventListener("pointermove", (e) => { if (lpTimer && (Math.abs(e.movementX) > 3 || Math.abs(e.movementY) > 3)) { clearTimeout(lpTimer); lpTimer = null; } });
		row.addEventListener("contextmenu", (e) => { e.preventDefault(); showSessionActions(s, row); });

		return row;
	}

	function sessionRowRenderKey(s) {
		return [
			s?.id || "",
			s?.name || "",
			s?.firstMessage || "",
			s?.cwd || "",
			s?.modified || "",
			s?.archived ? "1" : "0",
			s?.isRunning ? "1" : "0",
			s?.startAgent || "",
			s?.id === getActiveSessionId() ? "1" : "0",
			sessionsNeedingAttention.has(s?.id) ? "1" : "0",
		].join("\u001f");
	}

	function captureExpandedSessionRows() {
		const expanded = new Set();
		sessionsList.querySelectorAll("[data-session-id]").forEach((row) => {
			if (row.getAttribute("aria-expanded") === "true" || row.classList.contains("expanded")) {
				expanded.add(row.dataset.sessionId);
			}
		});
		return expanded;
	}

	function restoreExpandedSessionRow(row, expandedSessionIds) {
		if (!row?.dataset?.sessionId || !expandedSessionIds.has(row.dataset.sessionId)) return;
		row.classList.add("expanded");
		row.setAttribute("aria-expanded", "true");
	}

	function makeReusableSessionRowRenderer(existingRowsById, expandedSessionIds) {
		return (session) => {
			const key = sessionRowRenderKey(session);
			const existing = existingRowsById.get(session.id);
			if (existing?.dataset?.renderKey === key) {
				restoreExpandedSessionRow(existing, expandedSessionIds);
				return existing;
			}
			const row = renderSessionRow(session);
			row.dataset.renderKey = key;
			restoreExpandedSessionRow(row, expandedSessionIds);
			return row;
		};
	}

	function reconcileSessionList(nextChildren) {
		let index = 0;
		for (const child of nextChildren) {
			const current = sessionsList.children[index];
			if (current !== child) sessionsList.insertBefore(child, current || null);
			index += 1;
		}
		while (sessionsList.children.length > index) {
			sessionsList.removeChild(sessionsList.lastElementChild);
		}
	}


	function sessionModifiedTime(session) {
		const time = Date.parse(session?.modified);
		return Number.isFinite(time) ? time : 0;
	}

	function sortSessionsByModifiedDesc(sessions) {
		sessions.sort((a, b) => sessionModifiedTime(b) - sessionModifiedTime(a));
		return sessions;
	}

	function latestGroupModified(sessions) {
		let latest = 0;
		for (const session of sessions) latest = Math.max(latest, sessionModifiedTime(session));
		return latest;
	}

	function sortGroupKeysByLatest(groups) {
		return [...groups.keys()].sort((a, b) => {
			const modifiedDelta = latestGroupModified(groups.get(b)) - latestGroupModified(groups.get(a));
			return modifiedDelta || shortPath(a).localeCompare(shortPath(b));
		});
	}

	function appendSessionGroup({ key, label, sessions, addTitle, onAdd, container = sessionsList, renderRow = renderSessionRow }) {
		const collapsed = collapsedSessionGroups.has(key);
		const hdrWrap = document.createElement("div");
		hdrWrap.className = `sidebar-group-hdr-wrap${collapsed ? " collapsed" : ""}`;
		const hdr = document.createElement("button");
		hdr.className = "sidebar-group-hdr";
		hdr.style.cssText = "background:transparent;border:0;text-align:left;font:inherit;cursor:pointer;";
		hdr.type = "button";
		hdr.textContent = `${collapsed ? "▸" : "▾"} ${label}`;
		hdr.title = label;
		hdr.setAttribute("aria-expanded", collapsed ? "false" : "true");
		hdr.addEventListener("click", () => {
			if (collapsedSessionGroups.has(key)) collapsedSessionGroups.delete(key);
			else collapsedSessionGroups.add(key);
			renderSessionList(lastFetchedSessions);
		});
		hdrWrap.appendChild(hdr);
		const addBtn = document.createElement("button");
		addBtn.className = "sidebar-group-add";
		addBtn.textContent = "+";
		addBtn.title = addTitle;
		addBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			onAdd();
		});
		hdrWrap.appendChild(addBtn);
		container.appendChild(hdrWrap);
		if (!collapsed) {
			const sorted = sortSessionsByModifiedDesc(sessions);
			const limit = 5;
			const showAll = expandedExtraGroups.has(key);
			const visibleSessions = showAll ? sorted : sorted.slice(0, limit);

			for (const session of visibleSessions) {
				container.appendChild(renderRow(session));
			}

			if (sorted.length > limit) {
				const expandRow = document.createElement("div");
				expandRow.className = "si-expand-row";
				const expandBtn = document.createElement("button");
				expandBtn.className = "si-expand-btn";
				const remaining = sorted.length - limit;
				expandBtn.textContent = showAll
					? `▴ Show less`
					: `▾ Show ${remaining} more session${remaining > 1 ? "s" : ""}`;
				expandBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					if (expandedExtraGroups.has(key)) {
						expandedExtraGroups.delete(key);
					} else {
						expandedExtraGroups.add(key);
					}
					renderSessionList(lastFetchedSessions);
				});
				expandRow.appendChild(expandBtn);
				container.appendChild(expandRow);
			}
		}
	}

	let activeSheetDismiss = null;
	function showSessionActions(s, row) {
		const isWt = isWorktreePath(s.cwd);
		const wtName = isWt ? extractWorktreeName(s.cwd) : null;

		const sheet = document.createElement("div");
		sheet.className = "si-actions-sheet";
		const makeBtn = (text, onClick, danger) => {
			const b = document.createElement("button");
			b.className = "si-action-btn" + (danger ? " danger" : "");
			b.textContent = text;
			b.addEventListener("click", (e) => { e.stopPropagation(); sheet.remove(); onClick(); });
			return b;
		};
		sheet.appendChild(makeBtn("Rename", () => void renameSessionRow(s)));
		sheet.appendChild(makeBtn(s.archived ? "Unarchive" : "Archive", async () => {
			try {
				await api.postJson(`/api/sessions/${encodeURIComponent(s.id)}/archive`, { archived: !s.archived });
				void refresh({ force: true });
			} catch (err) {
				onNotice(err instanceof Error ? err.message : String(err), "error");
			}
		}));
		if (isWt) {
			sheet.appendChild(makeBtn("Merge", async () => {
				if (!window.confirm(`Merge "worktree-${wtName}" into current branch?`)) return;
				try {
					const result = await api.postJson("/api/worktree/merge", { worktreePath: s.cwd });
					onNotice(result.merged ? `\u2705 Merged. ${result.message}` : `\u274c ${result.message}`, result.merged ? "info" : "error");
					void refresh({ force: true });
				} catch (err) { onNotice(err instanceof Error ? err.message : String(err), "error"); }
			}));
		}
		sheet.appendChild(makeBtn(s.isRunning ? "Stop & Delete" : "Delete", () => {
			if (!window.confirm(`Delete "${s.name || s.id.slice(0, 8)}"?`)) return;
			void deleteSessionRow(s, null, row);
		}, true));
		row.after(sheet);
		// Dismiss previous sheet now that the new one is in the DOM
		if (activeSheetDismiss) { activeSheetDismiss(); activeSheetDismiss = null; }
		const dismiss = () => {
			sheet.remove();
			document.removeEventListener("pointerdown", onOutside);
			if (activeSheetDismiss === dismiss) activeSheetDismiss = null;
		};
		const onOutside = (e) => { if (!sheet.contains(e.target)) dismiss(); };
		activeSheetDismiss = dismiss;
		setTimeout(() => document.addEventListener("pointerdown", onOutside), 10);
	}

	function renderSessionList(sessions) {
		const scrollTop = sessionsList.scrollTop;
		const expandedSessionIds = captureExpandedSessionRows();
		const existingRowsById = new Map();
		sessionsList.querySelectorAll("[data-session-id]").forEach((row) => {
			if (row.dataset.sessionId) existingRowsById.set(row.dataset.sessionId, row);
		});
		const renderRow = makeReusableSessionRowRenderer(existingRowsById, expandedSessionIds);
		const nextChildren = [];
		const nextList = { appendChild: (child) => { nextChildren.push(child); return child; } };

		lastFetchedSessions = Array.isArray(sessions) ? sessions.slice() : [];
		const query = sessionSearchQuery.trim().toLowerCase();
		const allFiltered = (query
			? lastFetchedSessions.filter((s) => fuzzyMatchSession(query, buildSessionSearchHaystack(s, query)))
			: lastFetchedSessions.slice())
			.filter((s) => showArchivedSessions || !s.archived);

		const normalSessions = allFiltered.filter((s) => !isWorktreePath(s.cwd));
		const worktreeSessions = allFiltered.filter((s) => isWorktreePath(s.cwd));
		lastRenderedSessions = allFiltered.slice();
		consecutiveRefreshFailures = 0;

		// Keep the primary CTA focused on starting a session.
		const newRow = document.createElement("div");
		newRow.className = "si-new-row";
		const newBtn = document.createElement("button");
		newBtn.className = "si-new-btn";
		newBtn.textContent = "＋ Session";
		newBtn.addEventListener("click", () => void showNewSessionPicker());
		newRow.appendChild(newBtn);
		nextList.appendChild(newRow);

		const searchWrap = document.createElement("div");
		searchWrap.className = "sessions-search-wrap";
		const searchInput = document.createElement("input");
		searchInput.className = "sessions-search";
		searchInput.type = "search";
		searchInput.placeholder = "Search sessions…";
		searchInput.autocomplete = "off";
		searchInput.value = sessionSearchQuery;
		searchInput.addEventListener("input", () => {
			sessionSearchQuery = searchInput.value;
			renderSessionList(lastFetchedSessions);
			requestAnimationFrame(() => {
				const next = sessionsList.querySelector(".sessions-search");
				if (next) {
					next.focus();
					const end = next.value.length;
					next.setSelectionRange(end, end);
				}
			});
		});
		searchWrap.appendChild(searchInput);
		nextList.appendChild(searchWrap);

		const archiveWrap = document.createElement("label");
		archiveWrap.className = "sessions-archive-toggle";
		const archiveToggle = document.createElement("input");
		archiveToggle.type = "checkbox";
		archiveToggle.checked = showArchivedSessions;
		archiveToggle.addEventListener("change", () => {
			showArchivedSessions = archiveToggle.checked;
			renderSessionList(lastFetchedSessions);
		});
		archiveWrap.appendChild(archiveToggle);
		archiveWrap.appendChild(document.createTextNode(" Show archived sessions"));
		nextList.appendChild(archiveWrap);

		if (normalSessions.length === 0 && worktreeSessions.length === 0) {
			const empty = document.createElement("div");
			empty.className = "si";
			empty.innerHTML = `<div class="si-meta" style="padding:12px 0">${query ? "No matching sessions" : (showArchivedSessions ? "No sessions yet" : "No active sessions")}</div>`;
			nextList.appendChild(empty);
			reconcileSessionList(nextChildren);
			sessionsList.scrollTop = scrollTop;
			return;
		}

		// Group normal sessions by cwd
		if (normalSessions.length > 0) {
			const byDir = new Map();
			for (const s of normalSessions) {
				const dir = s.cwd || "unknown";
				if (!byDir.has(dir)) byDir.set(dir, []);
				byDir.get(dir).push(s);
			}

			const sortedDirs = sortGroupKeysByLatest(byDir);
			for (const dir of sortedDirs) {
				appendSessionGroup({
					key: `cwd:${dir}`,
					label: shortPath(dir),
					sessions: byDir.get(dir),
					addTitle: "New session in this folder",
					onAdd: () => void showNewSessionInFolder(dir),
					container: nextList,
					renderRow,
				});
			}
		}

		// Group worktree sessions by repo
		if (worktreeSessions.length > 0) {
			const sectionHdr = document.createElement("div");
			sectionHdr.className = "sidebar-section-hdr";
			sectionHdr.textContent = "Worktrees";
			nextList.appendChild(sectionHdr);

			const byRepo = new Map();
			for (const s of worktreeSessions) {
				const match = String(s.cwd || "").match(/^(.+)\/\.worktrees\//);
				const repoRoot = match ? match[1] : "unknown";
				if (!byRepo.has(repoRoot)) byRepo.set(repoRoot, []);
				byRepo.get(repoRoot).push(s);
			}

			const sortedRepos = sortGroupKeysByLatest(byRepo);
			for (const repoRoot of sortedRepos) {
				appendSessionGroup({
					key: `worktree:${repoRoot}`,
					label: shortPath(repoRoot),
					sessions: byRepo.get(repoRoot),
					addTitle: "New worktree session",
					onAdd: () => void showWorktreeForm(repoRoot),
					container: nextList,
					renderRow,
				});
			}
		}

		reconcileSessionList(nextChildren);
		sessionsList.scrollTop = scrollTop;
	}
	function restoreSessionsView() {
		viewMode = "sessions";
		if (sidebarLabel) sidebarLabel.textContent = "Sessions";
		void refresh({ force: true });
	}

	async function loadLaunchAgents() {
		try {
			const data = await api.getJson("/api/agents");
			return (Array.isArray(data?.agents) ? data.agents : [])
				.filter((agent) => agent && agent.scope === "user" && typeof agent.name === "string" && agent.name.trim())
				.map((agent) => ({ name: agent.name.trim(), description: typeof agent.description === "string" ? agent.description.trim() : "" }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return [];
		}
	}

	function addLaunchAgentField(container, state) {
		const label = document.createElement("label");
		label.className = "agent-launcher-label";
		label.textContent = "Start with agent (optional)";
		label.style.display = "none";
		const select = document.createElement("select");
		select.className = "sessions-search";
		const defaultOption = document.createElement("option");
		defaultOption.value = "";
		defaultOption.textContent = "Default agent";
		select.appendChild(defaultOption);
		select.addEventListener("change", () => {
			state.value = select.value.trim();
		});
		label.appendChild(select);
		container.appendChild(label);
		void loadLaunchAgents().then((agents) => {
			if (!Array.isArray(agents) || agents.length === 0) return;
			label.style.display = "flex";
			for (const agent of agents) {
				const option = document.createElement("option");
				option.value = agent.name;
				option.textContent = agent.description ? `${agent.name} — ${agent.description}` : agent.name;
				select.appendChild(option);
			}
			if (state.value && agents.some((agent) => agent.name === state.value)) {
				select.value = state.value;
			} else {
				state.value = "";
			}
		});
		return select;
	}


	async function showNewProjectDialog(options = {}) {
		const onBack = resolveProjectDialogBackHandler(options, restoreSessionsView);
		const launchAgent = { value: typeof options?.initialAgent === "string" ? options.initialAgent.trim() : "" };
		viewMode = "picker";
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "New Project";

		const backBtn = document.createElement("div");
		backBtn.className = "si si-new";
		backBtn.innerHTML = `<div class="si-name">← Back</div>`;
		backBtn.addEventListener("click", () => { onBack(); });
		sessionsList.appendChild(backBtn);

		const form = document.createElement("div");
		form.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:10px;";

		const label = document.createElement("label");
		label.className = "agent-launcher-label";
		label.textContent = "Project name";
		const input = document.createElement("input");
		input.className = "sessions-search";
		input.type = "text";
		input.placeholder = "my-new-project";
		label.appendChild(input);
		form.appendChild(label);
		addLaunchAgentField(form, launchAgent);

		const hint = document.createElement("div");
		hint.className = "si-meta new-session-empty";
		hint.style.cssText = "padding:0 12px;white-space:normal;word-wrap:break-word;";
		hint.textContent = "Creates /root/{your-path} and opens a session";
		form.appendChild(hint);

		const createBtn = document.createElement("button");
		createBtn.className = "new-btn";
		createBtn.style.cssText = "padding:10px 14px;font-weight:600;justify-content:center;";
		createBtn.textContent = "Create & Open Session";
		createBtn.addEventListener("click", async () => {
			if (isSessionLaunchInProgress()) return;
			const path = input.value.trim();
			if (!path) { onNotice("Project name cannot be empty", "error"); return; }
			if (path.startsWith("/") || path.includes("..") || path.startsWith("~")) {
				onNotice("Invalid path. Just type the folder name (e.g., 'myproject')", "error");
				return;
			}
			if (!beginSessionLaunch()) return;
			createBtn.disabled = true;
			createBtn.textContent = "Creating...";
			try {
				const result = await api.postJson("/api/dirs/create", { path });
				const cwd = result.path;
				// Start session in the new directory
				const sessionResult = await api.postJson("/api/sessions", { clientId, cwd, forceNew: true, startAgent: launchAgent.value });
				viewMode = "sessions";
				onSessionIdSelected(sessionResult.sessionId);
				setOpen(false);
				// Refresh sidebar to show the new session
				void refresh({ force: true });
			} catch (err) {
				createBtn.disabled = false;
				createBtn.textContent = "Create & Open Session";
				onNotice(err instanceof Error ? err.message : String(err), "error");
			} finally {
				endSessionLaunch();
			}
		});
		form.appendChild(createBtn);

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); createBtn.click(); }
		});

		sessionsList.appendChild(form);
		setTimeout(() => input.focus(), 0);
	}

	async function showNewSessionPicker(options = {}) {
		viewMode = "picker";
		let currentResults = [];
		let recentDirs = [];
		const launchAgent = { value: typeof options?.initialAgent === "string" ? options.initialAgent.trim() : "" };

		// Fetch recent/known repos in background (non-blocking)
		const reposPromise = api.getJson("/api/repos").then((data) => {
			recentDirs = Array.isArray(data.repos) ? data.repos : [];
			return recentDirs;
		}).catch(() => []);

		// Show inline picker replacing the session list
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "New Session";

		// Back button
		const backBtn = document.createElement("div");
		backBtn.className = "si si-new";
		backBtn.innerHTML = `<div class="si-name">← Back</div>`;
		backBtn.addEventListener("click", () => { restoreSessionsView(); });
		sessionsList.appendChild(backBtn);

		const projectBtn = document.createElement("div");
		projectBtn.className = "si si-new";
		projectBtn.innerHTML = `<div class="si-name">＋ New Project</div><div class="si-meta new-session-empty">Create a fresh folder under /root and open a session</div>`;
		projectBtn.addEventListener("click", () => void showNewProjectDialog({ onBack: () => void showNewSessionPicker({ initialAgent: launchAgent.value }), initialAgent: launchAgent.value }));
		sessionsList.appendChild(projectBtn);
		addLaunchAgentField(sessionsList, launchAgent);

		// Fuzzy search input
		const inputRow = document.createElement("div");
		inputRow.className = "sessions-search-wrap";
		const pathInput = document.createElement("input");
		pathInput.className = "sessions-search";
		pathInput.type = "text";
		pathInput.placeholder = "Type to search any folder on the server…";
		pathInput.autocomplete = "off";
		pathInput.spellcheck = false;

		// Container for folder results
		const resultsContainer = document.createElement("div");
		resultsContainer.id = "new-session-results";

		let searchTimer = null;
		let searchSeq = 0;
		let isSearching = false;

		const pathHasHiddenSegment = (dir) => String(dir || "")
			.split("/")
			.map((part) => String(part || "").trim())
			.filter(Boolean)
			.some((part) => part !== "." && part !== ".." && part !== "~" && part.startsWith(".") && part.length > 1);

		const filterVisibleDirs = (dirs, query) => {
			const allowHidden = String(query || "").includes(".");
			return (Array.isArray(dirs) ? dirs : []).filter((dir) => allowHidden || !pathHasHiddenSegment(dir));
		};

		const filterDirsLocally = (query, pool) => {
			const q = String(query || "").trim().toLowerCase();
			const visiblePool = filterVisibleDirs(pool, q);
			if (!q) return visiblePool.slice();
			const tokens = q.split(/[\s/_-]+/).filter(Boolean);
			return visiblePool
				.map((dir) => {
					const lower = String(dir || "").toLowerCase();
					const base = lower.split("/").pop() || lower;
					let score = 0;
					if (base === q) score += 2000;
					else if (base.startsWith(q)) score += 1200;
					else if (base.includes(q)) score += 900;
					else if (lower.includes(q)) score += 500;
					if (tokens.length > 1 && tokens.every((t) => lower.includes(t))) score += 400;
					if (score <= 0) {
						const compactQ = q.replace(/[^a-z0-9]+/g, "");
						const compactB = base.replace(/[^a-z0-9]+/g, "");
						if (compactQ && compactB.includes(compactQ)) score += 700;
					}
					return { dir, score };
				})
				.filter((entry) => entry.score > 0)
				.sort((a, b) => b.score - a.score)
				.map((entry) => entry.dir);
		};

		const renderFolderList = (dirs, emptyMessage, query = pathInput.value.trim()) => {
			const filteredDirs = filterVisibleDirs(dirs, query);
			currentResults = filteredDirs.slice();
			resultsContainer.innerHTML = "";
			if (filteredDirs.length === 0) {
				const hint = document.createElement("div");
				hint.className = "si";
				const meta = document.createElement("div");
				meta.className = "si-meta new-session-empty";
				meta.textContent = emptyMessage || (String(query || "").includes(".") ? "No matching folders." : "No matching non-hidden folders.");
				hint.appendChild(meta);
				resultsContainer.appendChild(hint);
				return;
			}
			for (const cwd of filteredDirs) {
				const row = document.createElement("div");
				row.className = "si";
				const name = document.createElement("div");
				name.className = "si-name";
				name.textContent = shortPath(cwd);
				name.title = cwd;
				row.appendChild(name);
				row.addEventListener("click", () => void startInDir(cwd, launchAgent.value));
				resultsContainer.appendChild(row);
			}
		};

		const showSearching = () => {
			if (!isSearching) return;
			const existing = resultsContainer.querySelector(".new-session-searching");
			if (existing) return;
			const hint = document.createElement("div");
			hint.className = "si new-session-searching";
			const meta = document.createElement("div");
			meta.className = "si-meta new-session-empty";
			meta.textContent = "Searching…";
			hint.appendChild(meta);
			resultsContainer.appendChild(hint);
		};

		const doRemoteSearch = async (val, seq) => {
			try {
				isSearching = true;
				if (currentResults.length === 0) showSearching();
				const data = await api.getJson(`/api/dirs/search?q=${encodeURIComponent(val)}`);
				if (seq !== searchSeq || pathInput.value.trim() !== val) return;
				const dirs = Array.isArray(data.dirs) ? data.dirs : [];
				isSearching = false;
				if (dirs.length > 0) {
					renderFolderList(dirs, undefined, val);
				} else if (currentResults.length === 0) {
					renderFolderList([], "No matching folders on this server.", val);
				}
			} catch {
				isSearching = false;
				if (seq !== searchSeq || pathInput.value.trim() !== val) return;
				if (currentResults.length === 0) {
					renderFolderList(filterDirsLocally(val, recentDirs), "No matching folders.");
				}
			}
		};

		pathInput.addEventListener("input", () => {
			const val = pathInput.value.trim();
			if (searchTimer) clearTimeout(searchTimer);
			if (!val) {
				if (recentDirs.length > 0) {
					renderFolderList(recentDirs, undefined, "");
				} else {
					renderFolderList([], "Type to search any folder on the server.", "");
				}
				return;
			}
			// Immediate local filter for snappy feedback
			const localHits = filterDirsLocally(val, recentDirs);
			if (localHits.length > 0) renderFolderList(localHits, undefined, val);
			else renderFolderList([], "Searching…", val);

			// Fire remote search quickly (150ms debounce)
			const seq = ++searchSeq;
			searchTimer = setTimeout(() => void doRemoteSearch(val, seq), 150);
		});

		pathInput.addEventListener("keydown", async (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const val = pathInput.value.trim();
			if (!val) {
				void startInDir("/root", launchAgent.value);
				return;
			}
			// Use first visible result if available
			if (currentResults.length > 0) {
				void startInDir(currentResults[0], launchAgent.value);
				return;
			}
			const looksLikePath = val.startsWith("/") || val.startsWith("~/") || val === "~" || val.startsWith("./") || val.startsWith("../");
			if (looksLikePath) {
				void startInDir(val, launchAgent.value);
				return;
			}
			// Last resort: fire a remote search and use first result
			try {
				const data = await api.getJson(`/api/dirs/search?q=${encodeURIComponent(val)}`);
				const dirs = filterVisibleDirs(Array.isArray(data.dirs) ? data.dirs : [], val);
				if (dirs[0]) {
					void startInDir(dirs[0], launchAgent.value);
					return;
				}
			} catch {
				// fall through to default cwd
			}
			void startInDir("/root", launchAgent.value);
		});
		inputRow.appendChild(pathInput);
		sessionsList.appendChild(inputRow);
		sessionsList.appendChild(resultsContainer);

		// Show initial state: loading recent dirs, then show them or hint
		renderFolderList([], "Loading…", "");
		reposPromise.then((repos) => {
			if (pathInput.value.trim()) return; // user already typing
			if (repos.length > 0) renderFolderList(repos, undefined, "");
			else renderFolderList([], "Type to search any folder on the server.", "");
		});
		setTimeout(() => pathInput.focus(), 0);
	}

	async function startInDir(cwd, launchAgent = "") {
		if (!beginSessionLaunch()) return;
		const trimmedCwd = cwd.trim();
		try {
			const gitCheck = await api.getJson(`/api/is-git-repo?path=${encodeURIComponent(trimmedCwd)}`);
			if (gitCheck?.isGitRepo) {
				endSessionLaunch();
				void showWorktreeChoice(trimmedCwd, launchAgent);
				return;
			}
			const result = await api.postJson("/api/sessions", { clientId, cwd: trimmedCwd, forceNew: Boolean(launchAgent), startAgent: launchAgent });
			viewMode = "sessions";
			onSessionIdSelected(result.sessionId);
			setOpen(false);
			// Refresh sidebar to show the new session
			void refresh({ force: true });
		} catch (err) {
			viewMode = "picker";
			onNotice(err instanceof Error ? err.message : String(err), "error");
		} finally {
			if (isSessionLaunchInProgress()) endSessionLaunch();
		}
	}

	async function startNormalSession(cwd, launchAgent = "") {
		if (isSessionLaunchInProgress()) return;
		if (!beginSessionLaunch()) return;
		try {
			const result = await api.postJson("/api/sessions", { clientId, cwd: cwd.trim(), forceNew: true, startAgent: launchAgent });
			viewMode = "sessions";
			onSessionIdSelected(result.sessionId);
			setOpen(false);
			// Refresh sidebar to show the new session
			void refresh({ force: true });
		} catch (err) {
			viewMode = "picker";
			onNotice(err instanceof Error ? err.message : String(err), "error");
		} finally {
			endSessionLaunch();
		}
	}

	async function showNewSessionInFolder(cwd, launchAgent = "") {
		// Check if it's a git repo to offer worktree option
		try {
			const gitCheck = await api.getJson(`/api/is-git-repo?path=${encodeURIComponent(cwd)}`);
			if (gitCheck?.isGitRepo) {
				void showWorktreeChoice(cwd, launchAgent);
				return;
			}
		} catch { /* non-git, proceed with normal session */ }
		// Not a git repo, just create normal session
		void startNormalSession(cwd, launchAgent);
	}

	function showWorktreeChoice(cwd, launchAgent = "") {
		viewMode = "picker";
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "Session Type";

		const backBtn = document.createElement("div");
		backBtn.className = "si si-new";
		backBtn.innerHTML = `<div class="si-name">← Back</div>`;
		backBtn.addEventListener("click", () => void showNewSessionPicker({ initialAgent: launchAgent }));
		sessionsList.appendChild(backBtn);

		const info = document.createElement("div");
		info.className = "si";
		const infoMeta = document.createElement("div");
		infoMeta.className = "si-meta new-session-empty";
		infoMeta.textContent = `Git repo: ${shortPath(cwd)}`;
		info.appendChild(infoMeta);
		sessionsList.appendChild(info);

		const normalBtn = document.createElement("div");
		normalBtn.className = "si si-new";
		normalBtn.innerHTML = `<div class="si-name">Normal Session</div><div class="si-meta">Open directly in the repo root</div>`;
		normalBtn.addEventListener("click", () => void startNormalSession(cwd, launchAgent));
		sessionsList.appendChild(normalBtn);

		const wtBtn = document.createElement("div");
		wtBtn.className = "si si-new";
		wtBtn.innerHTML = `<div class="si-name">🌿 New Worktree</div><div class="si-meta">Independent branch + isolated copy</div>`;
		wtBtn.addEventListener("click", () => void showWorktreeForm(cwd, false, launchAgent));
		sessionsList.appendChild(wtBtn);
	}

	async function showWorktreeForm(cwd, skipBackButton = false, launchAgent = "") {
		viewMode = "picker";
		sessionsList.innerHTML = "";
		if (sidebarLabel) sidebarLabel.textContent = "New Worktree";

		if (!skipBackButton) {
			const backBtn = document.createElement("div");
			backBtn.className = "si si-new";
			backBtn.innerHTML = `<div class="si-name">← Back</div>`;
			backBtn.addEventListener("click", () => void showWorktreeChoice(cwd, launchAgent));
			sessionsList.appendChild(backBtn);
		}

		const form = document.createElement("div");
		form.style.cssText = "padding:8px 12px;display:flex;flex-direction:column;gap:10px;";

		const nameLabel = document.createElement("label");
		nameLabel.className = "agent-launcher-label";
		nameLabel.textContent = "Worktree name";
		const nameInput = document.createElement("input");
		nameInput.className = "sessions-search";
		nameInput.type = "text";
		nameInput.placeholder = "e.g. fix-auth";
		nameInput.value = `wt-${Date.now().toString(36)}`;
		nameLabel.appendChild(nameInput);
		form.appendChild(nameLabel);

		const branchLabel = document.createElement("label");
		branchLabel.className = "agent-launcher-label";
		branchLabel.textContent = "Base branch";
		const branchSelect = document.createElement("select");
		branchSelect.className = "sessions-search";
		const headOption = document.createElement("option");
		headOption.value = "HEAD";
		headOption.textContent = "HEAD (current)";
		branchSelect.appendChild(headOption);
		branchLabel.appendChild(branchSelect);
		form.appendChild(branchLabel);

		// Load branches async
		api.getJson(`/api/worktree/branches?repo=${encodeURIComponent(cwd)}`).then((data) => {
			const branches = Array.isArray(data?.branches) ? data.branches : [];
			for (const branch of branches) {
				const opt = document.createElement("option");
				opt.value = branch;
				opt.textContent = branch;
				branchSelect.appendChild(opt);
			}
		}).catch(() => {});

		const createBtn = document.createElement("button");
		createBtn.className = "new-btn";
		createBtn.style.cssText = "padding:10px 14px;font-weight:600;justify-content:center;";
		createBtn.textContent = "Create Worktree";
		createBtn.addEventListener("click", async () => {
			if (isSessionLaunchInProgress()) return;
			const name = nameInput.value.trim();
			if (!name) { onNotice("Name cannot be empty", "error"); return; }
			if (!beginSessionLaunch()) return;
			createBtn.disabled = true;
			createBtn.textContent = "Creating…";
			try {
				const result = await api.postJson("/api/worktree/create", {
					repoPath: cwd,
					name,
					baseBranch: branchSelect.value === "HEAD" ? undefined : branchSelect.value,
					clientId,
					startAgent: launchAgent,
				});
				viewMode = "sessions";
				onSessionIdSelected(result.sessionId);
				setOpen(false);
				// Refresh sidebar to show the new session
				void refresh({ force: true });
			} catch (err) {
				createBtn.disabled = false;
				createBtn.textContent = "Create Worktree";
				onNotice(err instanceof Error ? err.message : String(err), "error");
			} finally {
				endSessionLaunch();
			}
		});
		form.appendChild(createBtn);

		nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); createBtn.click(); }
		});

		sessionsList.appendChild(form);
		setTimeout(() => {
			nameInput.focus();
			nameInput.select();
		}, 0);
	}


	async function refresh(options = {}) {
		if (viewMode === "picker" && !options.force) return;
		viewMode = "sessions";
		if (sidebarLabel) sidebarLabel.textContent = "Sessions";
		try {
			const [activeData, allData] = await Promise.all([
				api.getJson("/api/active-sessions"),
				api.getJson("/api/sessions"),
			]);
			const active = Array.isArray(activeData.sessions) ? activeData.sessions : [];
			const all = Array.isArray(allData.sessions) ? allData.sessions : [];

			// Detect sessions that stopped streaming → mark as needing attention
			const currentlyStreaming = new Set();
			const activeSessionId = getActiveSessionId();
			for (const s of active) {
				if (s.isStreaming) currentlyStreaming.add(s.id);
				else if (previouslyStreaming.has(s.id) && s.id !== activeSessionId) {
					sessionsNeedingAttention.add(s.id);
				}
			}
			previouslyStreaming.clear();
			for (const id of currentlyStreaming) previouslyStreaming.add(id);

			const seen = new Set();
			const merged = [];
			for (const s of active) {
				if (!shouldShowSession(s)) continue;
				seen.add(s.id);
				merged.push(s);
			}
			for (const s of all) {
				if (seen.has(s.id)) continue;
				if (!shouldShowSession(s)) continue;
				merged.push(s);
			}

			merged.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));

			renderSessionList(merged);
		} catch (error) {
			consecutiveRefreshFailures += 1;
			if (lastRenderedSessions.length > 0 && consecutiveRefreshFailures < 3) {
				// Keep the existing list during transient fetch failures instead of replacing it
				// with a scary error state. This makes stale "running" entries much less disruptive.
				return;
			}
			sessionsList.innerHTML = "";
			const row = document.createElement("div");
			row.className = "si";
			row.innerHTML = `<div class="si-meta">Failed to load: ${error instanceof Error ? error.message : String(error)}</div>`;
			sessionsList.appendChild(row);
		}
	}

	// Hide header buttons — replaced by inline session creation controls
	if (btnSidebarLeft) btnSidebarLeft.style.display = "none";
	if (btnSidebarRight) btnSidebarRight.style.display = "none";

	// Poll for session state changes (streaming → done) every 5s
	attentionPollTimer = setInterval(() => {
		if (document.hidden || viewMode !== "sessions") return;
		void refresh();
	}, 5_000);

	return {
		setOpen,
		toggleOpen,
		refresh,
		highlightSessionRow,
		isOpen: () => isOpen,
		isPickerOpen: () => viewMode === "picker",
		setMode: () => {}, // compat
		updateHeader: () => {}, // compat
		markNeedsAttention: (sessionId) => {
			if (sessionId && !sessionsNeedingAttention.has(sessionId)) {
				sessionsNeedingAttention.add(sessionId);
				void refresh({ force: true });
			}
		},
		clearAttention: (sessionId) => {
			if (sessionId && sessionsNeedingAttention.has(sessionId)) {
				sessionsNeedingAttention.delete(sessionId);
				void refresh({ force: true });
			}
		},
		clearAllAttention: () => {
			if (sessionsNeedingAttention.size > 0) {
				sessionsNeedingAttention.clear();
				void refresh({ force: true });
			}
		},
	};
}

export const __test = {
	resolveProjectDialogBackHandler,
};
