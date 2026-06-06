function fuzzyMatch(query, text) {
	const q = String(query || "").trim().toLowerCase();
	if (!q) return true;
	const hay = String(text || "").toLowerCase();
	return q.split(/\s+/).filter(Boolean).every((part) => hay.includes(part));
}

function formatTime(value) {
	const ms = Date.parse(String(value || ""));
	if (!Number.isFinite(ms)) return "";
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

function choiceButton(label, active, onClick) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = `menu-mini agent-launcher-tab${active ? " active" : ""}`;
	btn.textContent = label;
	btn.addEventListener("click", onClick);
	return btn;
}

function toTimestamp(value) {
	const ms = Date.parse(String(value || ""));
	return Number.isFinite(ms) ? ms : 0;
}

function buildTreeIndex(entries) {
	const childCountById = new Map();
	const leafIds = new Set();
	for (const entry of entries || []) {
		const id = typeof entry?.id === "string" ? entry.id : "";
		if (id) leafIds.add(id);
	}
	for (const entry of entries || []) {
		const parentId = typeof entry?.parentId === "string" ? entry.parentId : "";
		if (!parentId) continue;
		childCountById.set(parentId, (childCountById.get(parentId) || 0) + 1);
		leafIds.delete(parentId);
	}
	return { childCountById, leafIds };
}

function getChildCount(index, entryOrId) {
	const id = typeof entryOrId === "string" ? entryOrId : entryOrId?.id;
	if (!id) return 0;
	return index.childCountById.get(id) || 0;
}

function isLeafEntry(index, entryOrId) {
	const id = typeof entryOrId === "string" ? entryOrId : entryOrId?.id;
	if (!id) return false;
	return index.leafIds.has(id);
}

function isBranchPoint(index, entry) {
	return getChildCount(index, entry) > 1;
}

function buildEntrySearchText(entry, index) {
	const parts = [entry?.title, entry?.preview, entry?.label];
	if (entry?.isActiveLeaf) parts.push("current leaf current");
	else if (entry?.isActivePath) parts.push("active path");
	if (isBranchPoint(index, entry)) parts.push("branch bifurcation split checkpoint");
	if (isLeafEntry(index, entry)) parts.push(entry?.isActivePath ? "tip latest leaf" : "tip forward future other branch checkpoint");
	return parts.filter(Boolean).join(" ");
}

function scoreEntry(entry, index, mode, view) {
	let score = 0;
	const branch = isBranchPoint(index, entry);
	const leaf = isLeafEntry(index, entry);
	if (mode === "tree" && view === "jump") {
		if (branch && entry?.isActivePath) score += 1200;
		else if (leaf && !entry?.isActivePath) score += 1120;
		else if (branch) score += 900;
		else if (leaf) score += 760;
		if (entry?.label) score += 650;
		if (entry?.isActiveLeaf) score += 520;
		else if (entry?.isActivePath) score += 280;
		if (entry?.isUserMessage) score += 60;
		return score;
	}
	if (entry?.isActiveLeaf) score += 400;
	else if (entry?.isActivePath) score += 180;
	if (leaf) score += 140;
	if (branch) score += 120;
	if (entry?.label) score += 80;
	if (entry?.isUserMessage) score += 20;
	return score;
}

function scoreSearchEntry(entry, index, query) {
	const q = String(query || "").trim().toLowerCase();
	const text = buildEntrySearchText(entry, index).toLowerCase();
	const title = String(entry?.title || "").toLowerCase();
	const preview = String(entry?.preview || "").toLowerCase();
	let score = scoreEntry(entry, index, "tree", "jump");
	if (!q) return score;
	if (title === q) score += 1400;
	else if (title.startsWith(q)) score += 900;
	else if (title.includes(q)) score += 650;
	if (preview.startsWith(q)) score += 420;
	else if (preview.includes(q)) score += 250;
	if (text.includes(q)) score += 120;
	return score;
}

function sortEntries(entries, index, mode, view, query = "") {
	const items = [...entries];
	if (view === "all" || view === "user" || view === "fork") {
		return items.sort((a, b) => toTimestamp(b?.timestamp) - toTimestamp(a?.timestamp));
	}
	if (view === "search") {
		return items.sort((a, b) => {
			const scoreDiff = scoreSearchEntry(b, index, query) - scoreSearchEntry(a, index, query);
			if (scoreDiff !== 0) return scoreDiff;
			return toTimestamp(b?.timestamp) - toTimestamp(a?.timestamp);
		});
	}
	return items.sort((a, b) => {
		const scoreDiff = scoreEntry(b, index, mode, view) - scoreEntry(a, index, mode, view);
		if (scoreDiff !== 0) return scoreDiff;
		return toTimestamp(b?.timestamp) - toTimestamp(a?.timestamp);
	});
}

