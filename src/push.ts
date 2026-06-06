import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import webpush from "web-push";

interface StoredPushSubscription extends PushSubscriptionJSON {
	createdAt: string;
	updatedAt: string;
	clientId?: string;
	userAgent?: string;
	platform?: string;
}

interface StoredPushData {
	version: 1;
	vapid: {
		publicKey: string;
		privateKey: string;
		subject: string;
	};
	subscriptions: StoredPushSubscription[];
}

interface ClientActivityState {
	clientId: string;
	sessionId: string | null;
	visible: boolean;
	focused: boolean;
	lastSeenAtMs: number;
	updatedAtMs: number;
}

export interface PushNotificationPayload {
	title: string;
	body: string;
	url?: string;
	sessionId?: string;
	sessionName?: string;
	icon?: string;
	badge?: string;
	tag?: string;
}

export interface PushSubscribeMeta {
	clientId?: string;
	userAgent?: string;
	platform?: string;
}

export interface PushClientActivity {
	clientId: string;
	sessionId?: string | null;
	visible?: boolean;
	focused?: boolean;
}

export interface PushRoutingSubscription {
	endpoint: string;
	clientId?: string;
	updatedAt?: string;
	createdAt?: string;
	platform?: string;
	userAgent?: string;
}

export interface PushRoutingClient {
	clientId: string;
	sessionId?: string | null;
	visible?: boolean;
	focused?: boolean;
	lastSeenAt?: string;
	updatedAt?: string;
	lastSeenAtMs?: number;
	updatedAtMs?: number;
}

export interface PushRoutingDecision {
	targetClientId: string | null;
	targetEndpoint: string | null;
	activeClientId: string | null;
	suppress: boolean;
	reason:
		| "no_subscriptions"
		| "same_session_visible"
		| "active_client"
		| "last_active_client"
		| "mobile_fallback"
		| "latest_subscription_fallback"
		| "no_subscription_for_selected_client";
}

export interface PushSendResult {
	ok: true;
	sent: number;
	failed: number;
	suppressed: boolean;
	targetClientId: string | null;
	reason: PushRoutingDecision["reason"];
}

export const DEFAULT_PUSH_SUBJECT = "mailto:root@localhost";
export const PUSH_ACTIVE_CLIENT_TTL_MS = 15_000;

function safeParse<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function isLoopbackHost(host: string | null | undefined): boolean {
	const normalized = (host || "").trim().toLowerCase();
	if (!normalized) return false;
	return (
		normalized === "localhost" ||
		normalized === "localhost.localdomain" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized.startsWith("127.")
	);
}

function subjectNeedsUpgrade(subject: string | null | undefined): boolean {
	const normalized = typeof subject === "string" ? subject.trim() : "";
	if (!normalized) return true;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol === "mailto:") {
			const mailbox = decodeURIComponent(parsed.pathname || "");
			const atIndex = mailbox.lastIndexOf("@");
			const domain = atIndex >= 0 ? mailbox.slice(atIndex + 1) : "";
			return isLoopbackHost(domain);
		}
		return isLoopbackHost(parsed.hostname);
	} catch {
		return true;
	}
}

function trimTo(value: unknown, maxLen: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, maxLen);
}

function normalizeClientId(value: unknown): string | undefined {
	return trimTo(value, 200);
}

