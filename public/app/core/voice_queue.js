const DB_NAME = "omp-mobile-voice";
const STORE_NAME = "jobs";
const DB_VERSION = 1;

function openDb() {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			resolve(null);
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: "id" });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error("Failed to open voice queue DB"));
	});
}

function txDone(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
		tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
	});
}

export async function enqueueVoiceJob(blob, mimeType, metadata = {}) {
	const db = await openDb();
	if (!db) return null;
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const tx = db.transaction(STORE_NAME, "readwrite");
	tx.objectStore(STORE_NAME).put({
		id,
		blob,
		mimeType,
		createdAt: Date.now(),
		...(metadata && typeof metadata === "object" ? metadata : {}),
	});
	await txDone(tx);
	db.close();
	return id;
}

export async function listVoiceJobs() {
	const db = await openDb();
	if (!db) return [];
	const tx = db.transaction(STORE_NAME, "readonly");
	const req = tx.objectStore(STORE_NAME).getAll();
	const items = await new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
		req.onerror = () => reject(req.error || new Error("Failed to read voice queue"));
	});
	await txDone(tx);
	db.close();
	return items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function updateVoiceJob(id, patch) {
	const db = await openDb();
	if (!db || !id) return null;
	const tx = db.transaction(STORE_NAME, "readwrite");
	const store = tx.objectStore(STORE_NAME);
	const current = await new Promise((resolve, reject) => {
		const req = store.get(id);
		req.onsuccess = () => resolve(req.result || null);
		req.onerror = () => reject(req.error || new Error("Failed to read voice job"));
	});
	if (!current) {
		await txDone(tx);
		db.close();
		return null;
	}
	const next = {
		...current,
		...(patch && typeof patch === "object" ? patch : {}),
	};
	store.put(next);
	await txDone(tx);
	db.close();
	return next;
}

export async function removeVoiceJob(id) {
	const db = await openDb();
	if (!db) return;
	const tx = db.transaction(STORE_NAME, "readwrite");
	tx.objectStore(STORE_NAME).delete(id);
	await txDone(tx);
	db.close();
}