function buildJumpEntries(entries, index) {
	const jumpable = (entries || []).filter((entry) =>
		isBranchPoint(index, entry)
		|| isLeafEntry(index, entry)
		|| entry?.label
		|| entry?.isActiveLeaf
		|| (entry?.isActivePath && entry?.isUserMessage)
	);
	return sortEntries(jumpable, index, "tree", "jump");
}

function getVisibleEntries(entries, index, state, mode) {
	const query = String(state?.query || "").trim();
	const searchPool = (mode === "fork"
		? (entries || []).filter((entry) => entry?.canFork)
		: entries || []
	).filter((entry) => fuzzyMatch(query, buildEntrySearchText(entry, index)));
	if (query) {
		return sortEntries(searchPool, index, mode, "search", query);
	}
	if (mode === "fork") {
		return sortEntries((entries || []).filter((entry) => entry?.canFork), index, mode, "fork");
	}
	if (state.view === "jump") {
		return buildJumpEntries(entries, index);
	}
	if (state.view === "user") {
		return sortEntries((entries || []).filter((entry) => entry?.isUserMessage), index, mode, "user");
	}
	return sortEntries(entries || [], index, mode, "all");
}

function chooseSelectedId(visibleEntries, currentSelectedId) {
	if (!Array.isArray(visibleEntries) || visibleEntries.length === 0) return "";
	return visibleEntries.some((entry) => entry?.id === currentSelectedId) ? currentSelectedId : visibleEntries[0]?.id || "";
}

function buildRowBadges(entry, index) {
	const badges = [];
	if (entry?.isActiveLeaf) badges.push({ text: "current", tone: "current" });
	else if (entry?.isActivePath) badges.push({ text: "active", tone: "active" });
	if (isLeafEntry(index, entry) && !entry?.isActiveLeaf) {
		badges.push({ text: entry?.isActivePath ? "tip" : "branch tip", tone: "tip" });
	}
	if (isBranchPoint(index, entry)) {
		const count = getChildCount(index, entry);
		badges.push({ text: count === 2 ? "bifurcation" : `${count} branches`, tone: "branch" });
	}
	if (entry?.label) badges.push({ text: entry.label, tone: "label" });
	if (entry?.isUserMessage) badges.push({ text: "user", tone: "user" });
	return badges;
}

function buildMetaLine(entry, index) {
	const parts = [];
	const time = formatTime(entry?.timestamp);
	if (time) parts.push(time);
	if (isBranchPoint(index, entry) && !entry?.isActiveLeaf) {
		parts.push(entry?.isActivePath ? "branch point on current path" : "branch point");
	}
	if (isLeafEntry(index, entry) && !entry?.isActiveLeaf) {
		parts.push(entry?.isActivePath ? "latest point on this branch" : "latest point on another branch");
	}
	if (entry?.isActiveLeaf) parts.push("current position");
	else if (entry?.isActivePath) parts.push("on current path");
	else if (isLeafEntry(index, entry)) parts.push("good forward jump target");
	return parts.join(" · ");
}

function buildPreviewLine(entry) {
	if (!entry) return "";
	const preview = String(entry.preview || "").trim();
	return preview || entry.title || "entry";
}

function formatLoadError(error, mode) {
	const message = error instanceof Error ? error.message : String(error || "");
	if (message === "404 Not Found") {
		return `${mode === "fork" ? "Fork" : "Tree"} isn't available in the running server yet. Restart omp-mobile and try again.`;
	}
	return message || "Failed to load session history.";
}