function parseTimestampMs(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function maxTimestampMs(...values: unknown[]): number {
	let best = 0;
	for (const value of values) {
		const ms = parseTimestampMs(value);
		if (ms > best) best = ms;
	}
	return best;
}

export function resolvePushSubject(currentSubject: string | null | undefined, preferredSubject: string | null | undefined): string {
	const current = typeof currentSubject === "string" ? currentSubject.trim() : "";
	const preferred = typeof preferredSubject === "string" ? preferredSubject.trim() : "";
	if (preferred && subjectNeedsUpgrade(current)) return preferred;
	if (current) return current;
	if (preferred) return preferred;
	return DEFAULT_PUSH_SUBJECT;
}

function normalizeSubscription(sub: unknown): PushSubscriptionJSON | null {
	if (!sub || typeof sub !== "object") return null;
	const value = sub as {
		endpoint?: unknown;
		expirationTime?: unknown;
		keys?: { p256dh?: unknown; auth?: unknown };
	};
	if (typeof value.endpoint !== "string" || !value.endpoint) return null;
	if (!value.keys || typeof value.keys !== "object") return null;
	if (typeof value.keys.p256dh !== "string" || typeof value.keys.auth !== "string") return null;
	return {
		endpoint: value.endpoint,
		expirationTime: typeof value.expirationTime === "number" ? value.expirationTime : null,
		keys: {
			p256dh: value.keys.p256dh,
			auth: value.keys.auth,
		},
	};
}

function normalizeStoredSubscription(sub: unknown): StoredPushSubscription | null {
	const normalized = normalizeSubscription(sub);
	if (!normalized) return null;
	const source = (sub && typeof sub === "object") ? (sub as Record<string, unknown>) : {};
	const now = new Date().toISOString();
	const createdAt = typeof source.createdAt === "string" && source.createdAt.trim() ? source.createdAt : now;
	const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim() ? source.updatedAt : createdAt;
	return {
		...normalized,
		createdAt,
		updatedAt,
		...(normalizeClientId(source.clientId) ? { clientId: normalizeClientId(source.clientId) } : {}),
		...(trimTo(source.userAgent, 512) ? { userAgent: trimTo(source.userAgent, 512) } : {}),
		...(trimTo(source.platform, 120) ? { platform: trimTo(source.platform, 120) } : {}),
	};
}

function isMobileSubscription(sub: PushRoutingSubscription): boolean {
	// Apple push endpoints are always mobile (iPhone/iPad)
	if (typeof sub.endpoint === "string" && sub.endpoint.includes("web.push.apple.com")) return true;
	// Check platform metadata
	const platform = (typeof sub.platform === "string" ? sub.platform : "").toLowerCase();
	if (platform.includes("iphone") || platform.includes("ipad") || platform.includes("android")) return true;
	// Check user agent
	const ua = (typeof sub.userAgent === "string" ? sub.userAgent : "").toLowerCase();
	if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("android")) return true;
	return false;
}

function selectMobileSubscription(subscriptions: PushRoutingSubscription[]): PushRoutingSubscription | null {
	const mobile = subscriptions.filter((sub) => isMobileSubscription(sub));
	return selectLatestSubscription(mobile);
}

function selectLatestSubscription(subscriptions: PushRoutingSubscription[]): PushRoutingSubscription | null {
	if (!Array.isArray(subscriptions) || subscriptions.length === 0) return null;
	const ranked = subscriptions
		.filter((sub) => typeof sub?.endpoint === "string" && sub.endpoint)
		.map((sub) => ({
			sub,
			updatedAtMs: maxTimestampMs(sub.updatedAt, sub.createdAt),
		}))
		.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
	return ranked[0]?.sub ?? null;
}

function dedupeClientsByLatest(clients: PushRoutingClient[]): Array<PushRoutingClient & { lastSeenMs: number; updatedMs: number }> {
	const byId = new Map<string, PushRoutingClient & { lastSeenMs: number; updatedMs: number }>();
	for (const client of clients || []) {
		const clientId = normalizeClientId(client?.clientId);
		if (!clientId) continue;
		const normalized = {
			...client,
			clientId,
			lastSeenMs: maxTimestampMs(client.lastSeenAtMs, client.lastSeenAt, client.updatedAtMs, client.updatedAt),
			updatedMs: maxTimestampMs(client.updatedAtMs, client.updatedAt, client.lastSeenAtMs, client.lastSeenAt),
		};
		const existing = byId.get(clientId);
		if (!existing || normalized.lastSeenMs >= existing.lastSeenMs) {
			byId.set(clientId, normalized);
		}
	}
	return [...byId.values()];
}

