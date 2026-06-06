import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	ClientSideConnection,
	PROTOCOL_VERSION,
	ndJsonStream,
	type Client,
	type SessionNotification as AcpSessionNotification,
} from "@agentclientprotocol/sdk";
import { createAcpConnection } from "@oh-my-pi/pi-coding-agent/modes/acp";
import {
	type AgentMessage,
	type AgentSession,
	type AgentSessionEvent,
	type Api,
	type Model,
	type PiAuthStorage,
	type PiDefaultResourceLoader,
	type PiModelRegistry,
	type PiSessionManager,
	type ThinkingLevel,
} from "./pi-types.ts";
import { SessionTerminalManager, type TerminalClient } from "./session-terminal.ts";
import { getSystemPiEntryPath, loadSystemPiModule } from "./system-pi.ts";
import type {
	ApiCommandRequest,
	ApiCreateSessionRequest,
	ApiForkSessionRequest,
	ApiForkSessionResponse,
	ApiModelInfo,
	ApiNavigateTreeRequest,
	ApiNavigateTreeResponse,
	ApiSessionCommand,
	ApiSessionState,
	ApiSessionSummary,
	ApiSessionTreeEntry,
	ApiSessionTreeResponse,
	ClientRole,
	ApiSessionPatch,
	DialogCloseReason,
	SseEvent,
	ApiTerminalClientMessage,
	ApiTerminalServerMessage,
} from "./types.ts";

const piModule = await loadSystemPiModule();
const {
	AuthStorage,
	createAgentSession,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	Settings,
	readTool,
	bashTool,
	editTool,
	writeTool,
	grepTool,
	findTool,
	lsTool,
} = piModule;

// ---------------------------------------------------------------------------
// Worktree isolation guardrails
// ---------------------------------------------------------------------------

const WORKTREE_CWD_RE = /\/\.worktrees\/worktree-([^/]+)$/;

function parseWorktreeInfo(cwd: string): { name: string; branch: string; repoRoot: string } | null {
	const match = cwd.match(WORKTREE_CWD_RE);
	if (!match) return null;
	const name = match[1];
	const branch = `worktree-${name}`;
	const repoRoot = cwd.replace(/\/\.worktrees\/worktree-[^/]+$/, "");
	return { name, branch, repoRoot };
}

const WORKTREE_GUARDRAILS = `
## ⚠️ Worktree isolation rules

You are running inside a **git worktree**, an isolated branch meant for a single task.

### Hard constraints

1. **Stay on your branch.** Do NOT checkout, merge into, push to, or modify \`main\` or any other branch. Commit only to your current worktree branch. Only touch other branches if the user explicitly asks you to.
2. **Stay in your directory.** Do NOT read, write, or execute anything outside this worktree's directory tree. Other worktrees under \`.worktrees/\` are off-limits. Only access other worktrees if the user explicitly asks you to.
3. **No live-service operations.** Do NOT run \`systemctl restart\`, \`systemctl stop\`, \`systemctl start\`, or any command that affects running services, databases, reverse proxies, or DNS. Do NOT deploy, publish, or push to production. Only perform service operations if the user explicitly asks you to.
4. **No destructive git operations.** Do NOT \`git push\`, \`git push --force\`, \`git branch -D\`, or \`git worktree remove\` on anything. Only perform these if the user explicitly asks you to.

If the user explicitly asks you to do any of the above, comply — but reconfirm first with a brief warning that it affects resources outside this worktree.

When your work is done, just commit to your branch. Merging into main is handled externally.
`.trim();

let subagentManagementModulePromise: Promise<any | null> | null = null;
let subagentSkillsModulePromise: Promise<any | null> | null = null;

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function parseVersionPart(part: string | undefined): number {
	const match = String(part ?? "").match(/\d+/);
	return match ? Number.parseInt(match[0] ?? "0", 10) : 0;
}

function usesNamedToolsApi(version: unknown): boolean {
	if (typeof version === "string" && version.trim()) {
		const [majorRaw, minorRaw] = version.trim().split(".", 3);
		const major = parseVersionPart(majorRaw);
		const minor = parseVersionPart(minorRaw);
		if (major > 0) return true;
		if (major === 0 && minor >= 70) return true;
	}
	return typeof readTool === "undefined";
}

const USE_NAMED_TOOLS_API = usesNamedToolsApi(piModule.VERSION);

interface ResolvedStartAgentConfig {
	name: string;
	systemPrompt?: string;
	tools?: string[];
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	extensions?: string[];
}

function resolveLegacyTool(toolName: string, cwd: string): unknown {
	switch (toolName) {
		case "read":
			return readTool ?? createReadTool?.(cwd);
		case "bash":
			return bashTool ?? createBashTool?.(cwd);
		case "edit":
			return editTool ?? createEditTool?.(cwd);
		case "write":
			return writeTool ?? createWriteTool?.(cwd);
		case "grep":
			return grepTool ?? createGrepTool?.(cwd);
		case "find":
			return findTool ?? createFindTool?.(cwd);
		case "ls":
			return lsTool ?? createLsTool?.(cwd);
		default:
			return undefined;
	}
}

function resolveSessionToolSelection(cwd: string, toolNames: string[]): string[] | unknown[] | undefined {
	const normalized = toolNames.map((name) => name.trim()).filter(Boolean);
	if (normalized.length === 0) return undefined;
	if (USE_NAMED_TOOLS_API) return normalized;

	const mappedLegacyTools = normalized.map((name) => resolveLegacyTool(name, cwd)).filter(Boolean);
	if (mappedLegacyTools.length === normalized.length) {
		return mappedLegacyTools;
	}

	return normalized;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)
		? (normalized as ThinkingLevel)
		: undefined;
}

function resolveModelById(modelIdOrScope: string, modelRegistry: PiModelRegistry): { model?: Model<Api>; thinkingLevel?: ThinkingLevel } {
	const trimmed = modelIdOrScope.trim();
	if (!trimmed) return {};

	if (trimmed.includes("/") || trimmed.includes(":")) {
		const separator = trimmed.includes("/") ? "/" : ":";
		const [provider, modelId] = trimmed.split(separator, 2);
		if (!provider || !modelId) return {};
		const match = modelRegistry.find(provider, modelId);
		if (!match) return {};
		const typedMatch = match as Model<Api> & { thinkingLevel?: ThinkingLevel };
		return { model: match, thinkingLevel: typedMatch.thinkingLevel };
	}

	const exact = modelRegistry.getAvailable().find((m) => m.id === trimmed);
	if (exact) {
		const typedExact = exact as Model<Api> & { thinkingLevel?: ThinkingLevel };
		return { model: exact, thinkingLevel: typedExact.thinkingLevel };
	}
	return {};
}

async function loadSubagentManagementModule() {
	if (subagentManagementModulePromise !== null) return subagentManagementModulePromise;
	const packageRoot = dirname(getSystemPiEntryPath());
	const { discoverAgents } = await import(join(packageRoot, "task", "discovery.ts"));
	subagentManagementModulePromise = Promise.resolve({
		findAgents: async (name: string, cwd: string) => {
			const { agents } = await discoverAgents(cwd);
			const target = name.trim().toLowerCase();
			return agents.filter((a) => a.name.toLowerCase() === target);
		},
	});
	return subagentManagementModulePromise;
}

async function loadSubagentSkillsModule() {
	if (subagentSkillsModulePromise !== null) return subagentSkillsModulePromise;
	const packageRoot = dirname(getSystemPiEntryPath());
	const { loadSkills, buildSkillPromptMessage } = await import(join(packageRoot, "extensibility", "skills.ts"));
	subagentSkillsModulePromise = Promise.resolve({
		resolveSkills: async (skillNames: string[], cwd: string) => {
			const { skills } = await loadSkills({ cwd });
			const resolved: any[] = [];
			const missing: string[] = [];
			for (const name of skillNames) {
				const found = skills.find((s) => s.name === name);
				if (found) {
					resolved.push(found);
				} else {
					missing.push(name);
				}
			}
			return { resolved, missing };
		},
		buildSkillInjection: async (resolvedSkills: any[]) => {
			const parts: string[] = [];
			for (const skill of resolvedSkills) {
				const built = await buildSkillPromptMessage(skill, "");
				if (built?.message) {
					parts.push(built.message);
				}
			}
			return parts.join("\n\n");
		},
	});
	return subagentSkillsModulePromise;
}

async function resolveStartAgentConfig(
	cwd: string,
	startAgent: string | undefined,
	modelRegistry: PiModelRegistry,
): Promise<ResolvedStartAgentConfig | null> {
	const trimmed = typeof startAgent === "string" ? startAgent.trim() : "";
	if (!trimmed) return null;

	const management = await loadSubagentManagementModule();
	if (!management) throw new Error("start agent support is unavailable");

	const candidates = await management.findAgents(trimmed, cwd, "both");
	if (!Array.isArray(candidates) || candidates.length === 0) {
		throw new Error(`Unknown start agent: ${trimmed}`);
	}

	const selected = candidates[0]!;
	const promptParts: string[] = [];
	if (typeof selected.systemPrompt === "string" && selected.systemPrompt.trim()) {
		promptParts.push(selected.systemPrompt.trim());
	}
	const skillsToLoad = selected.autoloadSkills || (selected as any).skills || [];
	if (Array.isArray(skillsToLoad) && skillsToLoad.length > 0) {
		const skillsModule = await loadSubagentSkillsModule();
		if (!skillsModule) throw new Error(`Unable to resolve skills for start agent: ${selected.name}`);
		const result = await skillsModule.resolveSkills(skillsToLoad, cwd);
		if (result.missing.length > 0) {
			throw new Error(`Unknown skills for start agent '${selected.name}': ${result.missing.join(", ")}`);
		}
		if (result.resolved.length > 0) {
			const injected = await skillsModule.buildSkillInjection(result.resolved);
			if (injected) promptParts.push(injected);
		}
	}

	const tools = Array.isArray(selected.tools)
		? selected.tools
			.map((name: string) => name.trim())
			.filter((name: string) => BUILT_IN_TOOL_NAMES.has(name))
		: undefined;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel | undefined;
	const selectedModel = Array.isArray(selected.model) ? selected.model[0] : selected.model;
	if (typeof selectedModel === "string" && selectedModel.trim()) {
		const resolvedModel = resolveModelById(selectedModel, modelRegistry);
		if (!resolvedModel.model) {
			throw new Error(`Unknown model for start agent '${selected.name}': ${selectedModel}`);
		}
		model = resolvedModel.model;
		thinkingLevel = resolvedModel.thinkingLevel;
	}

	const overrideThinking = normalizeThinkingLevel(selected.thinkingLevel || (selected as any).thinking);
	if (overrideThinking) thinkingLevel = overrideThinking;

	const extensions = Array.isArray((selected as any).extensions)
		? (selected as any).extensions.map((value: string) => value.trim()).filter(Boolean)
		: undefined;

	const systemPrompt = promptParts.length > 0 ? promptParts.join("\n\n") : undefined;
	return {
		name: selected.name,
		systemPrompt: systemPrompt?.trim(),
		tools,
		model,
		thinkingLevel,
		extensions,
	};
}

