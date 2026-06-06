export function computeCliCommand(state) {
	if (!state || !state.sessionFile) return null;
	const cwd = state.cwd || "";
	const file = state.sessionFile;
	return `cd ${JSON.stringify(cwd)} && omp --session ${JSON.stringify(file)}`;
}