function isRoutingClientActive(client: PushRoutingClient & { lastSeenMs: number }, nowMs: number): boolean {
	if (!client) return false;
	if (!(client.visible || client.focused)) return false;
	if (client.lastSeenMs <= 0) return false;
	return nowMs - client.lastSeenMs <= PUSH_ACTIVE_CLIENT_TTL_MS;
}

export function resolvePushRoutingDecision(
	input: {
		sessionId?: string;
		subscriptions: PushRoutingSubscription[];
		clients?: PushRoutingClient[];
	},
	nowMs = Date.now(),
): PushRoutingDecision {
	const subscriptions = Array.isArray(input.subscriptions) ? input.subscriptions.filter((sub) => typeof sub?.endpoint === "string" && sub.endpoint) : [];
	if (subscriptions.length === 0) {
		return {
			targetClientId: null,
			targetEndpoint: null,
			activeClientId: null,
			suppress: false,
			reason: "no_subscriptions",
		};
	}

	const clients = dedupeClientsByLatest(Array.isArray(input.clients) ? input.clients : []);
	const latestSubByClientId = new Map<string, PushRoutingSubscription>();
	for (const sub of subscriptions) {
		const clientId = normalizeClientId(sub.clientId);
		if (!clientId) continue;
		const prev = latestSubByClientId.get(clientId);
		const winner = selectLatestSubscription(prev ? [prev, { ...sub, clientId }] : [{ ...sub, clientId }]);
		if (winner) latestSubByClientId.set(clientId, winner);
	}

	const activeClient = clients
		.filter((client) => isRoutingClientActive(client, nowMs))
		.sort((a, b) => b.lastSeenMs - a.lastSeenMs)[0] || null;

	if (activeClient) {
		if (input.sessionId && activeClient.sessionId === input.sessionId) {
			return {
				targetClientId: activeClient.clientId,
				targetEndpoint: null,
				activeClientId: activeClient.clientId,
				suppress: true,
				reason: "same_session_visible",
			};
		}
		const activeSubscription = latestSubByClientId.get(activeClient.clientId) || null;
		return {
			targetClientId: activeClient.clientId,
			targetEndpoint: activeSubscription?.endpoint || null,
			activeClientId: activeClient.clientId,
			suppress: false,
			reason: activeSubscription ? "active_client" : "no_subscription_for_selected_client",
		};
	}

	// No active client — prefer mobile device, then last-active, then latest subscription
	const mobileSubscription = selectMobileSubscription(subscriptions);
	if (mobileSubscription) {
		return {
			targetClientId: normalizeClientId(mobileSubscription.clientId) || null,
			targetEndpoint: mobileSubscription.endpoint,
			activeClientId: null,
			suppress: false,
			reason: "mobile_fallback",
		};
	}

	const lastActiveClient = [...clients].sort((a, b) => b.lastSeenMs - a.lastSeenMs)[0] || null;
	if (lastActiveClient) {
		const lastActiveSubscription = latestSubByClientId.get(lastActiveClient.clientId) || null;
		return {
			targetClientId: lastActiveClient.clientId,
			targetEndpoint: lastActiveSubscription?.endpoint || null,
			activeClientId: null,
			suppress: false,
			reason: lastActiveSubscription ? "last_active_client" : "no_subscription_for_selected_client",
		};
	}

	const fallback = selectLatestSubscription(subscriptions);
	return {
		targetClientId: normalizeClientId(fallback?.clientId) || null,
		targetEndpoint: fallback?.endpoint || null,
		activeClientId: null,
		suppress: false,
		reason: "latest_subscription_fallback",
	};
}

export class PushService {
	private storePath: string;
	private legacyStorePath: string | null;
	private data: StoredPushData | null = null;
	private clientStates = new Map<string, ClientActivityState>();