async function createSessionWithWorktreeGuard(opts: {
	cwd: string;
	sessionManager: PiSessionManager;
	authStorage: PiAuthStorage;
	modelRegistry: PiModelRegistry;
	startAgent?: string;
}): Promise<{
	session: AgentSession;
	startAgentConfig: ResolvedStartAgentConfig | null;
	setToolUIContext?: (uiContext: any, hasUI: boolean) => void;
}> {
	const startAgentConfig = await resolveStartAgentConfig(opts.cwd, opts.startAgent, opts.modelRegistry);
	const agentDir = getAgentDir();
	const baseSettings = await Settings.init({ agentDir });
	const settingsManager = await baseSettings.cloneForCwd(opts.cwd);

	const info = parseWorktreeInfo(opts.cwd);
	const systemPromptOverride =
		typeof startAgentConfig?.systemPrompt === "string" && startAgentConfig.systemPrompt.trim()
			? (base: string[]) => [...base, startAgentConfig.systemPrompt!.trim()]
			: undefined;

	const appendSystemPromptOverride = info
		? (base: string[]) => [
			...base,
			`You are on branch \`${info.branch}\` in worktree \`${info.name}\` (repo root: \`${info.repoRoot}\`).\n\n${WORKTREE_GUARDRAILS}`,
		]
		: undefined;

	const systemPrompt = (base: string[]) => {
		let result = base;
		if (systemPromptOverride) result = systemPromptOverride(result);
		if (appendSystemPromptOverride) result = appendSystemPromptOverride(result);
		return result;
	};

	const tools = startAgentConfig?.tools ? resolveSessionToolSelection(opts.cwd, startAgentConfig.tools) : undefined;
	const { session, setToolUIContext } = await createAgentSession({
		cwd: opts.cwd,
		authStorage: opts.authStorage,
		modelRegistry: opts.modelRegistry,
		sessionManager: opts.sessionManager,
		settings: settingsManager,
		systemPrompt,
		hasUI: true,
		...(tools ? { tools } : {}),
		...(startAgentConfig?.model ? { model: startAgentConfig.model } : {}),
		...(startAgentConfig?.thinkingLevel ? { thinkingLevel: startAgentConfig.thinkingLevel } : {}),
		...(startAgentConfig?.extensions && startAgentConfig.extensions.length > 0
			? { additionalExtensionPaths: startAgentConfig.extensions }
			: {}),
	} as any);
	return { session, startAgentConfig, setToolUIContext };
}

// ---------------------------------------------------------------------------

export interface SessionClient {
	connectionId: string;
	clientId: string;
	connectedAtMs: number;
	send(event: SseEvent): void;
	close(): void;
}

export interface SessionTerminalClient extends TerminalClient {}

export interface SessionNotification {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	messageRole: string;
	messageText: string;
}

export interface PiWebRuntimeOptions {
	onMessageNotification?: (payload: SessionNotification) => void | Promise<void>;
}

interface AcpRuntimeBridge {
	client: ClientSideConnection;
	agentConnection: ReturnType<typeof createAcpConnection>;
	state: AcpRuntimeState;
}

interface AcpModelOption {
	modelId: string;
	name?: string;
	description?: string;
}

interface AcpRuntimeState {
	models?: {
		availableModels: AcpModelOption[];
		currentModelId?: string;
	};
	configOptions?: unknown[];
	commands?: ApiSessionCommand[];
}

class InMemoryTransportPair {
	private readonly clientToAgent = new TransformStream();
	private readonly agentToClient = new TransformStream();

	readonly clientStream = ndJsonStream(this.clientToAgent.writable, this.agentToClient.readable);
	readonly agentStream = ndJsonStream(this.agentToClient.writable, this.clientToAgent.readable);
}

class PiWebAcpClient implements Client {
	constructor(
		private readonly onSessionUpdate: (params: AcpSessionNotification) => void,
		private readonly onCreateElicitation: (params: unknown) => Promise<unknown>,
	) {}

	async requestPermission(params: Parameters<Client["requestPermission"]>[0]): Promise<ReturnType<Client["requestPermission"]> extends Promise<infer T> ? T : never> {
		const allow = params.options.find((option) => option.kind === "allow_always" || option.kind === "allow_once") ?? params.options[0];
		if (!allow) return { outcome: { outcome: "cancelled" } } as any;
		return { outcome: { outcome: "selected", optionId: allow.optionId } } as any;
	}

	async sessionUpdate(params: AcpSessionNotification): Promise<void> {
		this.onSessionUpdate(params);
	}

	async unstable_createElicitation(params: unknown): Promise<unknown> {
		return this.onCreateElicitation(params);
	}

	async extMethod(_method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return {};
	}

	async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {}
}

interface RunningSession {
	session: AgentSession;
	cwd: string;
	sessionFile: string | null;
	createdAtMs: number;
	modifiedAtMs: number;
	controllerClientId: string | null;
	clients: Map<string, SessionClient>;
	terminalManager: SessionTerminalManager;
	unsubscribe: (() => void) | null;
	lastAssistantMessageText: string;
	startAgent?: string;
	acp: AcpRuntimeBridge;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
		.map((c) => (c as { text: string }).text)
		.join("");
}

