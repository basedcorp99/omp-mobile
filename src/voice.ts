/**
 * Voice transcription using OpenAI ChatGPT transcribe endpoint.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { exec } from "node:child_process";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";

const FFMPEG_TIMEOUT = 15_000;

function cleanup(...paths: string[]) {
	for (const p of paths) {
		try { unlinkSync(p); } catch {}
	}
}

function ffmpegConvert(inputPath: string, outputPath: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	exec(
		`ffmpeg -y -i ${JSON.stringify(inputPath)} -ar 16000 -ac 1 -c:a pcm_s16le ${JSON.stringify(outputPath)}`,
		{ timeout: FFMPEG_TIMEOUT },
		(err) => err ? reject(new Error(`ffmpeg failed: ${err.message}`)) : resolve(),
	);
	return promise;
}

async function chatgptTranscribe(wavPath: string): Promise<string> {
	const authPath = join(homedir(), ".codex", "auth.json");
	if (!existsSync(authPath)) {
		throw new Error(
			"Codex authentication file not found (~/.codex/auth.json). Please log into Codex first by running 'codex login' in your terminal."
		);
	}

	let auth;
	try {
		auth = JSON.parse(readFileSync(authPath, "utf-8"));
	} catch (err) {
		throw new Error(`Failed to parse Codex auth file: ${err instanceof Error ? err.message : String(err)}`);
	}

	const token = auth.tokens?.access_token;
	const accountId = auth.tokens?.account_id;

	if (!token || !accountId) {
		throw new Error(
			"Invalid Codex auth file structure: missing access token or account ID. Please run 'codex login' to re-authenticate."
		);
	}

	const fileData = Bun.file(wavPath);
	const formData = new FormData();
	formData.append("file", fileData, "recording.wav");

	const response = await fetch("https://chatgpt.com/backend-api/transcribe", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${token}`,
			"ChatGPT-Account-Id": accountId,
			"originator": "codex_desktop",
		},
		body: formData,
	});

	if (!response.ok) {
		const status = response.status;
		const responseText = await response.text();
		if (status === 401 || status === 403 || responseText.toLowerCase().includes("token")) {
			throw new Error("Codex authentication token is expired or invalid. Please run 'codex login' to refresh it.");
		}
		throw new Error(`ChatGPT transcription API failed with status ${status}: ${responseText}`);
	}

	const result = await response.json();
	return result.text || "";
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<{ ok: true; text: string }> {
	const id = randomUUID().slice(0, 8);
	const inputPath = join(tmpdir(), `pi-voice-${id}.webm`);
	const wavPath = join(tmpdir(), `pi-voice-${id}.wav`);

	try {
		writeFileSync(inputPath, audioBuffer);
		await ffmpegConvert(inputPath, wavPath);

		const text = await chatgptTranscribe(wavPath);
		return { ok: true, text };
	} finally {
		cleanup(inputPath, wavPath);
	}
}

export function getVoiceStatus() {
	const authPath = join(homedir(), ".codex", "auth.json");
	const hasAuth = existsSync(authPath);
	return {
		native: {
			available: hasAuth,
			type: "chatgpt-oauth",
		},
		chatgpt: {
			available: hasAuth,
			authFile: authPath,
		},
	};
}
