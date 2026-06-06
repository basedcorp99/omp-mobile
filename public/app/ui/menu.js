import {
    getDeliveryMode,
    getStreamingSendMode,
    setDeliveryMode,
    setStreamingSendMode,
} from "../core/storage.js";

function normalizeForSearch(text) {
    return String(text || "")
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "");
}

function fuzzyCharsMatch(query, hay) {
    const q = normalizeForSearch(query);
    const h = normalizeForSearch(hay);
    if (!q) return true;
    let qi = 0;
    for (let i = 0; i < h.length && qi < q.length; i += 1) {
        if (h[i] === q[qi]) qi += 1;
    }
    return qi === q.length;
}

function fuzzyMatch(query, hay) {
    const tokens = String(query || "")
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (tokens.length === 0) return true;
    const h = String(hay || "").toLowerCase();
    return tokens.every((t) => h.includes(t) || fuzzyCharsMatch(t, h));
}

export function getCommandMenuEntries(commands, options = {}) {
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const hasSession = Boolean(options?.hasSession);
    const isStreaming = Boolean(options?.isStreaming);
    const hasAnyMessages = messages.length > 0;
    const hasUserMessages = messages.some(
        (message) =>
            message && typeof message === "object" && message.role === "user",
    );
    const entries = [
        {
            key: "tree",
            title: "tree",
            description:
                "Browse checkpoints and jump backward or forward between branches",
            kind: "tree",
            disabled: !hasSession || !hasAnyMessages || isStreaming,
        },
        {
            key: "fork",
            title: "fork",
            description:
                "Create a new session right before an earlier user message",
            kind: "fork",
            disabled: !hasSession || !hasUserMessages || isStreaming,
        },
    ];
    const seen = new Set(entries.map((entry) => entry.key));
    for (const command of Array.isArray(commands) ? commands : []) {
        const rawName = String(command?.name || "").trim().replace(/^\/+/, "");
        if (!rawName) continue;
        const key = rawName.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
            key,
            title: rawName,
            description: String(command?.description || command?.source || "Command"),
            kind: "command",
            command: {
                ...command,
                name: rawName,
                executeImmediately:
                    command?.source === "prompt" || command?.source === "skill"
                        ? Boolean(command?.executeImmediately)
                        : command?.executeImmediately !== false,
            },
            disabled: !hasSession || isStreaming,
        });
    }
    return entries;
}

export async function handleCommandMenuAction({
    entry,
    state,
    onExecuteCommand,
    onInsertCommand,
    onNotice,
}) {
    if (!entry || entry.disabled) return { ok: false, reason: "disabled" };

    if (entry.kind === "tree") {
        return { ok: true, action: "tree" };
    }
    if (entry.kind === "fork") {
        return { ok: true, action: "fork" };
    }

    const cmd = entry.command;
    if (!cmd) return { ok: false, reason: "missing-command" };

    if (!cmd.executeImmediately) {
        if (typeof onInsertCommand === "function")
            onInsertCommand(`/${cmd.name} `);
        return { ok: true, action: "insert", command: cmd.name };
    }

    if (state.executingCommand) {
        return { ok: false, reason: "busy", command: state.executingCommand };
    }

    state.executingCommand = cmd.name;
    try {
        if (typeof onExecuteCommand === "function")
            await onExecuteCommand(`/${cmd.name}`);
        return { ok: true, action: "execute", command: cmd.name };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (typeof onNotice === "function") onNotice(message, "error");
        return { ok: false, reason: "error", message };
    } finally {
        state.executingCommand = null;
    }
}