	constructor(
		storePath = join(homedir(), ".omp", "agent", "omp-mobile", "push.json"),
		legacyStorePath: string | null = join(homedir(), ".pi", "agent", "pi-web", "push.json"),
	) {
		this.storePath = storePath;
		this.legacyStorePath = legacyStorePath;
	}

	async init(preferredSubject?: string | null): Promise<void> {
		const { data, changed } = await this.load(preferredSubject);
		this.data = data;
		webpush.setVapidDetails(this.data.vapid.subject, this.data.vapid.publicKey, this.data.vapid.privateKey);
		if (changed) {
			await this.save();
		}
	}

	getPublicKey(): string {
		if (!this.data) throw new Error("push_not_initialized");
		return this.data.vapid.publicKey;
	}

	async subscribe(subscription: unknown, meta: PushSubscribeMeta = {}): Promise<{ ok: true; count: number }> {
		if (!this.data) throw new Error("push_not_initialized");
		const normalized = normalizeSubscription(subscription);
		if (!normalized) throw new Error("invalid_subscription");

		const clientId = normalizeClientId(meta.clientId);
		const userAgent = trimTo(meta.userAgent, 512);
		const platform = trimTo(meta.platform, 120);
		const now = new Date().toISOString();

		if (clientId) {
			this.data.subscriptions = this.data.subscriptions.filter((sub) => sub.endpoint === normalized.endpoint || sub.clientId !== clientId);
		}

		const existingIdx = this.data.subscriptions.findIndex((sub) => sub.endpoint === normalized.endpoint);
		const entry: StoredPushSubscription = {
			...normalized,
			createdAt: now,
			updatedAt: now,
			...(clientId ? { clientId } : {}),
			...(userAgent ? { userAgent } : {}),
			...(platform ? { platform } : {}),
		};

		if (existingIdx >= 0) {
			const prev = this.data.subscriptions[existingIdx]!;
			this.data.subscriptions[existingIdx] = {
				...prev,
				...entry,
				createdAt: prev.createdAt,
				updatedAt: now,
			};
		} else {
			this.data.subscriptions.push(entry);
		}
		await this.save();
		return { ok: true, count: this.data.subscriptions.length };
	}

	async unsubscribe(endpoint: string): Promise<{ ok: true; count: number }> {
		if (!this.data) throw new Error("push_not_initialized");
		const before = this.data.subscriptions.length;
		this.data.subscriptions = this.data.subscriptions.filter((sub) => sub.endpoint !== endpoint);
		if (this.data.subscriptions.length !== before) {
			await this.save();
		}
		return { ok: true, count: this.data.subscriptions.length };
	}

	updateClientActivity(activity: PushClientActivity): { ok: true; activeClients: number } {
		const clientId = normalizeClientId(activity?.clientId);
		if (!clientId) throw new Error("invalid_client_activity");
		const nowMs = Date.now();
		this.clientStates.set(clientId, {
			clientId,
			sessionId: trimTo(activity.sessionId ?? null, 200) ?? null,
			visible: Boolean(activity.visible),
			focused: Boolean(activity.focused),
			lastSeenAtMs: nowMs,
			updatedAtMs: nowMs,
		});
		this.pruneClientStates(nowMs);
		return { ok: true, activeClients: this.clientStates.size };
	}

