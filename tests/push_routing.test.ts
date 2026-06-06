import { describe, expect, test } from "bun:test";
import { PUSH_ACTIVE_CLIENT_TTL_MS, resolvePushRoutingDecision } from "../src/push.ts";

describe("resolvePushRoutingDecision", () => {
	test("routes to the active client (SW handles foreground suppression)", () => {
		const now = Date.UTC(2026, 3, 3, 10, 0, 0);
		const decision = resolvePushRoutingDecision({
			sessionId: "sess-1",
			subscriptions: [
				{ endpoint: "https://web.push.apple.com/abc", clientId: "phone", platform: "iPhone", updatedAt: new Date(now - 1000).toISOString() },
			],
			clients: [
				{ clientId: "phone", sessionId: "sess-2", visible: true, focused: true, lastSeenAtMs: now },
			],
		}, now);

		expect(decision.reason).toBe("active_client");
		expect(decision.targetEndpoint).toBe("https://web.push.apple.com/abc");
		expect(decision.suppress).toBe(false);
	});

	test("prefers mobile subscription when no client is active", () => {
		const now = Date.UTC(2026, 3, 3, 10, 0, 0);
		const decision = resolvePushRoutingDecision({
			sessionId: "sess-1",
			subscriptions: [
				{ endpoint: "https://web.push.apple.com/abc", clientId: "phone", platform: "iPhone", updatedAt: new Date(now - 5000).toISOString() },
				{ endpoint: "https://fcm.googleapis.com/xyz", clientId: "laptop", platform: "macOS", updatedAt: new Date(now - 500).toISOString() },
			],
			clients: [
				{ clientId: "phone", visible: false, focused: false, lastSeenAtMs: now - PUSH_ACTIVE_CLIENT_TTL_MS - 5000 },
				{ clientId: "laptop", visible: false, focused: false, lastSeenAtMs: now - 1000 },
			],
		}, now);

		expect(decision.reason).toBe("mobile_fallback");
		expect(decision.targetEndpoint).toBe("https://web.push.apple.com/abc");
	});

	test("active laptop wins over backgrounded phone", () => {
		const now = Date.UTC(2026, 3, 3, 10, 0, 0);
		const decision = resolvePushRoutingDecision({
			sessionId: "sess-1",
			subscriptions: [
				{ endpoint: "https://web.push.apple.com/abc", clientId: "phone", platform: "iPhone", updatedAt: new Date(now - 1000).toISOString() },
				{ endpoint: "https://fcm.googleapis.com/xyz", clientId: "laptop", platform: "macOS", updatedAt: new Date(now - 2000).toISOString() },
			],
			clients: [
				{ clientId: "phone", visible: false, focused: false, lastSeenAtMs: now - PUSH_ACTIVE_CLIENT_TTL_MS - 1000 },
				{ clientId: "laptop", visible: true, focused: true, lastSeenAtMs: now },
			],
		}, now);

		expect(decision.reason).toBe("active_client");
		expect(decision.targetClientId).toBe("laptop");
	});

	test("detects mobile from Apple push endpoint even without platform metadata", () => {
		const now = Date.UTC(2026, 3, 3, 10, 0, 0);
		const decision = resolvePushRoutingDecision({
			sessionId: "sess-1",
			subscriptions: [
				{ endpoint: "https://web.push.apple.com/abc", updatedAt: new Date(now - 1000).toISOString() },
				{ endpoint: "https://fcm.googleapis.com/xyz", updatedAt: new Date(now - 500).toISOString() },
			],
			clients: [],
		}, now);

		expect(decision.reason).toBe("mobile_fallback");
		expect(decision.targetEndpoint).toBe("https://web.push.apple.com/abc");
	});

	test("falls back to latest subscription when no mobile and no client activity", () => {
		const now = Date.UTC(2026, 3, 3, 10, 0, 0);
		const decision = resolvePushRoutingDecision({
			sessionId: "sess-5",
			subscriptions: [
				{ endpoint: "https://fcm.googleapis.com/old", platform: "macOS", updatedAt: new Date(now - 10_000).toISOString() },
				{ endpoint: "https://fcm.googleapis.com/new", platform: "macOS", updatedAt: new Date(now - 1000).toISOString() },
			],
			clients: [],
		}, now);

		expect(decision.reason).toBe("latest_subscription_fallback");
		expect(decision.targetEndpoint).toBe("https://fcm.googleapis.com/new");
	});
});