export function createMenu({
    menuOverlay,
    menuScrim,
    menuPanel,
    btnModel,
    btnThinking,
    btnCommands,
    btnSettings,
    api,
    clientId,
    onNotice,
    getActiveSessionId,
    getActiveState,
    getPrefs,
    onToggleTheme,
    onToggleSendOnEnter,
    onAdjustFontScale,
    onToggleVoiceInputMode,
    onToggleVoiceTranscriptionMode,
    onTogglePush,
    onTestPush,
    onSetSteeringMode,
    onSetFollowUpMode,
    onInsertCommand,
    onExecuteCommand,
    onRunTree,
    onRunFork,
}) {
    let open = false;
    let cachedModels = null;
    let cachedModelsAtMs = 0;

    function close() {
        if (!menuOverlay || !menuPanel) return;
        open = false;
        menuOverlay.classList.remove("open");
        delete menuOverlay.dataset.locked;
        delete menuOverlay.dataset.kind;
        menuPanel.innerHTML = "";
        menuPanel.style.transform = "";
        menuPanel.style.left = "";
        menuPanel.style.top = "";
        menuPanel.style.right = "";
        menuPanel.style.width = "";
        menuPanel.style.maxWidth = "";
        menuPanel.style.maxHeight = "";
    }

    function position(_anchor) {
        if (!menuPanel) return;
        const isMobile = window.matchMedia(
            "(hover: none) and (pointer: coarse) and (max-width: 740px)",
        ).matches;
        if (isMobile) {
            // CSS bottom sheet handles layout
            return;
        }
        // Desktop/tablet: centered modal
        menuPanel.style.left = "50%";
        menuPanel.style.top = "50%";
        menuPanel.style.transform = "translate(-50%, -50%)";
        menuPanel.style.width = "min(480px, 92vw)";
        menuPanel.style.maxHeight = "min(70vh, 520px)";
    }

    function openMenu(anchor, build, kind) {
        if (!menuOverlay || !menuPanel) return;
        open = true;
        menuOverlay.classList.add("open");
        delete menuOverlay.dataset.locked;
        if (kind) menuOverlay.dataset.kind = kind;
        menuPanel.innerHTML = "";
        menuPanel.style.left = "0px";
        menuPanel.style.top = "0px";
        menuPanel.style.transform = "";
        menuPanel.style.width = "";
        menuPanel.style.maxWidth = "";
        menuPanel.style.maxHeight = "";
        build(menuPanel);
        position(anchor);
    }

    async function getAvailableModels() {
        if (cachedModels && Date.now() - cachedModelsAtMs < 30_000)
            return cachedModels;
        const data = await api.getJson("/api/models");
        const models = Array.isArray(data.models) ? data.models : [];
        cachedModels = models;
        cachedModelsAtMs = Date.now();
        return models;
    }

    async function setModel(provider, modelId) {
        const activeSessionId = getActiveSessionId();
        if (!activeSessionId) return;
        await api.postJson(
            `/api/sessions/${encodeURIComponent(activeSessionId)}/command`,
            {
                type: "set_model",
                clientId,
                provider,
                modelId,
            },
        );
    }

    async function setThinkingLevel(level) {
        const activeSessionId = getActiveSessionId();
        if (!activeSessionId) return;
        await api.postJson(
            `/api/sessions/${encodeURIComponent(activeSessionId)}/command`,
            {
                type: "set_thinking_level",
                clientId,
                level,
            },
        );
    }

    async function openModelMenu() {
        if (!btnModel || btnModel.disabled) return;
        openMenu(
            btnModel,
            (panel) => {
                const hdr = document.createElement("div");
                hdr.className = "menu-hdr";
                const title = document.createElement("div");
                title.className = "menu-title";
                title.textContent = "Model";
                const actions = document.createElement("div");
                actions.style.display = "flex";
                actions.style.gap = "6px";
                const refresh = document.createElement("button");
                refresh.className = "menu-mini";
                refresh.textContent = "Refresh";
                refresh.addEventListener("click", async () => {
                    cachedModels = null;
                    cachedModelsAtMs = 0;
                    await openModelMenu();
                });
                const closeBtn = document.createElement("button");
                closeBtn.className = "menu-mini";
                closeBtn.textContent = "Close";
                closeBtn.addEventListener("click", () => close());
                actions.appendChild(refresh);
                actions.appendChild(closeBtn);
                hdr.appendChild(title);
                hdr.appendChild(actions);

                const body = document.createElement("div");
                body.className = "menu-body";

                const search = document.createElement("input");
                search.className = "menu-search";
                search.placeholder = "Search model name…";

                const list = document.createElement("div");
                list.className = "menu-list";
                list.textContent = "Loading…";

                const render = (models, query) => {
                    list.innerHTML = "";
                    const activeState = getActiveState();
                    const currentKey = activeState?.model
                        ? `${activeState.model.provider}/${activeState.model.id}`
                        : null;
                    const filtered = models.filter((m) =>
                        fuzzyMatch(query, `${m.name || m.id}`),
                    );
                    const shown = filtered.slice(0, 200);
                    if (shown.length === 0) {
                        const empty = document.createElement("div");
                        empty.className = "si-meta";
                        empty.textContent = "No matches.";
                        list.appendChild(empty);
                        return;
                    }
                    for (const m of shown) {
                        const item = document.createElement("div");
                        item.className = "menu-item";
                        const key = `${m.provider}/${m.id}`;
                        if (currentKey && key === currentKey)
                            item.classList.add("active");

                        const primary = document.createElement("div");
                        primary.className = "primary";
                        primary.textContent = key;
                        const secondary = document.createElement("div");
                        secondary.className = "secondary";
                        secondary.textContent =
                            m.name || (m.reasoning ? "reasoning" : "");

                        item.appendChild(primary);
                        item.appendChild(secondary);
                        item.addEventListener("click", async () => {
                            try {
                                await setModel(m.provider, m.id);
                                close();
                            } catch (error) {
                                onNotice(
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                                    "error",
                                );
                            }
                        });
                        list.appendChild(item);
                    }
                };

                search.addEventListener("input", async () => {
                    try {
                        const models = await getAvailableModels();
                        render(models, search.value);
                    } catch (error) {
                        list.textContent =
                            error instanceof Error
                                ? error.message
                                : String(error);
                    }
                });

                body.appendChild(search);
                body.appendChild(list);

                panel.appendChild(hdr);
                panel.appendChild(body);

                (async () => {
                    try {
                        const models = await getAvailableModels();
                        render(models, "");
                        position(btnModel);
                        search.focus();
                    } catch (error) {
                        list.textContent =
                            error instanceof Error
                                ? error.message
                                : String(error);
                    }
                })();
            },
            "model",
        );
    }

    function openThinkingMenu() {
        if (!btnThinking || btnThinking.disabled) return;
        openMenu(
            btnThinking,
            (panel) => {
                const hdr = document.createElement("div");
                hdr.className = "menu-hdr";
                const title = document.createElement("div");
                title.className = "menu-title";
                title.textContent = "Thinking level";
                const closeBtn = document.createElement("button");
                closeBtn.className = "menu-mini";
                closeBtn.textContent = "Close";
                closeBtn.addEventListener("click", () => close());
                hdr.appendChild(title);
                hdr.appendChild(closeBtn);

                const body = document.createElement("div");
                body.className = "menu-body";

                const list = document.createElement("div");
                list.className = "menu-list";

                const activeState = getActiveState();
                const current = activeState?.thinkingLevel
                    ? String(activeState.thinkingLevel)
                    : "off";
                const levels = [
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                ];
                for (const level of levels) {
                    const item = document.createElement("div");
                    item.className = "menu-item";
                    if (level === current) item.classList.add("active");
                    const primary = document.createElement("div");
                    primary.className = "primary";
                    primary.textContent = level;
                    item.appendChild(primary);
                    item.addEventListener("click", async () => {
                        try {
                            await setThinkingLevel(level);
                            close();
                        } catch (error) {
                            onNotice(
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                                "error",
                            );
                        }
                    });
                    list.appendChild(item);
                }

                body.appendChild(list);
                panel.appendChild(hdr);
                panel.appendChild(body);
            },
            "thinking",
        );
    }

    function openCommandsMenu() {
        if (!btnCommands || btnCommands.disabled) return;
        const state = { executingCommand: null };
        openMenu(btnCommands, (panel) => {
            const hdr = document.createElement("div");
            hdr.className = "menu-hdr";
            const title = document.createElement("div");
            title.className = "menu-title";
            title.textContent = "/Cmd";
            const closeBtn = document.createElement("button");
            closeBtn.className = "menu-mini";
            closeBtn.textContent = "Close";
            closeBtn.addEventListener("click", () => close());
            hdr.appendChild(title);
            hdr.appendChild(closeBtn);

            const body = document.createElement("div");
            body.className = "menu-body";
            const list = document.createElement("div");
            list.className = "menu-list";

            const render = () => {
                list.innerHTML = "";
                const activeState = getActiveState();
                const commands = Array.isArray(activeState?.commands)
                    ? activeState.commands
                    : [];
                const entries = getCommandMenuEntries(commands, {
                    hasSession: Boolean(activeState?.sessionId),
                    isStreaming: Boolean(activeState?.isStreaming),
                    messages: activeState?.messages,
                });
                for (const entry of entries) {
                    const item = document.createElement("div");
                    item.className = `menu-item${entry.disabled ? " disabled" : ""}`;
                    if (
                        state.executingCommand &&
                        entry.kind === "command" &&
                        entry.command?.name === state.executingCommand
                    ) {
                        item.classList.add("active");
                    }
                    const primary = document.createElement("div");
                    primary.className = "primary";
                    primary.textContent =
                        state.executingCommand &&
                        entry.kind === "command" &&
                        entry.command?.name === state.executingCommand
                            ? `${entry.title}…`
                            : entry.title;
                    const secondary = document.createElement("div");
                    secondary.className = "secondary";
                    secondary.textContent = entry.disabled
                        ? "Unavailable"
                        : state.executingCommand &&
                            entry.kind === "command" &&
                            entry.command?.name === state.executingCommand
                          ? "Starting…"
                          : entry.description;
                    item.appendChild(primary);
                    item.appendChild(secondary);
                    item.addEventListener("click", async () => {
                        const result = await handleCommandMenuAction({
                            entry,
                            state,
                            onExecuteCommand,
                            onInsertCommand,
                            onNotice,
                        });
                        if (result.ok) {
                            close();
                            if (result.action === "tree") {
                                setTimeout(() => {
                                    if (typeof onRunTree === "function")
                                        onRunTree();
                                }, 0);
                                return;
                            }
                            if (result.action === "fork") {
                                setTimeout(() => {
                                    if (typeof onRunFork === "function")
                                        onRunFork();
                                }, 0);
                                return;
                            }
                        }
                        render();
                    });
                    list.appendChild(item);
                }
            };

            body.appendChild(list);
            panel.appendChild(hdr);
            panel.appendChild(body);
            render();
        });
    }

    function openSettingsMenu() {
        if (!btnSettings || !menuOverlay || !menuPanel) return;
        open = true;
        menuOverlay.classList.add("open");
        menuPanel.innerHTML = "";
        menuPanel.style.left = "50%";
        menuPanel.style.top = "56px";
        menuPanel.style.transform = "translateX(-50%)";
        menuPanel.style.width = "min(760px, 94vw)";
        menuPanel.style.maxWidth = "94vw";
        menuPanel.style.maxHeight = "calc(100vh - 72px)";

        const renderSettings = () => {
            menuPanel.innerHTML = "";
            const prefs =
                typeof getPrefs === "function"
                    ? getPrefs()
                    : {
                          theme: "dark",
                          sendOnEnter: true,
                          fontScale: 1,
                          voiceInputMode: "compose",
                          faceIdEnabled: false,
                          pushSupported: false,
                          pushSubscribed: false,
                          steeringMode: null,
                          followUpMode: null,
                          hasSessionControl: false,
                      };

            const hdr = document.createElement("div");
            hdr.className = "menu-hdr";
            const title = document.createElement("div");
            title.className = "menu-title";
            title.textContent = "Settings";
            const closeBtn = document.createElement("button");
            closeBtn.className = "menu-mini";
            closeBtn.textContent = "Close";
            closeBtn.addEventListener("click", () => close());
            hdr.appendChild(title);
            hdr.appendChild(closeBtn);

            const body = document.createElement("div");
            body.className = "menu-body";
            body.style.paddingBottom = "16px";

            const addSection = (label) => {
                const heading = document.createElement("div");
                heading.className = "sidebar-label";
                heading.style.margin = "10px 0 8px";
                heading.textContent = label;
                body.appendChild(heading);
            };

            const makeSetting = ({
                name,
                value,
                description,
                active,
                onClick,
            }) => {
                const item = document.createElement("div");
                item.className = `menu-item${active ? " active" : ""}`;
                const primary = document.createElement("div");
                primary.className = "primary";
                primary.textContent = `${name} · ${value}`;
                const secondary = document.createElement("div");
                secondary.className = "secondary";
                secondary.textContent = description;
                item.appendChild(primary);
                item.appendChild(secondary);
                if (typeof onClick === "function")
                    item.addEventListener("click", onClick);
                return item;
            };

            const makeStepperSetting = ({
                name,
                value,
                description,
                onMinus,
                onPlus,
                canMinus = true,
                canPlus = true,
            }) => {
                const item = document.createElement("div");
                item.className = "menu-item setting-stepper";
                const textWrap = document.createElement("div");
                textWrap.className = "setting-stepper-text";
                const primary = document.createElement("div");
                primary.className = "primary";
                primary.textContent = `${name} · ${value}`;
                const secondary = document.createElement("div");
                secondary.className = "secondary";
                secondary.textContent = description;
                textWrap.appendChild(primary);
                textWrap.appendChild(secondary);
                const controls = document.createElement("div");
                controls.className = "setting-stepper-controls";
                const minus = document.createElement("button");
                minus.className = "menu-mini setting-stepper-btn";
                minus.textContent = "−";
                minus.disabled = !canMinus;
                minus.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof onMinus === "function") onMinus();
                });
                const plus = document.createElement("button");
                plus.className = "menu-mini setting-stepper-btn";
                plus.textContent = "+";
                plus.disabled = !canPlus;
                plus.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof onPlus === "function") onPlus();
                });
                controls.appendChild(minus);
                controls.appendChild(plus);
                item.appendChild(textWrap);
                item.appendChild(controls);
                return item;
            };

            addSection("App");
            body.appendChild(
                makeSetting({
                    name: "Theme",
                    value: prefs.theme === "light" ? "light" : "dark",
                    description: "Toggle light/dark appearance.",
                    active: prefs.theme === "light",
                    onClick: () => {
                        if (typeof onToggleTheme === "function")
                            onToggleTheme();
                        renderSettings();
                    },
                }),
            );
            body.appendChild(
                makeSetting({
                    name: "Enter sends",
                    value: prefs.sendOnEnter ? "on" : "off",
                    description: prefs.sendOnEnter
                        ? "Enter sends, Shift+Enter makes a newline."
                        : "Enter makes a newline, Ctrl+Enter sends.",
                    active: prefs.sendOnEnter,
                    onClick: () => {
                        if (typeof onToggleSendOnEnter === "function")
                            onToggleSendOnEnter();
                        renderSettings();
                    },
                }),
            );
            body.appendChild(
                makeStepperSetting({
                    name: "Text size",
                    value: `${Math.round((Number(prefs.fontScale || 1) || 1) * 100)}%`,
                    description: "Use − / + to decrease or increase text size.",
                    canMinus: Number(prefs.fontScale || 1) > 0.85,
                    canPlus: Number(prefs.fontScale || 1) < 1.35,
                    onMinus: () => {
                        if (typeof onAdjustFontScale === "function")
                            onAdjustFontScale(-0.05);
                        renderSettings();
                    },
                    onPlus: () => {
                        if (typeof onAdjustFontScale === "function")
                            onAdjustFontScale(0.05);
                        renderSettings();
                    },
                }),
            );
            body.appendChild(
                makeSetting({
                    name: "Voice mode",
                    value:
                        prefs.voiceInputMode === "auto-send"
                            ? "auto-send"
                            : "compose",
                    description:
                        prefs.voiceInputMode === "auto-send"
                            ? "Record, transcribe, then auto-send the voice note with current images."
                            : "Record, transcribe into the composer, then review and send manually.",
                    active: prefs.voiceInputMode === "auto-send",
                    onClick: () => {
                        if (typeof onToggleVoiceInputMode === "function")
                            onToggleVoiceInputMode();
                        renderSettings();
                    },
                }),
            );
            const webSpeechSupported =
                typeof prefs.webSpeechSupported === "boolean"
                    ? prefs.webSpeechSupported
                    : false;
            body.appendChild(
                makeSetting({
                    name: "Transcription",
                    value:
                        prefs.voiceTranscriptionMode === "web-speech"
                            ? "web-speech (fast)"
                            : "chatgpt (accurate)",
                    description: webSpeechSupported
                        ? prefs.voiceTranscriptionMode === "web-speech"
                            ? "Browser-native speech recognition. Faster but less accurate, esp. for code."
                            : "ChatGPT transcription via Codex OAuth. Highly accurate, fast, and handles code perfectly."
                        : "ChatGPT (via Codex OAuth) - highly accurate. Web Speech API not available in this browser.",
                    active:
                        prefs.voiceTranscriptionMode === "web-speech" &&
                        webSpeechSupported,
                    onClick: webSpeechSupported
                        ? () => {
                              if (
                                  typeof onToggleVoiceTranscriptionMode ===
                                  "function"
                              )
                                  onToggleVoiceTranscriptionMode();
                              renderSettings();
                          }
                        : undefined,
                }),
            );
            body.appendChild(
                makeSetting({
                    name: "Notifications",
                    value: prefs.pushSupported
                        ? prefs.pushSubscribed
                            ? "on"
                            : "off"
                        : "unsupported",
                    description: prefs.pushSupported
                        ? "Enable or disable push notifications."
                        : "Push notifications are not available in this browser.",
                    active: prefs.pushSubscribed,
                    onClick: prefs.pushSupported
                        ? async () => {
                              try {
                                  if (typeof onTogglePush === "function")
                                      await onTogglePush();
                                  renderSettings();
                              } catch (error) {
                                  onNotice(
                                      error instanceof Error
                                          ? error.message
                                          : String(error),
                                      "error",
                                  );
                              }
                          }
                        : undefined,
                }),
            );
            body.appendChild(
                makeSetting({
                    name: "Test notifications",
                    value: prefs.pushSupported ? "send" : "unavailable",
                    description: prefs.pushSupported
                        ? "Send a local test notification now."
                        : "Requires browser notification support.",
                    active: false,
                    onClick: prefs.pushSupported
                        ? async () => {
                              try {
                                  if (typeof onTestPush === "function")
                                      await onTestPush();
                              } catch (error) {
                                  onNotice(
                                      error instanceof Error
                                          ? error.message
                                          : String(error),
                                      "error",
                                  );
                              }
                          }
                        : undefined,
                }),
            );

            addSection("Pi session");
            if (!prefs.hasSessionControl) {
                const note = document.createElement("div");
                note.className = "menu-item";
                const primary = document.createElement("div");
                primary.className = "primary";
                primary.textContent = "No controllable session";
                const secondary = document.createElement("div");
                secondary.className = "secondary";
                secondary.textContent =
                    "Open a session and take over control to change pi runtime behavior.";
                note.appendChild(primary);
                note.appendChild(secondary);
                body.appendChild(note);
            } else {
                const nextDelivery =
                    getDeliveryMode() === "all" ? "one-at-a-time" : "all";
                body.appendChild(
                    makeSetting({
                        name: "Delivery",
                        value:
                            getDeliveryMode() === "all"
                                ? "All at once"
                                : "One at a time",
                        description:
                            "How queued messages are delivered: one at a time or all together.",
                        active: getDeliveryMode() === "all",
                        onClick: async () => {
                            try {
                                setDeliveryMode(nextDelivery);
                                if (typeof onSetSteeringMode === "function")
                                    await onSetSteeringMode(nextDelivery);
                                if (typeof onSetFollowUpMode === "function")
                                    await onSetFollowUpMode(nextDelivery);
                                renderSettings();
                            } catch (error) {
                                onNotice(
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                                    "error",
                                );
                            }
                        },
                    }),
                );
                const nextSend =
                    getStreamingSendMode() === "steer" ? "followUp" : "steer";
                body.appendChild(
                    makeSetting({
                        name: "Send while streaming",
                        value:
                            getStreamingSendMode() === "steer"
                                ? "Steering"
                                : "Follow-up",
                        description:
                            getStreamingSendMode() === "steer"
                                ? "Steering: sends immediately and interrupts the agent."
                                : "Follow-up: queues the message until the agent finishes.",
                        active: getStreamingSendMode() === "followUp",
                        onClick: () => {
                            setStreamingSendMode(nextSend);
                            renderSettings();
                        },
                    }),
                );
            }

            const footer = document.createElement("div");
            footer.className = "si-meta";
            footer.style.marginTop = "12px";
            footer.textContent =
                "Model and Thinking stay in the top bar for quick access.";
            body.appendChild(footer);

            menuPanel.appendChild(hdr);
            menuPanel.appendChild(body);
        };

        renderSettings();
    }

    if (menuScrim)
        menuScrim.addEventListener("click", () => {
            if (menuOverlay?.dataset?.locked === "1") return;
            close();
        });

    return {
        close,
        isOpen: () => open,
        openModelMenu,
        openThinkingMenu,
        openCommandsMenu,
        openSettingsMenu,
    };
}
