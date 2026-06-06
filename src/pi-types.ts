// Local structural types for omp-mobile.
// Runtime loads the real implementation from the system-installed OMP package.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type Api = string & {};

export interface Model<TApi extends Api = Api> {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: ThinkingLevel;
	[key: string]: unknown;
}

export interface AgentMessage {
	role?: string;
	content?: unknown;
	timestamp?: number;
	[key: string]: unknown;
}

export interface AgentSessionEvent {
	type?: string;
	[key: string]: unknown;
}

export interface AgentSession {
	messages: AgentMessage[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	setThinkingLevel(level: ThinkingLevel): void;
	[key: string]: any;
}

export interface PiAuthStorage {
	[key: string]: unknown;
}

export interface PiDefaultResourceLoader {
	reload(): Promise<void>;
	[key: string]: unknown;
}

export interface PiModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAvailable(): Array<Model<Api>>;
	[key: string]: any;
}

export interface PiSessionManager {
	[key: string]: any;
}
