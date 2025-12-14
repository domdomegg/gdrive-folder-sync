import * as fs from 'fs';
import * as path from 'path';

export type Config = {
	localPath: string;
	gdriveFolderId: string;
	tokenFile: string;
	clientId: string | undefined;
	clientSecret: string | undefined;
	debounceMs: number;
	pollIntervalMs: number;
};

type ConfigFile = {
	localPath: string;
	gdriveFolderId: string;
	tokenFile: string;
	clientId?: string;
	clientSecret?: string;
};

const DEFAULT_DEBOUNCE_MS = 15_000; // 15 seconds
const DEFAULT_POLL_INTERVAL_MS = 900_000; // 15 minutes

export const CONFIG_FILENAME = '.gdrive-folder-sync.json';
export const STATE_FILENAME = '.gdrive-folder-sync-state.json';

function expandPath(p: string): string {
	if (p.startsWith('~/')) {
		return path.join(process.env.HOME ?? '', p.slice(2));
	}

	return p;
}

export function loadConfig(configPath: string): Config {
	const expanded = expandPath(configPath);
	const content = fs.readFileSync(expanded, 'utf-8');
	const raw: ConfigFile = JSON.parse(content);

	return {
		localPath: expandPath(raw.localPath),
		gdriveFolderId: raw.gdriveFolderId,
		tokenFile: expandPath(raw.tokenFile),
		clientId: raw.clientId ?? process.env.GOOGLE_CLIENT_ID,
		clientSecret: raw.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET,
		debounceMs: DEFAULT_DEBOUNCE_MS,
		pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
	};
}

export function getExcludedFiles(): string[] {
	return [CONFIG_FILENAME, STATE_FILENAME, '.DS_Store'];
}