function compactPreview(text: string, max = 140): string {
	const normalized = String(text || "").replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…` : normalized;
}

const FAST_SESSION_PREVIEW_MAX_CHARS = 4_000;
const FAST_SESSION_PREVIEW_MAX_LINES = 80;

function truncateFastPreviewText(input: string, maxChars = FAST_SESSION_PREVIEW_MAX_CHARS, maxLines = FAST_SESSION_PREVIEW_MAX_LINES): string {
	const text = String(input ?? "");
	if (!text) return "";
	const lines = text.split("\n");
	const limitedLines = lines.slice(0, maxLines);
	let output = limitedLines.join("\n");
	const truncatedByLines = limitedLines.length < lines.length;
	let truncatedByChars = false;
	if (output.length > maxChars) {
		output = output.slice(0, maxChars);
		truncatedByChars = true;
	}
	if (truncatedByLines || truncatedByChars) {
		output = `${output.trimEnd()}\n\n[truncated for fast session loading]`;
	}
	return output;
}

function summarizeContentForFastSessionPreview(content: unknown): string {
	if (typeof content === "string") {
		const preview = truncateFastPreviewText(content);
		return preview || "(content omitted for fast session loading)";
	}
	if (!Array.isArray(content)) return "(content omitted for fast session loading)";

	const textParts: string[] = [];
	let imageCount = 0;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typedBlock = block as {
			type?: unknown;
			text?: unknown;
			data?: unknown;
		};
		if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
			textParts.push(typedBlock.text);
			continue;
		}
		if (typedBlock.type === "image" && typeof typedBlock.data === "string") {
			imageCount += 1;
		}
	}

	let text = textParts.join("\n").trim();
	if (imageCount > 0) {
		text += `${text ? "\n\n" : ""}[${imageCount} image${imageCount === 1 ? "" : "s"} omitted for fast session loading]`;
	}
	if (!text) {
		text = "(content omitted for fast session loading)";
	}
	return truncateFastPreviewText(text);
}

function summarizeAssistantContentForFastSessionPreview(content: unknown): unknown {
	if (typeof content === "string") {
		const preview = truncateFastPreviewText(content);
		return preview || "(content omitted for fast session loading)";
	}
	if (!Array.isArray(content)) return "(content omitted for fast session loading)";

	const previewBlocks: Record<string, unknown>[] = [];
	let imageCount = 0;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typedBlock = block as {
			type?: unknown;
			text?: unknown;
			data?: unknown;
			thinking?: unknown;
			reasoning?: unknown;
		};
		if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
			const previewText = truncateFastPreviewText(typedBlock.text);
			if (previewText) previewBlocks.push({ ...(block as Record<string, unknown>), text: previewText });
			continue;
		}
		if (typedBlock.type === "thinking" && typeof typedBlock.thinking === "string") {
			const previewThinking = truncateFastPreviewText(typedBlock.thinking);
			if (previewThinking) previewBlocks.push({ ...(block as Record<string, unknown>), thinking: previewThinking });
			continue;
		}
		if (typedBlock.type === "reasoning" && typeof typedBlock.reasoning === "string") {
			const previewReasoning = truncateFastPreviewText(typedBlock.reasoning);
			if (previewReasoning) previewBlocks.push({ ...(block as Record<string, unknown>), reasoning: previewReasoning });
			continue;
		}
		if (typedBlock.type === "image" && typeof typedBlock.data === "string") {
			imageCount += 1;
			continue;
		}
		previewBlocks.push({ ...(block as Record<string, unknown>) });
	}

	if (imageCount > 0) {
		previewBlocks.push({
			type: "text",
			text: `[${imageCount} image${imageCount === 1 ? "" : "s"} omitted for fast session loading]`,
		});
	}

	return previewBlocks.length > 0 ? previewBlocks : "(content omitted for fast session loading)";
}

function makeFastSessionPreviewMessage(message: AgentMessage): AgentMessage {
	if (!message || typeof message !== "object") return message;
	const role = (message as { role?: unknown }).role;
	const preview: Record<string, unknown> = { ...(message as unknown as Record<string, unknown>) };
	if (Object.prototype.hasOwnProperty.call(preview, "content")) {
		preview.content = role === "assistant"
			? summarizeAssistantContentForFastSessionPreview(preview.content)
			: summarizeContentForFastSessionPreview(preview.content);
	}
	if (role === "toolResult") {
		preview.details = undefined;
	}
	return preview as unknown as AgentMessage;
}

function makeFastSessionPreviewMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) => makeFastSessionPreviewMessage(message));
}

function describeSessionTreeEntry(entry: any): Pick<ApiSessionTreeEntry, "type" | "role" | "title" | "preview" | "isUserMessage" | "canFork"> {
	if (!entry || typeof entry !== "object") {
		return { type: "unknown", title: "Entry", preview: "", isUserMessage: false, canFork: false };
	}

	if (entry.type === "message") {
		const role = typeof entry.message?.role === "string" ? entry.message.role : undefined;
		if (role === "user") {
			return {
				type: "message",
				role,
				title: "User",
				preview: compactPreview(extractTextContent(entry.message?.content) || "(empty user message)"),
				isUserMessage: true,
				canFork: true,
			};
		}
		if (role === "assistant") {
			const preview = compactPreview(extractTextContent(entry.message?.content));
			return {
				type: "message",
				role,
				title: "Assistant",
				preview: preview || "Assistant response",
				isUserMessage: false,
				canFork: false,
			};
		}
		if (role === "toolResult") {
			const toolName = typeof entry.message?.toolName === "string" ? entry.message.toolName : "tool";
			const preview = compactPreview(extractTextContent(entry.message?.content));
			return {
				type: "message",
				role,
				title: `Tool: ${toolName}`,
				preview: preview || "Tool result",
				isUserMessage: false,
				canFork: false,
			};
		}
		if (role === "bashExecution") {
			const command = typeof entry.message?.command === "string" ? entry.message.command : "bash command";
			return {
				type: "message",
				role,
				title: "Bash",
				preview: compactPreview(command) || "Bash command",
				isUserMessage: false,
				canFork: false,
			};
		}
		if (role === "custom") {
			const customType = typeof entry.message?.customType === "string" ? entry.message.customType : "custom";
			const preview = compactPreview(extractTextContent(entry.message?.content) || String(entry.message?.content || ""));
			return {
				type: "message",
				role,
				title: `Custom: ${customType}`,
				preview: preview || "Custom message",
				isUserMessage: false,
				canFork: false,
			};
		}
		return {
			type: "message",
			role,
			title: role ? role[0]!.toUpperCase() + role.slice(1) : "Message",
			preview: compactPreview(extractTextContent(entry.message?.content) || "Message"),
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "branch_summary") {
		return {
			type: entry.type,
			role: "branchSummary",
			title: "Branch summary",
			preview: compactPreview(typeof entry.summary === "string" ? entry.summary : "") || "Branch summary",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "compaction") {
		return {
			type: entry.type,
			role: "compactionSummary",
			title: "Compaction",
			preview: compactPreview(typeof entry.summary === "string" ? entry.summary : "") || "Compaction summary",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "model_change") {
		return {
			type: entry.type,
			title: "Model change",
			preview: compactPreview(`${entry.provider || "provider"}/${entry.modelId || "model"}`),
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "thinking_level_change") {
		return {
			type: entry.type,
			title: "Thinking",
			preview: compactPreview(String(entry.thinkingLevel || "")) || "Thinking level change",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "custom") {
		return {
			type: entry.type,
			title: `Custom: ${entry.customType || "entry"}`,
			preview: compactPreview(typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {})) || "Custom entry",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "custom_message") {
		return {
			type: entry.type,
			role: "custom",
			title: `Custom: ${entry.customType || "message"}`,
			preview: compactPreview(extractTextContent(entry.content) || String(entry.content || "")) || "Custom message",
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "label") {
		return {
			type: entry.type,
			title: "Label",
			preview: compactPreview(typeof entry.label === "string" ? entry.label : "(cleared label)"),
			isUserMessage: false,
			canFork: false,
		};
	}

	if (entry.type === "session_info") {
		return {
			type: entry.type,
			title: "Session info",
			preview: compactPreview(typeof entry.name === "string" ? entry.name : "Session metadata") || "Session metadata",
			isUserMessage: false,
			canFork: false,
		};
	}

	return {
		type: typeof entry.type === "string" ? entry.type : "entry",
		title: "Entry",
		preview: "",
		isUserMessage: false,
		canFork: false,
	};
}

function flattenSessionTree(
	nodes: Array<any>,
	depth: number,
	leafId: string | null,
	activePathIds: Set<string>,
	out: ApiSessionTreeEntry[],
): void {
	for (const node of nodes || []) {
		const entry = node?.entry;
		if (!entry || typeof entry !== "object") continue;
		const described = describeSessionTreeEntry(entry);
		out.push({
			id: String(entry.id || ""),
			parentId: entry.parentId ?? null,
			timestamp: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
			depth,
			type: described.type,
			role: described.role,
			title: described.title,
			preview: described.preview,
			label: typeof node?.label === "string" ? node.label : undefined,
			labelTimestamp: typeof node?.labelTimestamp === "string" ? node.labelTimestamp : undefined,
			isUserMessage: described.isUserMessage,
			canFork: described.canFork,
			isActiveLeaf: leafId === entry.id,
			isActivePath: activePathIds.has(entry.id),
		});
		flattenSessionTree(Array.isArray(node?.children) ? node.children : [], depth + 1, leafId, activePathIds, out);
	}
}

function computeFirstMessage(messages: AgentSession["messages"]): string {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "user") continue;
		const text = extractTextContent((message as { content?: unknown }).content);
		if (text.trim().length > 0) return text;
	}
	return "(no messages)";
}

function extractLastAssistantText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;
		const text = extractTextContent((message as { content?: unknown }).content).trim();
		if (text) return text;
	}
	return "";
}

function toIso(ms: number): string {
	return new Date(ms).toISOString();
}

function modelSnapshotFromKey(session: AgentSession, modelKey: unknown): ApiSessionState["model"] {
	const parsed = splitAcpModelId(typeof modelKey === "string" ? modelKey : undefined);
	if (!parsed) return null;
	let name: string | undefined;
	try {
		const match = typeof session.getAvailableModels === "function"
			? session.getAvailableModels().find((model: Model<Api>) => model.provider === parsed.provider && model.id === parsed.id)
			: undefined;
		name = typeof match?.name === "string" ? match.name : undefined;
	} catch {}
	return {
		provider: parsed.provider,
		id: parsed.id,
		...(name ? { name } : {}),
	};
}

function modelSnapshotFromSessionHistory(session: AgentSession): ApiSessionState["model"] {
	try {
		const branch = typeof session.sessionManager?.getBranch === "function" ? session.sessionManager.getBranch() : [];
		if (Array.isArray(branch)) {
			for (let i = branch.length - 1; i >= 0; i -= 1) {
				const entry = branch[i];
				if (entry?.type !== "model_change") continue;
				const snapshot = modelSnapshotFromKey(session, entry.model ?? `${entry.provider ?? ""}/${entry.modelId ?? ""}`);
				if (snapshot) return snapshot;
			}
		}
	} catch {}

	const messages = Array.isArray(session.messages) ? session.messages : [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as { provider?: unknown; model?: unknown };
		const provider = typeof message?.provider === "string" ? message.provider : "";
		const model = typeof message?.model === "string" ? message.model : "";
		const snapshot = modelSnapshotFromKey(session, provider && model ? `${provider}/${model}` : undefined);
		if (snapshot) return snapshot;
	}
	return null;
}

function safeModelSnapshot(session: AgentSession): ApiSessionState["model"] {
	const model = session.model;
	if (!model) return modelSnapshotFromSessionHistory(session);
	const name = typeof (model as { name?: unknown }).name === "string" ? (model as { name: string }).name : undefined;
	return { provider: model.provider, id: model.id, name };
}

function safeContextUsageSnapshot(session: AgentSession): ApiSessionState["contextUsage"] {
	try {
		const usage = session.getContextUsage();
		if (!usage) return null;
		return {
			tokens: typeof usage.tokens === "number" ? usage.tokens : null,
			contextWindow: usage.contextWindow,
			percent: typeof usage.percent === "number" ? usage.percent : null,
		};
	} catch {
		return null;
	}
}

function safeStatsSnapshot(session: AgentSession): ApiSessionState["stats"] {
	try {
		const stats = session.getSessionStats();
		return { tokens: stats.tokens, cost: stats.cost };
	} catch {
		return null;
	}
}

// Only include built-in commands that actually work as plain slash commands in pi-mobile.
// Commands with dedicated mobile UI (for example tree/fork launchers) are surfaced elsewhere
// instead of being sent through the prompt pipeline.
const BUILTIN_COMMANDS: ApiSessionCommand[] = [
	{ name: "compact", description: "Compact conversation history", source: "extension" },
];

function safeCommandsSnapshot(session: AgentSession): ApiSessionCommand[] {
	try {
		const result: ApiSessionCommand[] = [];
		const seen = new Set<string>();

		// 1. Extension commands via private _extensionRunner
		const runner = (session as any)._extensionRunner;
		if (runner && typeof runner.getRegisteredCommands === "function") {
			const cmds = runner.getRegisteredCommands();
			if (Array.isArray(cmds)) {
				for (const cmd of cmds) {
					const name = typeof cmd?.invocationName === "string" ? cmd.invocationName.trim()
						: typeof cmd?.name === "string" ? cmd.name.trim() : "";
					if (!name || seen.has(name)) continue;
					seen.add(name);
					result.push({
						name,
						description: typeof cmd?.description === "string" ? cmd.description.trim() || undefined : undefined,
						source: "extension",
						executeImmediately: Boolean((cmd as { executeImmediately?: unknown })?.executeImmediately),
					});
				}
			}
		}

		// 2. Prompt templates (public getter)
		const customCommands = Array.isArray((session as any).customCommands) ? (session as any).customCommands : [];
		for (const entry of customCommands) {
			const command = (entry as any)?.command ?? entry;
			const name = typeof command?.name === "string" ? command.name.trim() : "";
			if (!name || seen.has(name)) continue;
			seen.add(name);
			result.push({
				name,
				description: typeof command?.description === "string" ? command.description.trim() || undefined : undefined,
				source: "extension",
			});
		}

		// 3. Prompt templates (public getter)
		const templates = session.promptTemplates;
		if (Array.isArray(templates)) {
			for (const tpl of templates) {
				const name = typeof (tpl as any)?.name === "string" ? (tpl as any).name.trim() : "";
				if (!name || seen.has(name)) continue;
				seen.add(name);
				result.push({
					name,
					description: typeof (tpl as any)?.description === "string" ? (tpl as any).description.trim() || undefined : undefined,
					source: "prompt",
				});
			}
		}

		// 4. Skills via session.skills
		const skills = Array.isArray((session as any).skills) ? (session as any).skills : [];
		for (const skill of skills) {
			const name = typeof skill?.name === "string" ? skill.name.trim() : "";
			if (!name) continue;
			const fullName = `skill:${name}`;
			if (seen.has(fullName)) continue;
			seen.add(fullName);
			result.push({
				name: fullName,
				description: typeof skill?.description === "string" ? skill.description.trim() || undefined : undefined,
				source: "skill",
			});
		}

		// 5. Local mobile commands
		for (const cmd of BUILTIN_COMMANDS) {
			if (!seen.has(cmd.name)) {
				seen.add(cmd.name);
				result.push(cmd);
			}
		}

		return result;
	} catch {
		return [];
	}
}

function getSlashCommandName(text: string): string | null {
	const match = text.trim().match(/^\/([A-Za-z0-9_:-]+)/);
	return match ? match[1]!.toLowerCase() : null;
}

function isSessionCustomSlashCommand(session: AgentSession, text: string): boolean {
	const name = getSlashCommandName(text);
	if (!name) return false;
	const customCommands = Array.isArray((session as any).customCommands) ? (session as any).customCommands : [];
	return customCommands.some((entry: any) => {
		const commandName = typeof entry?.command?.name === "string" ? entry.command.name.trim().toLowerCase() : "";
		return commandName === name;
	});
}

function normalizeAcpCommand(command: unknown): ApiSessionCommand | null {
	if (!command || typeof command !== "object") return null;
	const rawName = typeof (command as { name?: unknown }).name === "string"
		? (command as { name: string }).name.trim()
		: "";
	const name = rawName.replace(/^\/+/, "");
	if (!name) return null;
	const description = typeof (command as { description?: unknown }).description === "string"
		? (command as { description: string }).description.trim()
		: "";
	return {
		name,
		...(description ? { description } : {}),
		source: "extension",
	};
}

function mergeCommands(primary: ApiSessionCommand[] | undefined, fallback: ApiSessionCommand[]): ApiSessionCommand[] {
	const result: ApiSessionCommand[] = [];
	const seen = new Set<string>();
	for (const command of [...(primary ?? []), ...fallback]) {
		const name = typeof command?.name === "string" ? command.name.trim() : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		result.push(command);
	}
	return result;
}

function splitAcpModelId(modelId: string | undefined): { provider: string; id: string } | null {
	const trimmed = typeof modelId === "string" ? modelId.trim() : "";
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return null;
	return {
		provider: trimmed.slice(0, slash),
		id: trimmed.slice(slash + 1),
	};
}

function modelStateFromConfigOptions(configOptions: unknown[]): AcpRuntimeState["models"] | undefined {
	for (const option of configOptions) {
		if (!option || typeof option !== "object") continue;
		const typed = option as { id?: unknown; category?: unknown; currentValue?: unknown; options?: unknown };
		const id = typeof typed.id === "string" ? typed.id.toLowerCase() : "";
		const category = typeof typed.category === "string" ? typed.category.toLowerCase() : "";
		if (id !== "model" && category !== "model") continue;
		const options = Array.isArray(typed.options) ? typed.options : [];
		const availableModels = options
			.map((entry): AcpModelOption | null => {
				if (!entry || typeof entry !== "object") return null;
				const modelId = typeof (entry as { value?: unknown }).value === "string"
					? (entry as { value: string }).value.trim()
					: "";
				if (!modelId) return null;
				const name = typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name : undefined;
				const description = typeof (entry as { description?: unknown }).description === "string"
					? (entry as { description: string }).description
					: undefined;
				return { modelId, ...(name ? { name } : {}), ...(description ? { description } : {}) };
			})
			.filter((entry): entry is AcpModelOption => entry !== null);
		const currentModelId = typeof typed.currentValue === "string" ? typed.currentValue.trim() : undefined;
		return { availableModels, currentModelId };
	}
	return undefined;
}

function applyAcpSessionUpdate(state: AcpRuntimeState, params: AcpSessionNotification): void {
	const update = (params as { update?: unknown }).update;
	if (!update || typeof update !== "object") return;
	const typed = update as {
		sessionUpdate?: unknown;
		availableCommands?: unknown;
		configOptions?: unknown;
		models?: unknown;
	};

	if (Array.isArray(typed.configOptions)) {
		state.configOptions = typed.configOptions;
		const modelState = modelStateFromConfigOptions(typed.configOptions);
		if (modelState) state.models = modelState;
	}

	if (typed.models && typeof typed.models === "object") {
		const models = typed.models as { availableModels?: unknown; currentModelId?: unknown };
		const availableModels = Array.isArray(models.availableModels)
			? models.availableModels
				.map((entry): AcpModelOption | null => {
					if (!entry || typeof entry !== "object") return null;
					const modelId = typeof (entry as { modelId?: unknown }).modelId === "string"
						? (entry as { modelId: string }).modelId.trim()
						: "";
					if (!modelId) return null;
					const name = typeof (entry as { name?: unknown }).name === "string" ? (entry as { name: string }).name : undefined;
					const description = typeof (entry as { description?: unknown }).description === "string"
						? (entry as { description: string }).description
						: undefined;
					return { modelId, ...(name ? { name } : {}), ...(description ? { description } : {}) };
				})
				.filter((entry): entry is AcpModelOption => entry !== null)
			: [];
		const currentModelId = typeof models.currentModelId === "string" ? models.currentModelId.trim() : undefined;
		state.models = { availableModels, currentModelId };
	}

	if (Array.isArray(typed.availableCommands)) {
		state.commands = typed.availableCommands
			.map(normalizeAcpCommand)
			.filter((command): command is ApiSessionCommand => command !== null);
	}
}

function applyAcpResponseState(state: AcpRuntimeState, response: unknown): void {
	if (!response || typeof response !== "object") return;
	const typed = response as { configOptions?: unknown; models?: unknown; availableCommands?: unknown };
	applyAcpSessionUpdate(state, {
		sessionId: "",
		update: {
			sessionUpdate: "config_option_update",
			...(Array.isArray(typed.configOptions) ? { configOptions: typed.configOptions } : {}),
			...(typed.models ? { models: typed.models } : {}),
			...(Array.isArray(typed.availableCommands) ? { availableCommands: typed.availableCommands } : {}),
		},
	} as AcpSessionNotification);
}

function acpModelSnapshot(state: AcpRuntimeState): ApiSessionState["model"] {
	const currentModelId = state.models?.currentModelId;
	const parsed = splitAcpModelId(currentModelId);
	if (!parsed) return null;
	const modelInfo = state.models?.availableModels.find((model) => model.modelId === currentModelId);
	return {
		provider: parsed.provider,
		id: parsed.id,
		...(modelInfo?.name ? { name: modelInfo.name } : {}),
	};
}

function overlayAcpState<T extends ApiSessionState | ApiSessionPatch>(
	base: T,
	state: AcpRuntimeState | undefined,
	fallbackCommands: ApiSessionCommand[],
): T {
	if (!state) return base;
	const model = acpModelSnapshot(state);
	const commands = mergeCommands(state.commands, fallbackCommands);
	return {
		...base,
		...(model ? { model } : {}),
		commands,
	};
}

function toMessageTimestamp(timestamp: unknown): number {
	if (typeof timestamp === "number") return timestamp;
	if (typeof timestamp !== "string") return Date.now();
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function buildMessagesFromSessionBranch(session: AgentSession): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of session.sessionManager.getBranch()) {
		switch (entry.type) {
			case "message":
				messages.push(entry.message);
				break;
			case "custom_message": {
				messages.push({
					role: "custom",
					customType: entry.customType,
					content: entry.content,
					display: entry.display,
					details: entry.details,
					timestamp: toMessageTimestamp(entry.timestamp),
				});
				break;
			}
			case "branch_summary": {
				messages.push({
					role: "branchSummary",
					summary: entry.summary,
					fromId: entry.fromId,
					timestamp: toMessageTimestamp(entry.timestamp),
				} as AgentMessage);
				break;
			}
			case "compaction": {
				messages.push({
					role: "compactionSummary",
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					timestamp: toMessageTimestamp(entry.timestamp),
				} as AgentMessage);
				break;
			}
			default:
				break;
		}
	}
	return messages;
}

function buildState(session: AgentSession, cwd: string, includeFullHistory = false, startAgent?: string, messageLimit = 0): ApiSessionState {
	let messages = includeFullHistory ? buildMessagesFromSessionBranch(session) : session.messages;
	if (messageLimit > 0 && messages.length > messageLimit) {
		// `tailMessages` is only meant to bound how many messages we send on
		// initial session load. Never rewrite message content into preview text,
		// or placeholders like `[truncated for fast session loading]` can leak
		// into the actual chat transcript shown to the user.
		messages = messages.slice(-messageLimit);
	}
	return {
		sessionId: session.sessionId,
		cwd,
		sessionFile: session.sessionFile ?? null,
		sessionName: session.sessionName,
		startAgent,
		isStreaming: session.isStreaming,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		messages,
		commands: safeCommandsSnapshot(session),
	};
}

function buildPatch(session: AgentSession): ApiSessionPatch {
	return {
		isStreaming: session.isStreaming,
		model: safeModelSnapshot(session),
		thinkingLevel: session.thinkingLevel,
		sessionName: session.sessionName,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		stats: safeStatsSnapshot(session),
		contextUsage: safeContextUsageSnapshot(session),
		commands: safeCommandsSnapshot(session),
	};
}

function buildRuntimeState(runtime: RunningSession, includeFullHistory = false, messageLimit = 0): ApiSessionState {
	const fallbackCommands = safeCommandsSnapshot(runtime.session);
	const state = buildState(runtime.session, runtime.cwd, includeFullHistory, runtime.startAgent, messageLimit);
	return overlayAcpState(state, runtime.acp?.state, fallbackCommands);
}

function buildRuntimePatch(runtime: RunningSession): ApiSessionPatch {
	const fallbackCommands = safeCommandsSnapshot(runtime.session);
	const patch = buildPatch(runtime.session);
	return overlayAcpState(patch, runtime.acp?.state, fallbackCommands);
}

async function ensureDirectory(path: string): Promise<void> {
	let info: { isDirectory(): boolean };
	try {
		info = await stat(path);
	} catch {
		throw new Error(`cwd does not exist: ${path}`);
	}
	if (!info.isDirectory()) {
		throw new Error(`cwd is not a directory: ${path}`);
	}
}

function normalizeCwd(input: string): string {
	return resolve(input.trim());
}

function readSessionHeaderCwd(path: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const chunk = Buffer.alloc(4096);
		let text = "";
		let position = 0;
		while (!text.includes("\n") && position < 64 * 1024) {
			const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
			if (bytesRead <= 0) break;
			text += chunk.subarray(0, bytesRead).toString("utf8");
			position += bytesRead;
		}
		const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine) return null;
		const header = JSON.parse(firstLine);
		return header && header.type === "session" && typeof header.cwd === "string"
			? header.cwd
			: null;
	} catch {
		return null;
	} finally {
		if (fd !== null) {
			try { closeSync(fd); } catch {}
		}
	}
}

async function openSessionManagerFast(path: string, sessionDir?: string): Promise<PiSessionManager> {
	const resolvedPath = resolve(path);
	return await SessionManager.open(resolvedPath, sessionDir);
}

function serializeSessionSummary(entry: {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	startAgent?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage?: string;
}): ApiSessionSummary {
	return {
		id: entry.id,
		path: entry.path,
		cwd: entry.cwd,
		name: entry.name,
		startAgent: entry.startAgent,
		firstMessage: entry.firstMessage ?? "(no messages)",
		created: entry.created.toISOString(),
		modified: entry.modified.toISOString(),
		messageCount: entry.messageCount,
		isRunning: false,
	};
}

type PendingUiPromptEvent = Extract<SseEvent, { type: "ui_select" | "ui_input" | "ui_confirm" }>;

interface PendingUiPrompt {
	resolve: (value: string | undefined) => boolean;
	close: (reason: DialogCloseReason) => boolean;
	sessionId: string;
	event: PendingUiPromptEvent;
}

export class PiWebRuntime {
	private runningById = new Map<string, RunningSession>();
	private runningByPath = new Map<string, string>();
	private onMessageNotification?: (payload: SessionNotification) => void | Promise<void>;
	private pendingUiPrompts = new Map<string, PendingUiPrompt>();
	private globalTerminalManager = new SessionTerminalManager({ sessionId: "scratch", cwd: homedir(), canWrite: () => true });

	constructor(options: PiWebRuntimeOptions = {}) {
		this.onMessageNotification = options.onMessageNotification;
		try {
			if (existsSync(this.archiveStorePath)) {
				const raw = readFileSync(this.archiveStorePath, "utf8");
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					this.archivedSessionIds = new Set(parsed.filter((id) => typeof id === "string"));
				}
			}
		} catch (err) {
			console.error("Failed to load archive list:", err);
		}
	}

	private async createAcpBridge(session: AgentSession, cwd: string, startAgent: string | undefined): Promise<AcpRuntimeBridge> {
		const transport = new InMemoryTransportPair();
		const acpState: AcpRuntimeState = {};
		let firstSession: AgentSession | null = session;
		const createSession = async (nextCwd: string): Promise<AgentSession> => {
			if (firstSession) {
				const prepared = firstSession;
				firstSession = null;
				return prepared;
			}
			const sessionManager = SessionManager.create(nextCwd);
			const result = await createSessionWithWorktreeGuard({
				cwd: nextCwd,
				sessionManager,
				authStorage: await this.getAuthStorage(),
				modelRegistry: await this.getModelRegistry(),
				startAgent,
			});
			this.bindSessionUi(result.session, result.setToolUIContext);
			return result.session;
		};
		const onSessionUpdate = (params: AcpSessionNotification) => {
			const runtime = this.runningById.get(params.sessionId);
			applyAcpSessionUpdate(acpState, params);
			if (!runtime) return;
			runtime.modifiedAtMs = Date.now();
			this.broadcast(params.sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
		};
		const client = new ClientSideConnection(
			() => new PiWebAcpClient(
				onSessionUpdate,
				(params) => this.handleAcpElicitation(params),
			),
			transport.clientStream,
		);
		const agentConnection = createAcpConnection(
			transport.agentStream,
			createSession,
		);
		await client.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
				elicitation: { form: {} },
			},
		});
		const response = await client.newSession({ cwd, mcpServers: [] });
		applyAcpResponseState(acpState, response);
		if (response.sessionId !== session.sessionId) {
			throw new Error(`acp_session_mismatch: ${response.sessionId} !== ${session.sessionId}`);
		}
		return { client, agentConnection, state: acpState };
	}

	private getClientConnections(runtime: RunningSession, clientId: string): SessionClient[] {
		return [...runtime.clients.values()]
			.filter((client) => client.clientId === clientId)
			.sort((a, b) => b.connectedAtMs - a.connectedAtMs);
	}

	private getPreferredClientConnection(runtime: RunningSession, clientId: string): SessionClient | null {
		return this.getClientConnections(runtime, clientId)[0] ?? null;
	}

	private sendToConnection(sessionId: string, connectionId: string, event: SseEvent): boolean {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return false;
		const client = runtime.clients.get(connectionId);
		if (!client) return false;
		try {
			client.send(event);
			return true;
		} catch {
			return false;
		}
	}

	private sendToClient(sessionId: string, clientId: string, event: SseEvent): boolean {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return false;
		for (const client of this.getClientConnections(runtime, clientId)) {
			if (this.sendToConnection(sessionId, client.connectionId, event)) return true;
		}
		return false;
	}

	private sendToController(sessionId: string, event: SseEvent): boolean {
		const runtime = this.runningById.get(sessionId);
		if (!runtime?.controllerClientId) return false;
		return this.sendToClient(sessionId, runtime.controllerClientId, event);
	}

	replayPendingDialogs(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		const client = runtime.clients.get(connectionId);
		if (!client) return;
		if (runtime.controllerClientId !== client.clientId) return;

		for (const pending of this.pendingUiPrompts.values()) {
			if (pending.sessionId !== sessionId) continue;
			this.sendToConnection(sessionId, connectionId, pending.event);
		}
	}

	private replayPendingDialogsToController(sessionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime?.controllerClientId) return;
		const client = this.getPreferredClientConnection(runtime, runtime.controllerClientId);
		if (!client) return;
		this.replayPendingDialogs(sessionId, client.connectionId);
	}

	private bindSessionUi(session: AgentSession, setToolUIContext?: (uiContext: any, hasUI: boolean) => void): void {
		const uiContext = this.createWebUIContext(session.sessionId);
		try {
			setToolUIContext?.(uiContext, true);
		} catch {}
		try {
			const binder = (session as any).bindExtensions;
			if (typeof binder === "function") {
				void binder.call(session, { uiContext });
			}
		} catch {}
	}

	resolveUiPrompt(sessionId: string, uiId: string, cancelled: boolean, value?: string): boolean {
		const pending = this.pendingUiPrompts.get(uiId);
		if (!pending || pending.sessionId !== sessionId) return false;
		return pending.resolve(cancelled ? undefined : value);
	}

	private cancelPendingDialogsForSession(sessionId: string, reason: DialogCloseReason = "aborted"): void {
		for (const pending of this.pendingUiPrompts.values()) {
			if (pending.sessionId !== sessionId) continue;
			pending.close(reason);
		}
	}

	private waitForUiPrompt(sessionId: string, event: PendingUiPromptEvent): Promise<string | undefined> {
		const self = this;
		const uiId = event.uiId;
		return new Promise<string | undefined>((resolve) => {
			let done = false;
			const finish = (value: string | undefined) => {
				if (done) return false;
				done = true;
				self.pendingUiPrompts.delete(uiId);
				resolve(value);
				return true;
			};
			const close = (reason: DialogCloseReason) => {
				const closed = finish(undefined);
				if (closed) self.sendToController(sessionId, { type: "ui_prompt_closed", uiId, reason });
				return closed;
			};
			self.pendingUiPrompts.set(uiId, { resolve: finish, close, sessionId, event });
			self.sendToController(sessionId, event);
		});
	}

	private async handleAcpElicitation(params: unknown): Promise<unknown> {
		if (!params || typeof params !== "object") return { action: "cancel" };
		const request = params as {
			mode?: unknown;
			sessionId?: unknown;
			message?: unknown;
			requestedSchema?: { properties?: Record<string, unknown> };
		};
		if (request.mode !== "form") return { action: "cancel" };
		const sessionId = typeof request.sessionId === "string" ? request.sessionId : "";
		if (!sessionId || !this.runningById.has(sessionId)) return { action: "cancel" };

		const message = typeof request.message === "string" && request.message.trim()
			? request.message.trim()
			: "Choose";
		const properties = request.requestedSchema?.properties ?? {};
		const valueProperty = properties.value as {
			type?: unknown;
			enum?: unknown;
			oneOf?: unknown;
			description?: unknown;
			default?: unknown;
		} | undefined;
		if (!valueProperty || typeof valueProperty !== "object") return { action: "cancel" };

		const uiId = randomUUID();
		let value: string | undefined;
		if (Array.isArray(valueProperty.oneOf) || Array.isArray(valueProperty.enum)) {
			const options = Array.isArray(valueProperty.oneOf)
				? valueProperty.oneOf
					.map((option) => {
						if (!option || typeof option !== "object") return "";
						const typed = option as { const?: unknown; title?: unknown };
						return typeof typed.title === "string" ? typed.title : typeof typed.const === "string" ? typed.const : "";
					})
					.filter(Boolean)
				: (valueProperty.enum as unknown[])
					.map((option) => typeof option === "string" ? option : "")
					.filter(Boolean);
			if (options.length === 0) return { action: "cancel" };
			value = await this.waitForUiPrompt(sessionId, { type: "ui_select", uiId, title: message, options });
		} else if (valueProperty.type === "boolean") {
			const result = await this.waitForUiPrompt(sessionId, {
				type: "ui_confirm",
				uiId,
				title: message,
				message: typeof valueProperty.description === "string" ? valueProperty.description : "",
			});
			if (result === undefined) return { action: "cancel" };
			return { action: "accept", content: { value: result === "true" } };
		} else {
			value = await this.waitForUiPrompt(sessionId, {
				type: "ui_input",
				uiId,
				title: message,
				placeholder: typeof valueProperty.description === "string"
					? valueProperty.description
					: typeof valueProperty.default === "string" ? valueProperty.default : undefined,
			});
		}

		if (value === undefined) return { action: "cancel" };
		if (valueProperty.type === "integer") {
			const parsed = Number.parseInt(value, 10);
			return Number.isFinite(parsed) ? { action: "accept", content: { value: parsed } } : { action: "cancel" };
		}
		if (valueProperty.type === "number") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? { action: "accept", content: { value: parsed } } : { action: "cancel" };
		}
		return { action: "accept", content: { value } };
	}

	private createWebUIContext(sessionId: string): any {
		const self = this;
		return {
			async select(title: string, options: string[]): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_select", uiId, title, options };
				return self.waitForUiPrompt(sessionId, event);
			},
			async confirm(title: string, message: string): Promise<boolean> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_confirm", uiId, title, message };
				const result = await self.waitForUiPrompt(sessionId, event);
				return result === "true";
			},
			async input(title: string, placeholder?: string): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_input", uiId, title, placeholder };
				return self.waitForUiPrompt(sessionId, event);
			},
			notify(message: string, type?: "info" | "warning" | "error") {
				self.broadcast(sessionId, { type: "ui_notify", message, level: type ?? "info" });
			},
			onTerminalInput: () => () => {},
			setStatus() {},
			setWorkingMessage() {},
			setHiddenThinkingLabel() {},
			setWidget() {},
			setFooter() {},
			setHeader() {},
			setTitle() {},
			async editor(title: string, defaultValue?: string): Promise<string | undefined> {
				const uiId = randomUUID();
				const event: PendingUiPromptEvent = { type: "ui_input", uiId, title, placeholder: defaultValue };
				return self.waitForUiPrompt(sessionId, event);
			},
			async custom(title: string, options: Array<{ label: string; value: unknown } | string>) {
				// Fallback for clarify dialogs and other custom UIs — use the working select UI
				if (!options?.length) return undefined;
				const labels = options.map((o) => (typeof o === "string" ? o : o.label));
				const selected = await this.select(title || "Choose", labels);
				if (selected === undefined) return undefined;
					// Map back to the original option object for OMP custom UI callers that expect it.
				const idx = labels.indexOf(selected);
				return options[idx];
			},
			pasteToEditor() {},
			setEditorText() {},
			getEditorText: () => "",
			setEditorComponent() {},
			get theme(): any { return undefined; },
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }),
			getToolsExpanded: () => false,
			setToolsExpanded() {},
		};
	}

	private authStoragePromise = AuthStorage.create();
	private modelRegistryPromise = this.authStoragePromise.then((auth) => new ModelRegistry(auth));

	private async getAuthStorage(): Promise<any> {
		return this.authStoragePromise;
	}

	private async getModelRegistry(): Promise<any> {
		return this.modelRegistryPromise;
	}
	private archiveStorePath = join(homedir(), ".pi", "agent", "pi-web", "archive.json");
	private archivedSessionIds = new Set<string>();
	private repoStorePath = join(homedir(), ".pi", "agent", "pi-web", "repos.json");

	private async saveArchiveToDisk(): Promise<void> {
		try {
			await mkdir(dirname(this.archiveStorePath), { recursive: true });
			await writeFile(this.archiveStorePath, JSON.stringify([...this.archivedSessionIds], null, 2), "utf8");
		} catch (err) {
			console.error("Failed to save archive list to disk:", err);
		}
	}

	async archiveSession(sessionId: string, archived: boolean): Promise<{ archived: boolean }> {
		if (archived) {
			this.archivedSessionIds.add(sessionId);
		} else {
			this.archivedSessionIds.delete(sessionId);
		}
		await this.saveArchiveToDisk();
		return { archived };
	}

	private async loadReposFromDisk(): Promise<string[]> {
		try {
			const raw = await readFile(this.repoStorePath, "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((p) => typeof p === "string").map((p) => p.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	private async saveReposToDisk(repos: string[]): Promise<void> {
		const dir = dirname(this.repoStorePath);
		mkdirSync(dir, { recursive: true });
		const payload = JSON.stringify(repos, null, 2);
		await writeFile(this.repoStorePath, payload, "utf8");
	}

	async listRepos(): Promise<string[]> {
		const repos = new Set<string>();

		for (const repo of await this.loadReposFromDisk()) {
			repos.add(repo);
		}

		const saved = await SessionManager.listAll().catch(() => []);
		for (const entry of saved) {
			if (typeof entry.cwd === "string" && entry.cwd.trim()) {
				repos.add(entry.cwd.trim());
			}
		}

		for (const runtime of this.runningById.values()) {
			if (runtime.cwd.trim()) repos.add(runtime.cwd.trim());
		}

		// Only return directories that exist on this machine
		return [...repos].filter(r => existsSync(r)).sort((a, b) => a.localeCompare(b));
	}

	async addRepo(rawCwd: string): Promise<void> {
		const cwd = normalizeCwd(rawCwd);
		await ensureDirectory(cwd);

		const repos = new Set(await this.loadReposFromDisk());
		repos.add(cwd);
		await this.saveReposToDisk([...repos].sort((a, b) => a.localeCompare(b)));
	}

	listActiveSessions(): ApiSessionSummary[] {
		const sessions: ApiSessionSummary[] = [];
		for (const runtime of this.runningById.values()) {
			sessions.push({
				id: runtime.session.sessionId,
				path: runtime.sessionFile && existsSync(runtime.sessionFile) ? runtime.sessionFile : null,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				firstMessage: computeFirstMessage(runtime.session.messages),
				created: toIso(runtime.createdAtMs),
				modified: toIso(runtime.modifiedAtMs),
				messageCount: runtime.session.messages.length,
				isRunning: true,
				isStreaming: runtime.session.isStreaming ?? false,
				startAgent: runtime.startAgent,
			});
		}
		sessions.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	async listSessions(): Promise<ApiSessionSummary[]> {
		const saved = await SessionManager.listAll().catch(() => []);
		const byId = new Map<string, ApiSessionSummary>();

		for (const entry of saved) {
			const summary = serializeSessionSummary(entry);
			summary.isRunning = this.runningByPath.has(entry.path);
			if (summary.isRunning) {
				const runtimeId = this.runningByPath.get(entry.path);
				const runtime = runtimeId ? this.runningById.get(runtimeId) : null;
				summary.startAgent = runtime?.startAgent;
			}
			byId.set(summary.id, summary);
		}

		for (const [sessionId, runtime] of this.runningById.entries()) {
			// If the saved list already contains this session id, just mark it running and move on.
			const existing = byId.get(sessionId);
			if (existing) {
				existing.isRunning = true;
				existing.modified = toIso(runtime.modifiedAtMs);
				existing.messageCount = runtime.session.messages.length;
				existing.startAgent = runtime.startAgent;
				continue;
			}

			// Running session may not have flushed to disk yet (no assistant message).
			const path = runtime.sessionFile;
			const createdAt = runtime.createdAtMs;
			const modifiedAt = runtime.modifiedAtMs;
			byId.set(sessionId, {
				id: sessionId,
				path: path && existsSync(path) ? path : null,
				cwd: runtime.cwd,
				name: runtime.session.sessionName,
				firstMessage: computeFirstMessage(runtime.session.messages),
				created: toIso(createdAt),
				modified: toIso(modifiedAt),
				messageCount: runtime.session.messages.length,
				isRunning: true,
				startAgent: runtime.startAgent,
			});
		}

		for (const summary of byId.values()) {
			summary.archived = this.archivedSessionIds.has(summary.id);
		}

		const sessions = [...byId.values()]
			.filter(s => s.isRunning || existsSync(s.cwd))  // hide sessions from non-existent dirs
			.sort((a, b) => b.modified.localeCompare(a.modified));
		return sessions;
	}

	async listModels(): Promise<ApiModelInfo[]> {
		// Use the session's model registry if available — it includes models
		// registered by extensions via pi.registerProvider().
		// Fall back to the standalone registry for the model picker before any session.
		let registry = await this.getModelRegistry();
		for (const runtime of this.runningById.values()) {
			if (runtime.session.modelRegistry) {
				registry = runtime.session.modelRegistry;
				break;
			}
		}

		try {
			const auth = await this.getAuthStorage();
			await auth.reload();
		} catch {}
		try {
			await registry.refresh();
		} catch {}

		const available = registry.getAvailable();
		return available.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	}

	getSessionState(sessionId: string, includeFullHistory = false, messageLimit = 0): ApiSessionState {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const state = buildRuntimeState(runtime, includeFullHistory, messageLimit);
		state.pendingUiPromptIds = [...this.pendingUiPrompts.entries()]
			.filter(([, pending]) => pending.sessionId === sessionId)
			.map(([uiId]) => uiId);
		return state;
	}

	getSessionTree(sessionId: string): ApiSessionTreeResponse {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		const leafId = runtime.session.sessionManager.getLeafId();
		const activePathIds = new Set<string>();
		for (const entry of runtime.session.sessionManager.getBranch()) {
			if (entry?.id) activePathIds.add(entry.id);
		}

		const entries: ApiSessionTreeEntry[] = [];
		flattenSessionTree(runtime.session.sessionManager.getTree() as Array<any>, 0, leafId, activePathIds, entries);
		return { leafId, entries };
	}

	async navigateTree(sessionId: string, request: ApiNavigateTreeRequest): Promise<ApiNavigateTreeResponse> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) throw new Error("session_not_running");
		const clientId = typeof request.clientId === "string" ? request.clientId.trim() : "";
		if (!clientId) throw new Error("missing_client_id");
		this.assertController(runtime, clientId);
		if (runtime.session.isStreaming) throw new Error("cannot_tree_while_streaming");

		const targetId = typeof request.targetId === "string" ? request.targetId.trim() : "";
		if (!targetId) throw new Error("missing_target_id");

		const result = await runtime.session.navigateTree(targetId, {
			summarize: Boolean(request.summarize),
			customInstructions:
				typeof request.customInstructions === "string" && request.customInstructions.trim().length > 0
					? request.customInstructions.trim()
					: undefined,
			replaceInstructions: Boolean(request.replaceInstructions),
			label: typeof request.label === "string" && request.label.trim().length > 0 ? request.label.trim() : undefined,
		});
		runtime.modifiedAtMs = Date.now();
		return {
			cancelled: Boolean(result.cancelled),
			aborted: Boolean(result.aborted),
			editorText: typeof result.editorText === "string" ? result.editorText : undefined,
		};
	}

	async forkSession(sessionId: string, request: ApiForkSessionRequest): Promise<ApiForkSessionResponse> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) throw new Error("session_not_running");
		const clientId = typeof request.clientId === "string" ? request.clientId.trim() : "";
		if (!clientId) throw new Error("missing_client_id");
		this.assertController(runtime, clientId);
		if (runtime.session.isStreaming) throw new Error("cannot_fork_while_streaming");

		const entryId = typeof request.entryId === "string" ? request.entryId.trim() : "";
		if (!entryId) throw new Error("missing_entry_id");

		const runner = runtime.session.extensionRunner;
		if (runner?.hasHandlers("session_before_fork")) {
			const before = await runner.emit({ type: "session_before_fork", entryId });
			if (before?.cancel) return { cancelled: true };
		}

		const selectedEntry = runtime.session.sessionManager.getEntry(entryId) as any;
		if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message?.role !== "user") {
			throw new Error("invalid_fork_entry");
		}

		if (!runtime.session.sessionManager.isPersisted()) {
			throw new Error("fork_requires_persisted_session");
		}

		const currentSessionFile = runtime.session.sessionFile;
		if (!currentSessionFile) {
			throw new Error("missing_session_file");
		}

		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const selectedText = extractTextContent(selectedEntry.message?.content);
		let forkedSessionPath: string | undefined;

		if (!selectedEntry.parentId) {
			const sessionManager = SessionManager.create(runtime.cwd, sessionDir);
			sessionManager.newSession({ parentSession: currentSessionFile });
			forkedSessionPath = sessionManager.getSessionFile();
		} else {
			const sourceManager = await openSessionManagerFast(currentSessionFile, sessionDir);
			forkedSessionPath = sourceManager.createBranchedSession(selectedEntry.parentId);
		}

		if (!forkedSessionPath) {
			throw new Error("failed_to_create_forked_session");
		}

		const started = await this.startSession({ clientId, resumeSessionPath: forkedSessionPath });
		return {
			cancelled: false,
			sessionId: started.sessionId,
			selectedText: selectedText || undefined,
		};
	}

	getSessionRole(sessionId: string, clientId: string): { role: ClientRole; controllerClientId: string | null } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		const controllerClientId = runtime.controllerClientId;
		const role: ClientRole = controllerClientId === clientId ? "controller" : "viewer";
		return { role, controllerClientId };
	}

	addClient(sessionId: string, client: SessionClient): { role: ClientRole; controllerClientId: string | null } {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		runtime.clients.set(client.connectionId, client);
		return this.getSessionRole(sessionId, client.clientId);
	}

	removeClient(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.clients.delete(connectionId);
	}

	addTerminalClient(sessionId: string, client: SessionTerminalClient): ApiTerminalServerMessage {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		return runtime.terminalManager.addClient(client);
	}

	addGlobalTerminalClient(client: TerminalClient): ApiTerminalServerMessage {
		return this.globalTerminalManager.addClient(client);
	}

	removeGlobalTerminalClient(connectionId: string): void {
		this.globalTerminalManager.removeClient(connectionId);
	}

	handleGlobalTerminalClientMessage(connectionId: string, message: ApiTerminalClientMessage): void {
		this.globalTerminalManager.handleMessage(connectionId, message);
	}

	removeTerminalClient(sessionId: string, connectionId: string): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		runtime.terminalManager.removeClient(connectionId);
	}

	handleTerminalClientMessage(sessionId: string, connectionId: string, message: ApiTerminalClientMessage): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		runtime.terminalManager.handleMessage(connectionId, message);
	}

	async startSession(request: ApiCreateSessionRequest): Promise<{ sessionId: string }> {
		const clientId = request.clientId ?? randomUUID();

		if (request.resumeSessionPath) {
			const path = request.resumeSessionPath;
			const existingId = this.runningByPath.get(path);
			if (existingId) {
				const existing = this.runningById.get(existingId);
				if (existing && existing.controllerClientId === null) {
					existing.controllerClientId = clientId;
					this.broadcast(existingId, { type: "controller_changed", controllerClientId: clientId });
				}
				return { sessionId: existingId };
			}

			if (!existsSync(path)) {
				throw new Error(`session file does not exist: ${path}`);
			}

			const sessionManager = await openSessionManagerFast(path);
			const cwd = sessionManager.getCwd();
			const { session, startAgentConfig, setToolUIContext } = await createSessionWithWorktreeGuard({
				cwd,
				sessionManager,
				authStorage: await this.getAuthStorage(),
				modelRegistry: await this.getModelRegistry(),
				startAgent: request.startAgent,
			});
			const acp = await this.createAcpBridge(session, cwd, request.startAgent);
			const runtime = this.registerSession(session, cwd, clientId, startAgentConfig, acp);
			this.bindSessionUi(session, setToolUIContext);
			return { sessionId: runtime.session.sessionId };
		}

		const cwd = request.cwd ?? process.cwd();
		await ensureDirectory(cwd);

		// If there's already a running session in this cwd and forceNew is not set, reuse it
		if (!request.forceNew) {
			for (const [existingId, existing] of this.runningById.entries()) {
				if (existing.cwd === cwd) {
					if (existing.controllerClientId === null) {
						existing.controllerClientId = clientId;
						this.broadcast(existingId, { type: "controller_changed", controllerClientId: clientId });
					}
					return { sessionId: existingId };
				}
			}
		}

		const sessionManager = SessionManager.create(cwd);
		const { session, startAgentConfig, setToolUIContext } = await createSessionWithWorktreeGuard({
			cwd,
			sessionManager,
			authStorage: await this.getAuthStorage(),
			modelRegistry: await this.getModelRegistry(),
			startAgent: request.startAgent,
		});
		const acp = await this.createAcpBridge(session, cwd, request.startAgent);
		const runtime = this.registerSession(session, cwd, clientId, startAgentConfig, acp);
		this.bindSessionUi(session, setToolUIContext);
		return { sessionId: runtime.session.sessionId };
	}

	async handleCommand(sessionId: string, command: ApiCommandRequest): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}

		if (command.type === "abort") {
			this.cancelPendingDialogsForSession(sessionId, "aborted");
			await runtime.acp.client.cancel({ sessionId });
			return;
		}

		if (command.type === "ui_response") {
			this.assertController(runtime, command.clientId);
			const uiId = typeof command.uiId === "string" ? command.uiId.trim() : "";
			if (!uiId) throw new Error("missing_ui_id");
			if (!this.resolveUiPrompt(sessionId, uiId, Boolean(command.cancelled), command.value)) {
				throw new Error("ui_prompt_not_pending");
			}
			return;
		}

		if (command.type === "compact") {
			this.assertController(runtime, command.clientId);
			const customInstructions =
				typeof command.customInstructions === "string" && command.customInstructions.trim().length > 0
					? command.customInstructions.trim()
					: undefined;
			await runtime.session.compact(customInstructions);
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		if (command.type === "bash") {
			this.assertController(runtime, command.clientId);
			const bashCommand = typeof command.command === "string" ? command.command.trim() : "";
			if (!bashCommand) return;
			// Keep directory handling in-session (via sessionManager cwd) rather than injecting
			// a textual `cd` prefix, which can break shell syntax/quoting.
			await runtime.session.executeBash(bashCommand, undefined, {
				excludeFromContext: Boolean(command.excludeFromContext),
			});
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		if (command.type === "abort_bash") {
			this.assertController(runtime, command.clientId);
			runtime.session.abortBash();
			return;
		}

		if (command.type === "prompt") {
			this.assertController(runtime, command.clientId);
			const text = typeof command.text === "string" ? command.text.trim() : "";
			const images = Array.isArray(command.images)
				? command.images
					.filter((img) => img && typeof img === "object")
					.map((img) => ({
						type: "image" as const,
						data: typeof (img as { data?: unknown }).data === "string" ? (img as { data: string }).data : "",
						mimeType: typeof (img as { mimeType?: unknown }).mimeType === "string" ? (img as { mimeType: string }).mimeType : "",
					}))
					.filter((img) => img.data.length > 0 && img.mimeType.startsWith("image/"))
					.slice(0, 12)
				: [];
			const totalImageChars = images.reduce((sum, img) => sum + img.data.length, 0);
			if (images.some((img) => img.data.length > 6_000_000) || totalImageChars > 24_000_000) {
				throw new Error("image_too_large");
			}
			if (text.length === 0 && images.length === 0) return;

			if (isSessionCustomSlashCommand(runtime.session, text)) {
				const promptOptions = images.length > 0 ? { images } : undefined;
				const wasStreaming = runtime.session.isStreaming;
				await runtime.session.prompt(
					text,
					wasStreaming
						? { ...(promptOptions ?? {}), streamingBehavior: command.deliverAs ?? "steer" }
						: promptOptions,
				);
				if (!runtime.session.isStreaming) {
					this.broadcast(runtime.session.sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
				}
				return;
			}

			const prompt = [
				...(text.length > 0 ? [{ type: "text" as const, text }] : []),
				...images,
			];
			await runtime.acp.client.prompt({ sessionId, prompt, messageId: randomUUID() } as any);
			// If prompt returned without starting an agent run (e.g. extension
			// commands), broadcast a state patch so the frontend can update.
			if (!runtime.session.isStreaming) {
				this.broadcast(runtime.session.sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			}
			return;
		}

		if (command.type === "set_model") {
			this.assertController(runtime, command.clientId);
			const provider = command.provider.trim();
			const modelId = command.modelId.trim();
			if (!provider || !modelId) throw new Error("invalid_model");

			await runtime.acp.client.unstable_setSessionModel({ sessionId, modelId: `${provider}/${modelId}` });
			runtime.acp.state.models = {
				availableModels: runtime.acp.state.models?.availableModels ?? [],
				currentModelId: `${provider}/${modelId}`,
			};
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		if (command.type === "set_thinking_level") {
			this.assertController(runtime, command.clientId);
			const level = command.level.trim();
			const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
			if (!allowed.includes(level)) throw new Error(`invalid_thinking_level: ${level}`);
			runtime.session.setThinkingLevel(level as ThinkingLevel);
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		if (command.type === "set_steering_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_steering_mode: ${String(mode)}`);
			runtime.session.setSteeringMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		if (command.type === "set_follow_up_mode") {
			this.assertController(runtime, command.clientId);
			const mode = command.mode;
			if (mode !== "all" && mode !== "one-at-a-time") throw new Error(`invalid_follow_up_mode: ${String(mode)}`);
			runtime.session.setFollowUpMode(mode);
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		if (command.type === "set_session_name") {
			this.assertController(runtime, command.clientId);
			const name = command.name.trim();
			if (!name) throw new Error("invalid_session_name");
			runtime.session.setSessionName(name);
			this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			return;
		}

		throw new Error(`unknown_command: ${String((command as { type?: unknown }).type)}`);
	}

	takeover(sessionId: string, request: { clientId: string }): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		runtime.controllerClientId = request.clientId;
		this.broadcast(sessionId, { type: "controller_changed", controllerClientId: request.clientId });
		this.replayPendingDialogsToController(sessionId);
	}

	async release(sessionId: string, request: { clientId: string }): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) {
			throw new Error("session_not_running");
		}
		this.assertController(runtime, request.clientId);

		this.broadcast(sessionId, { type: "released", byClientId: request.clientId });
		this.cancelPendingDialogsForSession(sessionId, "released");

		for (const client of runtime.clients.values()) {
			client.close();
		}
		runtime.terminalManager.dispose();

		try {
			await runtime.acp.client.cancel({ sessionId });
		} catch {
			// best effort
		}
		try {
			runtime.session.dispose();
		} catch {
			// best effort
		}

		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;

		this.broadcast(sessionId, { type: "released", byClientId: "system" });
		this.cancelPendingDialogsForSession(sessionId, "released");

		for (const client of runtime.clients.values()) {
			client.close();
		}
		runtime.terminalManager.dispose();

		try { await runtime.acp.client.cancel({ sessionId }); } catch {}
		try { runtime.session.dispose(); } catch {}

		this.runningById.delete(sessionId);
		if (runtime.sessionFile) {
			this.runningByPath.delete(runtime.sessionFile);
		}
	}

	async deleteSession(sessionPath: string): Promise<void> {
		// Stop if running
		const runningId = this.runningByPath.get(sessionPath);
		if (runningId) {
			await this.stopSession(runningId);
		}

		// Delete session file from disk
		const { unlink } = await import("node:fs/promises");
		try {
			await unlink(sessionPath);
		} catch {
			// file might not exist
		}
	}

	private registerSession(session: AgentSession, cwd: string, controllerClientId: string, startAgentConfig: ResolvedStartAgentConfig | null, acp: AcpRuntimeBridge): RunningSession {
		const sessionId = session.sessionId;
		const sessionFile = session.sessionFile ?? null;

		if (sessionFile) {
			const existingId = this.runningByPath.get(sessionFile);
			if (existingId) {
				throw new Error("session_already_running");
			}
		}

		const createdAtMs = Date.now();
		const runtime: RunningSession = {
			session,
			cwd,
			sessionFile,
			createdAtMs,
			modifiedAtMs: createdAtMs,
			controllerClientId,
			clients: new Map(),
			terminalManager: new SessionTerminalManager({
				sessionId,
				cwd,
				canWrite: (clientId) => runtime.controllerClientId === clientId,
			}),
			unsubscribe: null,
			lastAssistantMessageText: "",
			startAgent: startAgentConfig?.name,
			acp,
		};

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			runtime.modifiedAtMs = Date.now();
			this.broadcast(sessionId, { type: "agent_event", event });

			if (event.type === "agent_start") {
				runtime.lastAssistantMessageText = "";
			}

			if (event.type === "message_end" && (event as any)?.message?.role === "assistant") {
				const messageText = extractTextContent((event as any)?.message?.content).trim();
				if (messageText) {
					runtime.lastAssistantMessageText = messageText;
				}
			}

			if (event.type === "agent_end") {
				const messageText = runtime.lastAssistantMessageText || extractLastAssistantText((event as any)?.messages);
				runtime.lastAssistantMessageText = "";
				if (messageText && this.onMessageNotification) {
					void this.onMessageNotification({
						sessionId,
						sessionName: session.sessionName,
						cwd,
						messageRole: "assistant",
						messageText,
					});
				}
			}

			if (event.type === "agent_end" || event.type === "compaction_end") {
				this.broadcast(sessionId, { type: "state_patch", patch: buildRuntimePatch(runtime) });
			}
		});
		runtime.unsubscribe = unsubscribe;

		this.runningById.set(sessionId, runtime);
		if (sessionFile) {
			this.runningByPath.set(sessionFile, sessionId);
		}

		return runtime;
	}

	private assertController(runtime: RunningSession, clientId: string): void {
		if (runtime.controllerClientId !== clientId) {
			throw new Error("not_controller");
		}
	}

	private broadcast(sessionId: string, event: SseEvent): void {
		const runtime = this.runningById.get(sessionId);
		if (!runtime) return;
		for (const client of runtime.clients.values()) {
			try {
				client.send(event);
			} catch {
				// ignore broken clients
			}
		}
	}

	// ── Worktree management ────────────────────────────────────────

	private async gitExec(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
		const { execFile } = await import("node:child_process");
		return new Promise((resolve) => {
			execFile("git", args, { cwd, timeout: 15_000 }, (err, stdout) => {
				const code = err && typeof (err as any).code === "number" ? (err as any).code : (err ? 1 : 0);
				resolve({ stdout: (stdout || "").trim(), exitCode: code });
			});
		});
	}

	private async getRepoRoot(cwd: string): Promise<string | null> {
		const { stdout: toplevel, exitCode } = await this.gitExec(cwd, ["rev-parse", "--show-toplevel"]);
		if (exitCode !== 0 || !toplevel) return null;
		// --git-common-dir returns the shared .git dir; for worktrees it points to the main repo's .git
		const { stdout: commonDir } = await this.gitExec(toplevel, ["rev-parse", "--git-common-dir"]);
		if (commonDir && commonDir !== ".git") {
			// Resolve to absolute path
			const absCommon = resolve(toplevel, commonDir);
			const mainRoot = resolve(absCommon, "..");
			if (mainRoot !== toplevel && existsSync(mainRoot)) return mainRoot;
		}
		return toplevel;
	}

	private async getCurrentBranch(repoRoot: string): Promise<string> {
		const { stdout } = await this.gitExec(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
		return stdout || "HEAD";
	}

	async listWorktrees(): Promise<Array<{ name: string; path: string; branch: string; repoRoot: string; repoName: string; hasChanges: boolean; aheadCount: number; isRunning: boolean }>> {
		const repos = await this.listRepos();
		const results: Array<{ name: string; path: string; branch: string; repoRoot: string; repoName: string; hasChanges: boolean; aheadCount: number; isRunning: boolean }> = [];

		// Also include cwds from running sessions to catch repos not in the saved list
		const allPaths = new Set(repos);
		for (const runtime of this.runningById.values()) {
			if (runtime.cwd) allPaths.add(runtime.cwd);
		}

		const scannedRoots = new Set<string>();
		for (const repo of allPaths) {
			const repoRoot = await this.getRepoRoot(repo);
			if (!repoRoot || scannedRoots.has(repoRoot)) continue;
			scannedRoots.add(repoRoot);
			const wtDir = join(repoRoot, ".worktrees");
			if (!existsSync(wtDir)) continue;

			const { readdir } = await import("node:fs/promises");
			let entries: string[];
			try { entries = await readdir(wtDir); } catch { continue; }

			for (const entry of entries) {
				if (!entry.startsWith("worktree-")) continue;
				const wtPath = join(wtDir, entry);
				if (!existsSync(join(wtPath, ".git"))) continue;

				const name = entry.replace(/^worktree-/, "");
				const { stdout: statusOut } = await this.gitExec(wtPath, ["status", "--porcelain"]);
				const hasChanges = Boolean(statusOut);

				const baseBranch = await this.getCurrentBranch(repoRoot);
				const { stdout: aheadStr } = await this.gitExec(wtPath, ["rev-list", "HEAD", "--not", baseBranch, "--count"]);
				const aheadCount = parseInt(aheadStr, 10) || 0;

				let isRunning = false;
				for (const runtime of this.runningById.values()) {
					if (runtime.cwd === wtPath) { isRunning = true; break; }
				}

				results.push({ name, path: wtPath, branch: entry, repoRoot, repoName: basename(repoRoot), hasChanges, aheadCount, isRunning });
			}
		}
		return results;
	}

	async createWorktree(request: { repoPath: string; name: string; baseBranch?: string; clientId: string; startAgent?: string }): Promise<{ sessionId: string; worktreePath: string }> {
		const repoRoot = await this.getRepoRoot(request.repoPath);
		if (!repoRoot) throw new Error("not_a_git_repo");

		const name = request.name.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
		if (!name) throw new Error("invalid_worktree_name");

		const branch = `worktree-${name}`;
		const wtDir = join(repoRoot, ".worktrees");
		const wtPath = join(wtDir, branch);

		if (existsSync(wtPath)) throw new Error("worktree_already_exists");

		const { mkdirSync } = await import("node:fs");
		mkdirSync(wtDir, { recursive: true });

		const base = request.baseBranch?.trim() || "HEAD";
		const { stdout: branchCheck } = await this.gitExec(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
		if (!branchCheck) {
			const { exitCode } = await this.gitExec(repoRoot, ["branch", branch, base]);
			if (exitCode !== 0) throw new Error("failed_to_create_branch");
		}

		const { exitCode: wtResult } = await this.gitExec(repoRoot, ["worktree", "add", wtPath, branch]);
		if (wtResult !== 0 && !existsSync(join(wtPath, ".git"))) {
			await this.gitExec(repoRoot, ["worktree", "prune"]);
			const { exitCode: retry } = await this.gitExec(repoRoot, ["worktree", "add", wtPath, branch]);
			if (retry !== 0 && !existsSync(join(wtPath, ".git"))) throw new Error("failed_to_create_worktree");
		}

		const result = await this.startSession({ clientId: request.clientId, cwd: wtPath, startAgent: request.startAgent });
		return { sessionId: result.sessionId, worktreePath: wtPath };
	}

	async mergeWorktree(request: { worktreePath: string; targetBranch?: string }): Promise<{ merged: boolean; message: string }> {
		const wtPath = request.worktreePath;
		if (!existsSync(join(wtPath, ".git"))) throw new Error("not_a_worktree");

		const repoRoot = await this.getRepoRoot(wtPath);
		if (!repoRoot) throw new Error("cannot_resolve_repo");

		const { stdout: wtBranch } = await this.gitExec(wtPath, ["symbolic-ref", "--short", "HEAD"]);
		if (!wtBranch) throw new Error("cannot_resolve_branch");

		const { stdout: statusOut } = await this.gitExec(wtPath, ["status", "--porcelain"]);
		if (statusOut) {
			await this.gitExec(wtPath, ["add", "-A"]);
			await this.gitExec(wtPath, ["commit", "-m", `worktree ${wtBranch}: auto-commit before merge`]);
		}

		const target = request.targetBranch?.trim() || await this.getCurrentBranch(repoRoot);
		const { exitCode, stdout: mergeOut } = await this.gitExec(repoRoot, ["merge", wtBranch, "-m", `Merge worktree ${wtBranch} into ${target}`]);
		if (exitCode !== 0) {
			return { merged: false, message: `Merge conflict or failure. Resolve manually in ${repoRoot}.` };
		}
		return { merged: true, message: mergeOut || "Merge successful." };
	}

	async deleteWorktree(wtPath: string): Promise<void> {
		if (!existsSync(wtPath)) return;
		const repoRoot = await this.getRepoRoot(wtPath);
		if (!repoRoot) return;

		for (const [sessionId, runtime] of this.runningById.entries()) {
			if (runtime.cwd === wtPath) { await this.stopSession(sessionId); break; }
		}

		const { stdout: wtBranch } = await this.gitExec(wtPath, ["symbolic-ref", "--short", "HEAD"]);
		await this.gitExec(repoRoot, ["worktree", "remove", wtPath, "--force"]);
		if (wtBranch) await this.gitExec(repoRoot, ["branch", "-D", wtBranch]);
	}

	async autoCleanupWorktree(wtPath: string): Promise<boolean> {
		if (!existsSync(wtPath)) return false;
		const { stdout: statusOut } = await this.gitExec(wtPath, ["status", "--porcelain"]);
		if (statusOut) return false;
		const { stdout: untrackedOut } = await this.gitExec(wtPath, ["ls-files", "--others", "--exclude-standard"]);
		if (untrackedOut) return false;
		const repoRoot = await this.getRepoRoot(wtPath);
		if (!repoRoot) return false;
		const baseBranch = await this.getCurrentBranch(repoRoot);
		const { stdout: aheadStr } = await this.gitExec(wtPath, ["rev-list", "HEAD", "--not", baseBranch, "--count"]);
		if ((parseInt(aheadStr, 10) || 0) > 0) return false;
		await this.deleteWorktree(wtPath);
		return true;
	}

	async getWorktreeBranches(repoPath: string): Promise<string[]> {
		const repoRoot = await this.getRepoRoot(repoPath);
		if (!repoRoot) return [];
		const { stdout } = await this.gitExec(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
		if (!stdout) return [];
		return stdout.split("\n").filter(Boolean);
	}

	async isGitRepo(path: string): Promise<boolean> {
		return (await this.getRepoRoot(path)) !== null;
	}
}
