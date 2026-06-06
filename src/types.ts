import type { AgentMessage, AgentSessionEvent } from "./pi-types.ts";

export type ClientRole = "controller" | "viewer";

export interface ApiModelInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ApiListModelsResponse {
	models: ApiModelInfo[];
}

export interface ApiListReposResponse {
	repos: string[];
}

export interface ApiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ApiSessionCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	executeImmediately?: boolean;
}

export interface ApiAddRepoRequest {
	cwd: string;
}

export interface ApiActiveSessionsResponse {
	sessions: ApiSessionSummary[];
}

export interface ApiErrorResponse {
	error: string;
}

export interface ApiSessionSummary {
	id: string;
	path: string | null;
	cwd: string;
	name?: string;
	startAgent?: string | null;
	firstMessage: string;
	created: string;
	modified: string;
	messageCount: number;
	isRunning: boolean;
	isStreaming?: boolean;
	archived?: boolean;
}

export interface ApiListSessionsResponse {
	sessions: ApiSessionSummary[];
}

export interface ApiCreateSessionRequest {
	clientId?: string;
	cwd?: string;
	resumeSessionPath?: string;
	forceNew?: boolean;
	startAgent?: string;
}

export interface ApiCreateSessionResponse {
	sessionId: string;
}

export interface ApiContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ApiSessionStats {
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

export interface ApiSessionState {
	sessionId: string;
	cwd: string;
	sessionFile: string | null;
	sessionName?: string;
	startAgent?: string | null;
	isStreaming: boolean;
	model: { provider: string; id: string; name?: string } | null;
	thinkingLevel: string;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	stats: ApiSessionStats | null;
	contextUsage: ApiContextUsage | null;
	messages: AgentMessage[];
	commands: ApiSessionCommand[];
	pendingUiPromptIds?: string[];
}

export interface ApiSessionTreeEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
	depth: number;
	type: string;
	role?: string;
	title: string;
	preview: string;
	label?: string;
	labelTimestamp?: string;
	isUserMessage: boolean;
	canFork: boolean;
	isActiveLeaf: boolean;
	isActivePath: boolean;
}

export interface ApiSessionTreeResponse {
	leafId: string | null;
	entries: ApiSessionTreeEntry[];
}

export interface ApiNavigateTreeRequest {
	clientId: string;
	targetId: string;
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface ApiNavigateTreeResponse {
	cancelled: boolean;
	aborted?: boolean;
	editorText?: string;
}

export interface ApiForkSessionRequest {
	clientId: string;
	entryId: string;
}

export interface ApiForkSessionResponse {
	cancelled: boolean;
	sessionId?: string;
	selectedText?: string;
}

export type ApiCommandRequest =
	| { type: "prompt"; clientId: string; text: string; images?: ApiImageContent[]; deliverAs?: "followUp" | "steer" }
	| { type: "bash"; clientId: string; command: string; excludeFromContext?: boolean }
	| { type: "abort_bash"; clientId: string }
	| { type: "compact"; clientId: string; customInstructions?: string }
	| { type: "ui_response"; clientId: string; uiId: string; cancelled?: boolean; value?: string }
	| { type: "abort"; clientId: string }
	| { type: "set_model"; clientId: string; provider: string; modelId: string }
	| { type: "set_thinking_level"; clientId: string; level: string }
	| { type: "set_steering_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_follow_up_mode"; clientId: string; mode: "all" | "one-at-a-time" }
	| { type: "set_session_name"; clientId: string; name: string };

export interface ApiSessionPatch {
	isStreaming?: boolean;
	model?: ApiSessionState["model"];
	thinkingLevel?: string;
	sessionName?: string;
	steeringMode?: ApiSessionState["steeringMode"];
	followUpMode?: ApiSessionState["followUpMode"];
	stats?: ApiSessionState["stats"];
	contextUsage?: ApiSessionState["contextUsage"];
	commands?: ApiSessionCommand[];
}

export interface ApiOkResponse {
	ok: true;
}

export interface ApiTakeoverRequest {
	clientId: string;
}

export interface ApiReleaseRequest {
	clientId: string;
}

export interface ApiTerminalTabState {
	id: string;
	label: string;
	cwd: string;
	shell: string;
	cols: number;
	rows: number;
	status: "running" | "exited";
	startedAt: number;
	exitCode?: number | null;
	signal?: string | number | null;
	history?: string;
	historyTruncated?: boolean;
}

export type ApiTerminalClientMessage =
	| { type: "create_tab"; cols?: number; rows?: number; cwd?: string }
	| { type: "input"; tabId: string; data: string }
	| { type: "resize"; tabId: string; cols: number; rows: number }
	| { type: "close_tab"; tabId: string }
	| { type: "ping" };

export type ApiTerminalServerMessage =
	| { type: "init"; tabs: ApiTerminalTabState[] }
	| { type: "tab_opened"; tab: ApiTerminalTabState }
	| { type: "tab_updated"; tab: ApiTerminalTabState }
	| { type: "tab_output"; tabId: string; data: string }
	| { type: "tab_closed"; tabId: string }
	| { type: "error"; message: string; code?: string; tabId?: string };

export type DialogCloseReason = "aborted" | "released";

export type SseEvent =
	| { type: "ping" }
	| {
			type: "init";
			state: ApiSessionState;
			yourClientId: string;
			controllerClientId: string | null;
			role: ClientRole;
	  }
	| { type: "agent_event"; event: AgentSessionEvent }
	| { type: "state_patch"; patch: ApiSessionPatch }
	| { type: "controller_changed"; controllerClientId: string | null }
	| { type: "released"; byClientId: string }
	| { type: "ui_select"; uiId: string; title: string; options: string[] }
	| { type: "ui_input"; uiId: string; title: string; placeholder?: string }
	| { type: "ui_confirm"; uiId: string; title: string; message: string }
	| { type: "ui_prompt_closed"; uiId: string; reason: DialogCloseReason }
	| { type: "ui_notify"; message: string; level: "info" | "warning" | "error" };
