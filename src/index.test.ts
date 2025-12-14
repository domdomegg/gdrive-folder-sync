import {test, expect} from 'vitest';
import {
	loadConfig, getExcludedFiles, CONFIG_FILENAME, STATE_FILENAME,
} from './config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

test('getExcludedFiles returns expected files', () => {
	const excluded = getExcludedFiles();
	expect(excluded).toContain(CONFIG_FILENAME);
	expect(excluded).toContain(STATE_FILENAME);
	expect(excluded).toContain('.DS_Store');
});

test('loadConfig expands ~ paths', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-sync-test-'));
	const configPath = path.join(tmpDir, 'config.json');

	fs.writeFileSync(configPath, JSON.stringify({
		localPath: '~/my-folder',
		gdriveFolderId: 'test-folder-id',
		tokenFile: '~/.config/gdrive-folder-sync/tokens.json',
	}));

	const config = loadConfig(configPath);

	expect(config.localPath).toBe(path.join(os.homedir(), 'my-folder'));
	expect(config.tokenFile).toBe(path.join(os.homedir(), '.config/gdrive-folder-sync/tokens.json'));
	expect(config.gdriveFolderId).toBe('test-folder-id');
	expect(config.debounceMs).toBe(15_000);
	expect(config.pollIntervalMs).toBe(900_000);

	fs.rmSync(tmpDir, {recursive: true});
});

