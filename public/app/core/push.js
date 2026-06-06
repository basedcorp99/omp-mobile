function base64ToUint8Array(base64String) {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const output = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
	return output;
}

function canUsePush() {
	return (
		typeof window !== "undefined" &&
		window.isSecureContext &&
		navigator.serviceWorker &&
		typeof Notification !== "undefined" &&
		"PushManager" in window
	);
}

export function installPushNotifications({ api, btnNotify, lblNotify, onNotice, clientId, getActiveSessionId }) {
	let registration = null;
	let subscribed = false;
	let supported = canUsePush();
	let activityTimer = null;
	let activityTrackingStarted = false;
	let lastActivityKey = "";
	let lastActivitySentAt = 0;
	let windowFocused = typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : true;

	function getSubscriptionMeta() {
		return {
			clientId,
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent || "" : "",
			platform:
				typeof navigator !== "undefined"
					? navigator.userAgentData?.platform || navigator.platform || ""
					: "",
		};
	}

	function buildActivityPayload() {
		return {
			clientId,
			sessionId: getActiveSessionId?.() || null,
			visible: typeof document !== "undefined" ? document.visibilityState === "visible" : true,
			focused: Boolean(windowFocused),
		};
	}

	async function syncActivity(options = {}) {
		if (!clientId) return false;
		const payload = buildActivityPayload();
		const now = Date.now();
		const key = JSON.stringify(payload);
		if (!options.force && key === lastActivityKey && now - lastActivitySentAt < 4_000) {
			return true;
		}
		try {
			await api.postJson("/api/push/activity", payload, options.keepalive ? { keepalive: true } : {});
			lastActivityKey = key;
			lastActivitySentAt = now;
			return true;
		} catch {
			return false;
		}
	}

	function startActivityTracking() {
		if (activityTrackingStarted) return;
		activityTrackingStarted = true;

		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") windowFocused = false;
			else if (typeof document.hasFocus === "function") windowFocused = document.hasFocus();
			void syncActivity({ force: true, keepalive: document.visibilityState === "hidden" });
		});
		window.addEventListener("focus", () => {
			windowFocused = true;
			void syncActivity({ force: true });
		});
		window.addEventListener("blur", () => {
			windowFocused = false;
			void syncActivity({ force: true });
		});
		window.addEventListener("pageshow", () => {
			if (typeof document.hasFocus === "function") windowFocused = document.hasFocus();
			void syncActivity({ force: true });
		});
		window.addEventListener("pagehide", () => {
			windowFocused = false;
			void syncActivity({ force: true, keepalive: true });
		});

		activityTimer = setInterval(() => {
			const visible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
			if (!visible && !windowFocused) return;
			void syncActivity();
		}, 5_000);
	}

	function setButtonState() {
		if (!btnNotify) return;
		const blocked = supported && Notification.permission === "denied";
		btnNotify.disabled = !supported || blocked;
		btnNotify.classList.toggle("active", subscribed);
		btnNotify.setAttribute("aria-pressed", subscribed ? "true" : "false");
		if (lblNotify) {
			if (!supported) lblNotify.textContent = "off";
			else if (blocked) lblNotify.textContent = "blocked";
			else lblNotify.textContent = subscribed ? "on" : "off";
		}
		btnNotify.title = blocked ? "Notifications blocked in browser settings" : subscribed ? "Push notifications on" : "Push notifications off";
	}

	async function ensureRegistration() {
		if (!supported) return null;
		if (registration) return registration;
		registration = await navigator.serviceWorker.register("/sw.js?v=20260403f", { scope: "/" });
		return registration;
	}

	async function syncSubscriptionWithServer() {
		if (!registration) return false;
		const existing = await registration.pushManager.getSubscription();
		if (!existing) {
			subscribed = false;
			setButtonState();
			return false;
		}

		try {
			const { publicKey } = await api.getJson("/api/push/public-key");
			const currentKey = existing.options?.applicationServerKey;
			if (currentKey) {
				const keyBytes = new Uint8Array(currentKey);
				const expectedBytes = base64ToUint8Array(publicKey);
				if (keyBytes.length !== expectedBytes.length || !keyBytes.every((b, i) => b === expectedBytes[i])) {
					await existing.unsubscribe().catch(() => {});
					const newSub = await registration.pushManager.subscribe({
						userVisibleOnly: true,
						applicationServerKey: expectedBytes,
					});
					await api.postJson("/api/push/subscribe", { subscription: newSub.toJSON(), ...getSubscriptionMeta() });
					subscribed = true;
					setButtonState();
					return true;
				}
			}
		} catch {
			// If key check fails, proceed with normal sync
		}

		await api.postJson("/api/push/subscribe", { subscription: existing.toJSON(), ...getSubscriptionMeta() });
		subscribed = true;
		setButtonState();
		return true;
	}

	async function subscribe() {
		if (!supported) {
			onNotice?.("Push notifications aren't supported here.", "error");
			return false;
		}
		if (Notification.permission === "denied") {
			onNotice?.("Notifications are blocked. Enable them in browser settings.", "error");
			setButtonState();
			return false;
		}
		const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
		if (permission !== "granted") {
			setButtonState();
			return false;
		}

		const reg = await ensureRegistration();
		if (!reg) return false;

		const { publicKey } = await api.getJson("/api/push/public-key");
		const serverKey = base64ToUint8Array(publicKey);

		let sub = await reg.pushManager.getSubscription();
		if (sub) {
			const currentKey = sub.options?.applicationServerKey;
			if (currentKey) {
				const keyBytes = new Uint8Array(currentKey);
				if (keyBytes.length !== serverKey.length || !keyBytes.every((b, i) => b === serverKey[i])) {
					await sub.unsubscribe().catch(() => {});
					sub = null;
				}
			}
		}
		if (!sub) {
			sub = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: serverKey,
			});
		}

		await api.postJson("/api/push/subscribe", { subscription: sub.toJSON(), ...getSubscriptionMeta() });
		subscribed = true;
		setButtonState();
		onNotice?.("Push notifications enabled.", "info");
		return true;
	}

	async function unsubscribe() {
		if (!supported || !registration) {
			subscribed = false;
			setButtonState();
			return false;
		}
		const sub = await registration.pushManager.getSubscription();
		if (sub) {
			await api.postJson("/api/push/unsubscribe", { endpoint: sub.endpoint });
			await sub.unsubscribe().catch(() => {});
		}
		subscribed = false;
		setButtonState();
		onNotice?.("Push notifications disabled.", "info");
		return true;
	}

	async function toggle() {
		if (subscribed) return unsubscribe();
		return subscribe();
	}

	async function test() {
		if (!supported) {
			onNotice?.("Push notifications aren't supported here.", "error");
			return false;
		}
		if (Notification.permission !== "granted") {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setButtonState();
				onNotice?.("Notification permission not granted.", "error");
				return false;
			}
		}
		const reg = await ensureRegistration();
		try {
			const title = "omp-mobile · test";
			const options = {
				body: "This is a test notification from omp-mobile.",
				tag: `omp-mobile-test-${Date.now()}`,
				icon: "/icon-192.png",
				badge: "/icon-192.png",
				data: { url: "/" },
			};
			if (reg?.showNotification) await reg.showNotification(title, options);
			else new Notification(title, options);
			onNotice?.("Test notification sent.", "info");
			return true;
		} catch (error) {
			onNotice?.(error instanceof Error ? error.message : String(error), "error");
			return false;
		}
	}

	async function start() {
		supported = canUsePush();
		setButtonState();
		startActivityTracking();
		void syncActivity({ force: true });
		if (!supported) return;
		try {
			await ensureRegistration();
			if (Notification.permission === "granted") {
				const synced = await syncSubscriptionWithServer();
				if (!synced) {
					await subscribe();
				}
			} else {
				setButtonState();
			}
		} catch (error) {
			supported = false;
			setButtonState();
			onNotice?.(error instanceof Error ? error.message : String(error), "error");
		}
	}

	if (btnNotify) {
		btnNotify.addEventListener("click", () => { void toggle(); });
	}

	return {
		start,
		test,
		toggle,
		subscribe,
		disable: unsubscribe,
		syncActivity,
		isSupported: () => supported,
		isSubscribed: () => subscribed,
	};
}
