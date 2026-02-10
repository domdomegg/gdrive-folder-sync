import * as fs from 'fs';
import * as path from 'path';
import {type Config, STATE_FILENAME, getExcludedFiles} from './config.js';
import {GDriveClient} from './gdrive.js';

type FileState = {
	gdriveId: string;
	localMtime: number;
	gdriveMtime: number;
};

type SyncState = {
	files: Record<string, FileState>;
	folders: Record<string, string>; // relativePath -> gdriveId
};

export class SyncEngine {
	private readonly gdrive: GDriveClient;
	private readonly statePath: string;
	private readonly state: SyncState;

	constructor(private readonly config: Config) {
		this.gdrive = new GDriveClient({
			tokenFile: config.tokenFile,
			clientId: config.clientId,
			clientSecret: config.clientSecret,
		});
		this.statePath = path.join(config.localPath, STATE_FILENAME);
		this.state = this.loadState();
	}

	async push(absolutePaths: string[]): Promise<void> {
		for (const absolutePath of absolutePaths) {
			const relativePath = this.getRelativePath(absolutePath);

			if (this.isExcluded(relativePath)) {
				continue;
			}

			// Check if file still exists (might have been deleted)
			if (!fs.existsSync(absolutePath)) {
				// eslint-disable-next-line no-await-in-loop -- sequential file operations
				await this.handleLocalDelete(relativePath);
				continue;
			}

			const stats = fs.statSync(absolutePath);
			if (stats.isDirectory()) {
				continue; // Folders are created on-demand when uploading files
			}

			const content = fs.readFileSync(absolutePath);
			const localMtime = stats.mtimeMs;

			const existing = this.state.files[relativePath];
			if (existing) {
				// Update existing file
				// eslint-disable-next-line no-await-in-loop -- sequential file operations
				const updated = await this.gdrive.updateFile(existing.gdriveId, content);
				this.state.files[relativePath] = {
					gdriveId: existing.gdriveId,
					localMtime,
					gdriveMtime: new Date(updated.modifiedTime).getTime(),
				};
				console.log(`[push] Updated: ${relativePath}`);
			} else {
				// Create new file
				const dir = path.dirname(relativePath);
				// eslint-disable-next-line no-await-in-loop -- sequential file operations
				const parentId = dir === '.' ? this.config.gdriveFolderId : await this.ensureFolderExists(dir);
				// eslint-disable-next-line no-await-in-loop -- sequential file operations
				const created = await this.gdrive.uploadFile(path.basename(relativePath), content, parentId);
				this.state.files[relativePath] = {
					gdriveId: created.id,
					localMtime,
					gdriveMtime: new Date(created.modifiedTime).getTime(),
				};
				console.log(`[push] Created: ${relativePath}`);
			}
		}

		this.saveState();
	}

	async pull(): Promise<string[]> {
		console.log('[pull] Checking for remote changes...');
		const filesToPush: string[] = [];

		const remoteFiles = await this.gdrive.listFilesRecursive(this.config.gdriveFolderId);

		// Update folder state from remote listing
		for (const [relativePath, file] of remoteFiles) {
			if (file.mimeType === 'application/vnd.google-apps.folder') {
				this.state.folders[relativePath] = file.id;
			}
		}

		for (const [relativePath, remoteFile] of remoteFiles) {
			if (this.isExcluded(relativePath)) {
				continue;
			}

			// Skip Google Docs/Sheets/etc (can't download as regular files)
			if (remoteFile.mimeType.startsWith('application/vnd.google-apps.')) {
				continue;
			}

			const localPath = path.join(this.config.localPath, relativePath);
			const remoteMtime = new Date(remoteFile.modifiedTime).getTime();

			const action = this.shouldDownloadFile(relativePath, localPath, remoteMtime);

			if (action === 'download') {
				// eslint-disable-next-line no-await-in-loop -- sequential file operations
				const content = await this.gdrive.downloadFile(remoteFile.id);
				const dir = path.dirname(localPath);
				fs.mkdirSync(dir, {recursive: true});
				fs.writeFileSync(localPath, content);

				const localMtime = fs.statSync(localPath).mtimeMs;
				this.state.files[relativePath] = {
					gdriveId: remoteFile.id,
					localMtime,
					gdriveMtime: remoteMtime,
				};
				console.log(`[pull] Downloaded: ${relativePath}`);
			} else if (action === 'local-newer') {
				// Update state with remote's gdriveId so push can update rather than create
				this.state.files[relativePath] = {
					gdriveId: remoteFile.id,
					localMtime: fs.statSync(localPath).mtimeMs,
					gdriveMtime: remoteMtime,
				};
				filesToPush.push(localPath);
			}
		}

		// Files in state but not on remote: push them up instead of deleting locally
		for (const relativePath of Object.keys(this.state.files)) {
			if (!remoteFiles.has(relativePath)) {
				const localPath = path.join(this.config.localPath, relativePath);
				if (fs.existsSync(localPath)) {
					// Clear stale state so push treats it as a new file
					// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cleaning up state
					delete this.state.files[relativePath];
					filesToPush.push(localPath);
					console.log(`[pull] Not on remote, will push: ${relativePath}`);
				} else {
					// File gone both locally and remotely, clean up state
					// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cleaning up state
					delete this.state.files[relativePath];
				}
			}
		}

		this.saveState();
		console.log('[pull] Done');
		return filesToPush;
	}

