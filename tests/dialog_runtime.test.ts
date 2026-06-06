import { describe, expect, test } from "bun:test";
import { PiWebRuntime } from "../src/session-runtime.ts";

describe("pending dialog lifecycle", () => {
	test("cancelPendingDialogsForSession closes pending dialogs with the provided reason", () => {
		const runtime = new PiWebRuntime();
		const runtimeAny = runtime as any;
		let uiReason = null;

		runtimeAny.pendingUiPrompts.set("ui-1", {
			sessionId: "session-1",
			event: { type: "ui_input", uiId: "ui-1", title: "Name" },
			resolve: () => true,
			close: (reason) => {
				uiReason = reason;
				runtimeAny.pendingUiPrompts.delete("ui-1");
				return true;
			},
		});

		runtimeAny.cancelPendingDialogsForSession("session-1", "released");

		expect(uiReason).toBe("released");
		expect(runtimeAny.pendingUiPrompts.size).toBe(0);
	});

	test("resolve helpers return false once a dialog is no longer pending", () => {
		const runtime = new PiWebRuntime();
		const runtimeAny = runtime as any;

		expect(runtimeAny.resolveUiPrompt("session-1", "missing-ui", false)).toBe(false);
	});
});