	async send(payload: PushNotificationPayload): Promise<PushSendResult> {
		if (!this.data) throw new Error("push_not_initialized");
		if (this.data.subscriptions.length === 0) {
			return { ok: true, sent: 0, failed: 0, suppressed: false, targetClientId: null, reason: "no_subscriptions" };
		}

		const routing = resolvePushRoutingDecision({
			sessionId: payload.sessionId,
			subscriptions: this.data.subscriptions,
			clients: [...this.clientStates.values()].map((state) => ({
				clientId: state.clientId,
				sessionId: state.sessionId,
				visible: state.visible,
				focused: state.focused,
				lastSeenAtMs: state.lastSeenAtMs,
				updatedAtMs: state.updatedAtMs,
			})),
		});

		if (routing.suppress || !routing.targetEndpoint) {
			return {
				ok: true,
				sent: 0,
				failed: 0,
				suppressed: routing.suppress,
				targetClientId: routing.targetClientId,
				reason: routing.reason,
			};
		}

		const targetSubscription = this.data.subscriptions.find((sub) => sub.endpoint === routing.targetEndpoint);
		if (!targetSubscription) {
			return {
				ok: true,
				sent: 0,
				failed: 0,
				suppressed: false,
				targetClientId: routing.targetClientId,
				reason: "no_subscription_for_selected_client",
			};
		}

		const notif = {
			title: payload.title,
			body: payload.body,
			url: payload.url || (payload.sessionId ? `/?session=${encodeURIComponent(payload.sessionId)}` : "/"),
			sessionId: payload.sessionId,
			sessionName: payload.sessionName,
			icon: payload.icon || "/icon-192.png",
			badge: payload.badge || "/apple-touch-icon.png",
			tag: payload.tag || payload.sessionId || "omp-mobile-session",
		};

		let sent = 0;
		let failed = 0;
		try {
			await webpush.sendNotification(targetSubscription as PushSubscriptionJSON, JSON.stringify(notif));
			sent = 1;
		} catch (error: any) {
			const statusCode = Number(error?.statusCode || error?.status || 0);
			const reason = typeof error?.body === "string" ? error.body.slice(0, 100) : error?.message?.slice(0, 100) || "";
			console.error(`[push] send failed: ${statusCode} ${reason}`);
			if (statusCode === 404 || statusCode === 410 || statusCode === 403) {
				this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== targetSubscription.endpoint);
			}
			failed = 1;
		}

		if (sent > 0 || failed > 0) {
			await this.save();
		}
		return {
			ok: true,
			sent,
			failed,
			suppressed: false,
			targetClientId: routing.targetClientId,
			reason: routing.reason,
		};
	}

	private pruneClientStates(nowMs: number): void {
		const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
		for (const [clientId, state] of this.clientStates.entries()) {
			if (state.updatedAtMs < cutoff) this.clientStates.delete(clientId);
		}
	}

	private async load(preferredSubject?: string | null): Promise<{ data: StoredPushData; changed: boolean }> {
		const paths = [this.storePath, this.legacyStorePath].filter((path): path is string => Boolean(path));
		for (const path of paths) {
			try {
				const raw = await readFile(path, "utf8");
				const parsed = safeParse<StoredPushData>(raw);
				if (parsed && parsed.version === 1 && parsed.vapid?.publicKey && parsed.vapid?.privateKey) {
					const subject = resolvePushSubject(parsed.vapid.subject, preferredSubject);
					return {
						data: {
							version: 1,
							vapid: {
								publicKey: parsed.vapid.publicKey,
								privateKey: parsed.vapid.privateKey,
								subject,
							},
							subscriptions: Array.isArray(parsed.subscriptions)
								? parsed.subscriptions.map((sub) => normalizeStoredSubscription(sub)).filter((sub): sub is StoredPushSubscription => Boolean(sub))
								: [],
						},
						changed: path !== this.storePath || subject !== parsed.vapid.subject,
					};
				}
			} catch {
				// try next path
			}
		}

		const vapid = webpush.generateVAPIDKeys();
		return {
			data: {
				version: 1,
				vapid: {
					publicKey: vapid.publicKey,
					privateKey: vapid.privateKey,
					subject: resolvePushSubject(null, preferredSubject),
				},
				subscriptions: [],
			},
			changed: false,
		};
	}

	private async save(): Promise<void> {
		if (!this.data) return;
		mkdirSync(dirname(this.storePath), { recursive: true });
		await writeFile(this.storePath, JSON.stringify(this.data, null, 2), "utf8");
	}
}