	private loadState(): SyncState {
		try {
			const content = fs.readFileSync(this.statePath, 'utf-8');
			return JSON.parse(content);
		} catch {
			return {files: {}, folders: {}};
		}
	}

	private saveState(): void {
		fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
	}

	private isExcluded(relativePath: string): boolean {
		const excluded = getExcludedFiles();
		const basename = path.basename(relativePath);
		return excluded.includes(basename);
	}

	private getRelativePath(absolutePath: string): string {
		return path.relative(this.config.localPath, absolutePath);
	}

	private async ensureFolderExists(relativePath: string): Promise<string> {
		const parts = relativePath.split(path.sep);
		let currentPath = '';
		let parentId = this.config.gdriveFolderId;

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			const existingId = this.state.folders[currentPath];
			if (existingId) {
				parentId = existingId;
			} else {
				// Check if folder already exists on GDrive (prevents duplicates when state is lost)
				// eslint-disable-next-line no-await-in-loop -- sequential folder creation
				const existing = await this.gdrive.findFolder(part, parentId);
				if (existing) {
					this.state.folders[currentPath] = existing.id;
					parentId = existing.id;
				} else {
					// eslint-disable-next-line no-await-in-loop -- sequential folder creation
					const folder = await this.gdrive.createFolder(part, parentId);
					this.state.folders[currentPath] = folder.id;
					parentId = folder.id;
				}
			}
		}

		return parentId;
	}

	private async handleLocalDelete(relativePath: string): Promise<void> {
		const existing = this.state.files[relativePath];
		if (existing) {
			try {
				await this.gdrive.deleteFile(existing.gdriveId);
				console.log(`[push] Deleted: ${relativePath}`);
			} catch (err) {
				console.error(`[push] Failed to delete ${relativePath}:`, err);
			}

			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cleaning up state
			delete this.state.files[relativePath];
		}
	}

	private shouldDownloadFile(relativePath: string, localPath: string, remoteMtime: number): 'download' | 'skip' | 'local-newer' {
		const existing = this.state.files[relativePath];

		if (!existing) {
			// No state entry — either genuinely new from remote, or state was reset
			if (!fs.existsSync(localPath)) {
				return 'download';
			}

			// Local file exists: compare mtimes, newest wins
			const localMtime = fs.statSync(localPath).mtimeMs;
			if (remoteMtime > localMtime) {
				return 'download';
			}

			console.log(`[pull] Local is newer (no state): ${relativePath}`);
			return 'local-newer';
		}

		if (remoteMtime <= existing.gdriveMtime) {
			// Remote hasn't changed since last sync
			return 'skip';
		}

		// Remote is newer than what we last synced
		// Check if local has also changed
		if (!fs.existsSync(localPath)) {
			return 'download';
		}

		const localMtime = fs.statSync(localPath).mtimeMs;
		if (localMtime <= existing.localMtime) {
			// Local hasn't changed, download remote
			return 'download';
		}

		// Conflict: both changed. Last-write-wins based on mtime.
		if (remoteMtime > localMtime) {
			return 'download';
		}

		console.log(`[pull] Conflict, local wins: ${relativePath}`);
		return 'local-newer';
	}
}