export function createSessionBranchLauncher({ menuOverlay, menuPanel, api, getActiveSessionId, onNavigate, onFork, onNotice }) {
	let currentOwnerId = 0;

	function close(ownerId = currentOwnerId) {
		if (ownerId !== currentOwnerId) return;
		currentOwnerId = 0;
		if (menuOverlay) {
			menuOverlay.classList.remove("open");
			delete menuOverlay.dataset.locked;
			delete menuOverlay.dataset.kind;
		}
		if (menuPanel) {
			menuPanel.innerHTML = "";
			menuPanel.style.left = "";
			menuPanel.style.top = "";
			menuPanel.style.right = "";
			menuPanel.style.width = "";
			menuPanel.style.maxWidth = "";
			menuPanel.style.maxHeight = "";
			menuPanel.style.transform = "";
		}
	}

	async function show(mode, options = {}) {
		const ownerId = ++currentOwnerId;
		if (!menuOverlay || !menuPanel) return;
		const sessionId = typeof getActiveSessionId === "function" ? getActiveSessionId() : "";
		if (!sessionId) {
			if (typeof onNotice === "function") onNotice("Open a session first.", "warning");
			return;
		}

		menuOverlay.classList.add("open");
		menuOverlay.dataset.locked = "1";
		menuOverlay.dataset.kind = "branch-launcher";
		menuPanel.innerHTML = "";
		menuPanel.style.left = "50%";
		menuPanel.style.top = "50%";
		menuPanel.style.right = "auto";
		menuPanel.style.width = "min(860px, 96vw)";
		menuPanel.style.maxWidth = "min(860px, 96vw)";
		menuPanel.style.maxHeight = "min(88vh, 920px)";
		menuPanel.style.transform = "translate(-50%, -50%)";

		const wrap = document.createElement("div");
		wrap.className = "agent-launcher";

		const hdr = document.createElement("div");
		hdr.className = "menu-hdr";
		const title = document.createElement("div");
		title.className = "menu-title";
		title.textContent = mode === "fork" ? "Fork" : "Tree checkpoints";
		const closeBtn = document.createElement("button");
		closeBtn.className = "menu-mini";
		closeBtn.textContent = "Close";
		closeBtn.addEventListener("click", () => close(ownerId));
		hdr.appendChild(title);
		hdr.appendChild(closeBtn);
		wrap.appendChild(hdr);

		const body = document.createElement("div");
		body.className = "menu-body agent-launcher-body";
		wrap.appendChild(body);
		menuPanel.appendChild(wrap);

		const loading = document.createElement("div");
		loading.className = "agent-launcher-intro";
		loading.textContent = "Loading session history…";
		body.appendChild(loading);

		let treeData;
		try {
			treeData = await api.getJson(`/api/sessions/${encodeURIComponent(sessionId)}/tree`);
		} catch (error) {
			if (ownerId !== currentOwnerId || getActiveSessionId?.() !== sessionId) return;
			body.innerHTML = "";
			const err = document.createElement("div");
			err.className = "agent-launcher-intro";
			err.textContent = formatLoadError(error, mode);
			body.appendChild(err);
			return;
		}
		if (ownerId !== currentOwnerId || getActiveSessionId?.() !== sessionId) return;

		const entries = Array.isArray(treeData?.entries) ? treeData.entries : [];
		const treeIndex = buildTreeIndex(entries);
		const state = {
			query: String(options?.initialQuery || "").trim(),
			view: mode === "fork" ? "fork" : "jump",
			selectedId: "",
			summaryMode: "none",
			customInstructions: "",
			busy: false,
		};

		const intro = document.createElement("div");
		intro.className = "agent-launcher-intro";
		intro.textContent = mode === "fork"
			? "Pick a user message to fork from. This creates a new session right before that message so you can edit and resend it."
			: "Checkpoints keeps branch tips, labels, and split points visible so you can jump backward or forward without losing your place.";
		body.innerHTML = "";
		body.appendChild(intro);

		const controls = document.createElement("div");
		controls.className = "agent-launcher-steps";
		body.appendChild(controls);

		let renderViewTabs = null;
		let renderSummaryTabs = null;

		const searchWrap = document.createElement("div");
		searchWrap.className = "agent-launcher-step";
		const searchLabel = document.createElement("label");
		searchLabel.className = "agent-launcher-field";
		searchLabel.appendChild(Object.assign(document.createElement("span"), { className: "agent-launcher-label", textContent: "Search" }));
		const search = document.createElement("input");
		search.className = "menu-search";
		search.placeholder = mode === "fork" ? "Search user messages…" : "Search checkpoints or full history…";
		search.value = state.query;
		searchLabel.appendChild(search);
		searchWrap.appendChild(searchLabel);
		if (mode === "tree") {
			const viewTabs = document.createElement("div");
			viewTabs.className = "agent-launcher-tabs";
			renderViewTabs = () => {
				viewTabs.innerHTML = "";
				viewTabs.appendChild(choiceButton("Checkpoints", state.view === "jump", () => {
					state.view = "jump";
					state.selectedId = "";
					update();
				}));
				viewTabs.appendChild(choiceButton("User messages", state.view === "user", () => {
					state.view = "user";
					state.selectedId = "";
					update();
				}));
				viewTabs.appendChild(choiceButton("All entries", state.view === "all", () => {
					state.view = "all";
					state.selectedId = "";
					update();
				}));
			};
			renderViewTabs();
			searchWrap.appendChild(viewTabs);
		}
		controls.appendChild(searchWrap);

		const listStep = document.createElement("div");
		listStep.className = "agent-launcher-step";
		const listHdr = document.createElement("div");
		listHdr.className = "agent-launcher-step-hdr";
		const listTitle = Object.assign(document.createElement("div"), { className: "agent-launcher-step-title", textContent: mode === "fork" ? "Fork points" : "Checkpoints" });
		listHdr.appendChild(listTitle);
		const listMeta = document.createElement("div");
		listMeta.className = "agent-launcher-meta";
		listHdr.appendChild(listMeta);
		listStep.appendChild(listHdr);
		const list = document.createElement("div");
		list.className = "branch-launcher-list";
		listStep.appendChild(list);
		controls.appendChild(listStep);

		let customInstructions = null;
		if (mode === "tree") {
			const summaryWrap = document.createElement("div");
			summaryWrap.className = "agent-launcher-step";
			summaryWrap.appendChild(Object.assign(document.createElement("div"), { className: "agent-launcher-step-title", textContent: "When switching branches" }));
			const tabs = document.createElement("div");
			tabs.className = "agent-launcher-tabs";
			renderSummaryTabs = () => {
				tabs.innerHTML = "";
				tabs.appendChild(choiceButton("No summary", state.summaryMode === "none", () => {
					state.summaryMode = "none";
					update();
				}));
				tabs.appendChild(choiceButton("Summarize", state.summaryMode === "summary", () => {
					state.summaryMode = "summary";
					update();
				}));
				tabs.appendChild(choiceButton("Custom prompt", state.summaryMode === "custom", () => {
					state.summaryMode = "custom";
					update();
				}));
			};
			renderSummaryTabs();
			summaryWrap.appendChild(tabs);

			customInstructions = document.createElement("textarea");
			customInstructions.className = "agent-launcher-textarea";
			customInstructions.rows = 4;
			customInstructions.placeholder = "Focus on the important differences, files touched, and next steps.";
			customInstructions.value = state.customInstructions;
			summaryWrap.appendChild(customInstructions);
			controls.appendChild(summaryWrap);
		}

		const preview = document.createElement("div");
		preview.className = "agent-launcher-preview";
		body.appendChild(preview);

		const actions = document.createElement("div");
		actions.className = "agent-launcher-actions";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "menu-mini";
		cancel.textContent = "Cancel";
		cancel.addEventListener("click", () => close(ownerId));
		const run = document.createElement("button");
		run.type = "button";
		run.className = "menu-mini agent-launcher-run";
		run.textContent = mode === "fork" ? "Fork here" : "Jump here";
		actions.appendChild(cancel);
		actions.appendChild(run);
		body.appendChild(actions);

		function visibleEntries() {
			return getVisibleEntries(entries, treeIndex, state, mode);
		}

		function update() {
			if (typeof renderViewTabs === "function") renderViewTabs();
			if (typeof renderSummaryTabs === "function") renderSummaryTabs();
			if (customInstructions) {
				customInstructions.style.display = state.summaryMode === "custom" ? "block" : "none";
			}
			const query = String(state.query || "").trim();
			const visible = visibleEntries();
			state.selectedId = chooseSelectedId(visible, state.selectedId);
			const selected = visible.find((entry) => entry.id === state.selectedId) || null;

			list.innerHTML = "";
			listTitle.textContent = mode === "fork"
				? (query ? "Search results" : "Fork points")
				: query
					? "Search results"
					: state.view === "jump"
						? "Checkpoints"
						: state.view === "user"
							? "User messages"
							: "All entries";
			if (visible.length === 0) {
				listMeta.textContent = query ? "No matches" : "No results";
				const empty = document.createElement("div");
				empty.className = "agent-launcher-meta";
				empty.textContent = state.query
					? "No matching history entries."
					: mode === "fork"
						? "No user messages available to fork."
						: "This session has no checkpoints yet.";
				list.appendChild(empty);
			} else {
				listMeta.textContent = mode === "fork"
					? query
						? `${visible.length} matching fork points`
						: `${visible.length} possible fork points`
					: query
						? `${visible.length} matches · ${entries.length} total entries`
						: state.view === "jump"
							? `${visible.length} checkpoints · ${entries.length} total entries`
							: `${visible.length} ${state.view === "user" ? "messages" : "entries"}`;
				for (const entry of visible) {
					const item = document.createElement("button");
					item.type = "button";
					item.className = `menu-item branch-launcher-item${entry.id === state.selectedId ? " active" : ""}`;
					const primary = document.createElement("div");
					primary.className = "primary";
					primary.textContent = entry.title;
					item.appendChild(primary);

					const badges = buildRowBadges(entry, treeIndex);
					if (badges.length > 0) {
						const badgeWrap = document.createElement("div");
						badgeWrap.className = "branch-launcher-badges";
						for (const badge of badges) {
							const chip = document.createElement("span");
							chip.className = `branch-launcher-badge ${badge.tone}`;
							chip.textContent = badge.text;
							badgeWrap.appendChild(chip);
						}
						item.appendChild(badgeWrap);
					}

					const secondary = document.createElement("div");
					secondary.className = "secondary";
					secondary.textContent = buildPreviewLine(entry);
					item.appendChild(secondary);

					const metaLine = buildMetaLine(entry, treeIndex);
					if (metaLine) {
						const meta = document.createElement("div");
						meta.className = "branch-launcher-meta-line";
						meta.textContent = metaLine;
						item.appendChild(meta);
					}

					item.addEventListener("click", () => {
						state.selectedId = entry.id;
						update();
					});
					list.appendChild(item);
				}
			}

			if (!selected) {
				preview.textContent = mode === "fork" ? "Pick a user message to fork from." : "Pick a checkpoint to jump to.";
				run.disabled = true;
				return;
			}

			const branchCount = getChildCount(treeIndex, selected);
			const jumpHint = isBranchPoint(treeIndex, selected)
				? `This is a ${branchCount === 2 ? "bifurcation point" : `${branchCount}-way split`} and usually the best place to jump back to.`
				: isLeafEntry(treeIndex, selected) && !selected.isActivePath
					? "This is the latest point on another branch, so it's the easiest way to jump forward again."
					: selected.isActiveLeaf
						? "This is your current position."
						: selected.isActivePath
							? "This sits on the current path."
							: "This is an older checkpoint outside the current path.";
			const summaryText = mode === "tree"
				? state.summaryMode === "none"
					? "No branch summary"
					: state.summaryMode === "summary"
						? "Summarize the branch you leave behind"
						: `Custom summary prompt: ${state.customInstructions.trim() || "(not set yet)"}`
				: "omp-mobile creates a new session right before this user message and loads that message into the composer.";
			const actionText = mode === "fork"
				? "Forking starts a new session right before this user message so you can edit and resend it."
				: selected.isUserMessage
					? "Jumping here reopens this user message in the composer for editing."
					: isLeafEntry(treeIndex, selected) && !selected.isActivePath
						? "Jumping here restores that later branch tip so you can continue from there."
						: "Jumping here continues from this exact point with an empty composer.";
			preview.textContent = mode === "fork"
				? `Fork from: ${buildPreviewLine(selected)}\n${jumpHint}\n\n${actionText}`
				: `Jump to: ${buildPreviewLine(selected)}\n${jumpHint}\n\n${actionText}\n\n${summaryText}`;
			run.disabled = state.busy || !selected;
		}

		search.addEventListener("input", () => {
			state.query = search.value;
			update();
		});
		if (customInstructions) {
			customInstructions.addEventListener("input", () => {
				state.customInstructions = customInstructions.value;
				update();
			});
		}

		run.addEventListener("click", async () => {
			if (getActiveSessionId?.() !== sessionId) {
				if (typeof onNotice === "function") onNotice("The active session changed. Reopen the tree/fork picker.", "warning");
				close(ownerId);
				return;
			}
			const selected = visibleEntries().find((entry) => entry.id === state.selectedId);
			if (!selected || state.busy) return;
			state.busy = true;
			run.disabled = true;
			run.textContent = mode === "fork" ? "Forking…" : "Jumping…";
			try {
				if (mode === "fork") {
					const result = typeof onFork === "function" ? await onFork({ entryId: selected.id, entry: selected }) : null;
					if (ownerId !== currentOwnerId) return;
					if (result !== false) close(ownerId);
					return;
				}
				const result = typeof onNavigate === "function"
					? await onNavigate({
						targetId: selected.id,
						entry: selected,
						summarize: state.summaryMode !== "none",
						customInstructions: state.summaryMode === "custom" ? state.customInstructions : "",
						replaceInstructions: false,
					})
					: null;
				if (ownerId !== currentOwnerId) return;
				if (result !== false) close(ownerId);
			} catch (error) {
				if (ownerId === currentOwnerId && typeof onNotice === "function") onNotice(error instanceof Error ? error.message : String(error), "error");
			} finally {
				if (ownerId !== currentOwnerId) return;
				state.busy = false;
				run.textContent = mode === "fork" ? "Fork here" : "Jump here";
				update();
			}
		});

		update();
		setTimeout(() => search.focus(), 50);
	}

	return {
		close,
		showTree: (options) => show("tree", options),
		showFork: (options) => show("fork", options),
	};
}
