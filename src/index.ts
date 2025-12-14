#!/usr/bin/env node

import * as path from 'path';
import {loadConfig, CONFIG_FILENAME} from './config.js';
import {Watcher} from './watcher.js';

function parseArgs(): {configPath: string} {
	const args = process.argv.slice(2);
	let configPath: string | undefined;
	let folderPath: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === '--config' && args[i + 1]) {
			configPath = args[i + 1];
			i += 1;
		} else if (!args[i]?.startsWith('-')) {
			folderPath = args[i];
		}
	}

	// Priority: --config > positional folder arg > current directory
	if (configPath) {
		return {configPath};
	}

	if (folderPath) {
		// Expand ~ in folder path
		if (folderPath.startsWith('~/')) {
			folderPath = path.join(process.env.HOME ?? '', folderPath.slice(2));
		}

		return {configPath: path.join(folderPath, CONFIG_FILENAME)};
	}

	return {configPath: path.join(process.cwd(), CONFIG_FILENAME)};
}

async function main(): Promise<void> {
	const {configPath} = parseArgs();

	console.log(`Loading config from ${configPath}`);
	const config = loadConfig(configPath);

	console.log(`Syncing ${config.localPath} <-> GDrive folder ${config.gdriveFolderId}`);
	console.log(`Debounce: ${config.debounceMs}ms, Poll interval: ${config.pollIntervalMs}ms`);

	const watcher = new Watcher(config);

	// Initial sync: pull remote changes, then push local files
	console.log('Performing initial sync...');
	await watcher.pull();
	await watcher.pushAll();

	// Start watching for local changes
	watcher.start();

	// Start polling for remote changes
	watcher.startPolling();

	// Handle graceful shutdown
	process.on('SIGINT', () => {
		console.log('\nShutting down...');
		watcher.stop();
		process.exit(0);
	});

	process.on('SIGTERM', () => {
		console.log('\nShutting down...');
		watcher.stop();
		process.exit(0);
	});
}

main().catch((err: unknown) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
