// @ts-check
import { defineConfig, devices } from "@playwright/test";

const PORT = Number.parseInt(process.env.OMP_MOBILE_E2E_PORT || process.env.PI_WEB_E2E_PORT || "4318", 10);

export default defineConfig({
	testDir: "tests/e2e",
	testMatch: "**/*.e2e.js",
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
			maxDiffPixelRatio: 0.01,
		},
	},
	webServer: {
		command: `OMP_MOBILE_HOST=127.0.0.1 OMP_MOBILE_PORT=${PORT} OMP_MOBILE_REPLAY=1 bun src/server.ts`,
		url: `http://127.0.0.1:${PORT}/health`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "webkit-iphone",
			use: { ...devices["iPhone 14"] },
		},
	],
});
