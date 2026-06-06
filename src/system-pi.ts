import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// omp-mobile intentionally loads OMP from the installed package so the web UI
// stays aligned with the user's system `omp` CLI version.
let cachedNpmRoot: string | null | undefined;
let cachedPiModule: Promise<Record<string, any>> | null = null;

export function getGlobalNpmRoot(): string | null {
	if (cachedNpmRoot === undefined) {
		try {
			cachedNpmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 3000 }).trim();
		} catch {
			cachedNpmRoot = null;
		}
	}
	return cachedNpmRoot;
}

export function getSystemPiEntryPath(): string {
	try {
		return Bun.resolveSync("@oh-my-pi/pi-coding-agent", process.cwd());
	} catch (err) {
		try {
			return require.resolve("@oh-my-pi/pi-coding-agent");
		} catch (err2) {
			const npmRoot = getGlobalNpmRoot();
			if (npmRoot) {
				const entryPath = join(npmRoot, "@oh-my-pi", "pi-coding-agent", "src", "index.ts");
				if (existsSync(entryPath)) return entryPath;
			}
			throw new Error(
				"Unable to resolve @oh-my-pi/pi-coding-agent. Install it locally or globally: bun add @oh-my-pi/pi-coding-agent",
			);
		}
	}
}

export async function loadSystemPiModule(): Promise<Record<string, any>> {
	if (cachedPiModule !== null) return cachedPiModule;

	const entryPath = getSystemPiEntryPath();
	cachedPiModule = import(pathToFileURL(entryPath).href).catch((error: unknown) => {
		cachedPiModule = null;
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load OMP from ${entryPath}: ${reason}`);
	});
	return cachedPiModule;
}
