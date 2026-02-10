import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import {type Config, getExcludedFiles} from './config.js';
import {SyncEngine} from './sync.js';

export class Watcher {
	private watcher: chokidar.FSWatcher | null = null;
	private readonly pendingChanges = new Set<string>();
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly syncEngine: SyncEngine;

	constructor(private readonly config: Config) {
		this.syncEngine = new SyncEngine(config);
	}

	start(): void {
		const excludedFiles = getExcludedFiles();

		this.watcher = chokidar.watch(this.config.localPath, {
			ignored: (p: string) => excludedFiles.some((f) => p.endsWith(f)),
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100,
			},
		});

		this.watcher
			.on('add', (p) => {
				this.onChange(p);
			})
			.on('change', (p) => {
				this.onChange(p);
			})
			.on('unlink', (p) => {
				this.onChange(p);
			});

		console.log(`[watch] Watching ${this.config.localPath}`);
	}

	async pull(): Promise<void> {
		const filesToPush = await this.syncEngine.pull();
		if (filesToPush.length > 0) {
			console.log(`[pull] Pushing ${filesToPush.length} locally-newer files...`);
			await this.syncEngine.push(filesToPush);
		}
	}

	async pushAll(): Promise<void> {
		const excludedFiles = getExcludedFiles();
		const allFiles = this.getAllFiles(this.config.localPath, excludedFiles);
		if (allFiles.length > 0) {
			console.log(`[init] Pushing ${allFiles.length} local files...`);
			await this.syncEngine.push(allFiles);
		}
	}

	startPolling(): void {
		setInterval(async () => {
			try {
				await this.pull();
			} catch (err) {
				console.error('[poll] Pull failed:', err);
			}
		}, this.config.pollIntervalMs);
	}

	stop(): void {
		if (this.watcher) {
			void this.watcher.close();
			this.watcher = null;
		}

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private getAllFiles(dir: string, excludedFiles: string[]): string[] {
		const files: string[] = [];
		for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
			if (excludedFiles.some((f) => entry.name.endsWith(f))) {
				continue;
			}

			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...this.getAllFiles(fullPath, excludedFiles));
			} else {
				files.push(fullPath);
			}
		}

		return files;
	}

	private onChange(absolutePath: string): void {
		const relativePath = path.relative(this.config.localPath, absolutePath);
		console.log(`[watch] Change detected: ${relativePath}`);

		this.pendingChanges.add(absolutePath);

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			void this.flush();
		}, this.config.debounceMs);
	}

	private async flush(): Promise<void> {
		if (this.pendingChanges.size === 0) {
			return;
		}

		const changes = Array.from(this.pendingChanges);
		this.pendingChanges.clear();

		try {
			await this.syncEngine.push(changes);
		} catch (err) {
			console.error('[watch] Push failed:', err);
		}
	}
}
