import * as fs from 'fs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type GDriveFile = {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	parents?: string[];
};

type TokenFile = {
	access_token: string;
	refresh_token?: string;
};

type OAuthConfig = {
	tokenFile: string;
	clientId: string | undefined;
	clientSecret: string | undefined;
};

export class GDriveClient {
	constructor(private readonly oauth: OAuthConfig) {}

	async listFiles(folderId: string): Promise<GDriveFile[]> {
		const allFiles: GDriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const params = new URLSearchParams({
				q: `'${folderId}' in parents and trashed = false`,
				fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, parents)',
				pageSize: '1000',
			});
			if (pageToken) {
				params.set('pageToken', pageToken);
			}

			// eslint-disable-next-line no-await-in-loop -- pagination requires sequential calls
			const result = await this.request<{files: GDriveFile[]; nextPageToken?: string}>(`${DRIVE_API}/files?${params.toString()}`);

			allFiles.push(...result.files);
			pageToken = result.nextPageToken;
		} while (pageToken);

		return allFiles;
	}

	async listFilesRecursive(folderId: string, basePath = ''): Promise<Map<string, GDriveFile>> {
		const result = new Map<string, GDriveFile>();
		const files = await this.listFiles(folderId);

		for (const file of files) {
			const filePath = basePath ? `${basePath}/${file.name}` : file.name;

			if (file.mimeType === 'application/vnd.google-apps.folder') {
				// eslint-disable-next-line no-await-in-loop -- recursive traversal requires sequential calls
				const subFiles = await this.listFilesRecursive(file.id, filePath);
				for (const [subPath, subFile] of subFiles) {
					result.set(subPath, subFile);
				}
			} else {
				result.set(filePath, file);
			}
		}

		return result;
	}

	async downloadFile(fileId: string): Promise<Buffer> {
		const token = await this.getValidToken();
		const response = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
			headers: {Authorization: `Bearer ${token}`},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`GDrive download error ${response.status}: ${text}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	async createFolder(name: string, parentId: string): Promise<GDriveFile> {
		return this.request<GDriveFile>(`${DRIVE_API}/files`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				name,
				mimeType: 'application/vnd.google-apps.folder',
				parents: [parentId],
			}),
		});
	}

	async findFolder(name: string, parentId: string): Promise<GDriveFile | null> {
		const params = new URLSearchParams({
			q: `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
			fields: 'files(id, name, mimeType, modifiedTime, parents)',
			pageSize: '1',
		});

		const result = await this.request<{files: GDriveFile[]}>(`${DRIVE_API}/files?${params.toString()}`);
		return result.files[0] ?? null;
	}

	async uploadFile(name: string, content: Buffer, parentId: string): Promise<GDriveFile> {
		const token = await this.getValidToken();
		const metadata = {name, parents: [parentId]};

		const boundary = '-------314159265358979323846';
		const body = Buffer.concat([
			Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
			content,
			Buffer.from(`\r\n--${boundary}--`),
		]);

		const response = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': `multipart/related; boundary=${boundary}`,
			},
			body,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`GDrive upload error ${response.status}: ${text}`);
		}

		return response.json() as Promise<GDriveFile>;
	}

	async updateFile(fileId: string, content: Buffer): Promise<GDriveFile> {
		const token = await this.getValidToken();

		const response = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media&fields=id,name,mimeType,modifiedTime`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/octet-stream',
			},
			body: content,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`GDrive update error ${response.status}: ${text}`);
		}

		return response.json() as Promise<GDriveFile>;
	}

	async deleteFile(fileId: string): Promise<void> {
		const token = await this.getValidToken();
		const response = await fetch(`${DRIVE_API}/files/${fileId}`, {
			method: 'DELETE',
			headers: {Authorization: `Bearer ${token}`},
		});

		if (!response.ok && response.status !== 404) {
			const text = await response.text();
			throw new Error(`GDrive delete error ${response.status}: ${text}`);
		}
	}

	private readTokenFile(): TokenFile {
		const content = fs.readFileSync(this.oauth.tokenFile, 'utf-8');
		return JSON.parse(content);
	}

	private writeTokenFile(data: TokenFile): void {
		fs.writeFileSync(this.oauth.tokenFile, JSON.stringify(data, null, 2));
	}

	private canRefresh(): boolean {
		return Boolean(this.oauth.clientId && this.oauth.clientSecret);
	}

	private async refreshToken(): Promise<string> {
		if (!this.canRefresh()) {
			throw new Error('Token expired and no clientId/clientSecret configured for refresh');
		}

		const tokenData = this.readTokenFile();
		if (!tokenData.refresh_token) {
			throw new Error('No refresh_token available in token file');
		}

		const response = await fetch(TOKEN_URL, {
			method: 'POST',
			headers: {'Content-Type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({
				client_id: this.oauth.clientId!,
				client_secret: this.oauth.clientSecret!,
				refresh_token: tokenData.refresh_token,
				grant_type: 'refresh_token',
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Token refresh failed: ${text}`);
		}

		const data = await response.json() as {access_token: string};
		tokenData.access_token = data.access_token;
		this.writeTokenFile(tokenData);
		console.log('[auth] Token refreshed');

		return data.access_token;
	}

	private async getValidToken(): Promise<string> {
		const tokenData = this.readTokenFile();
		const token = tokenData.access_token;

		// Quick validation: try a lightweight API call
		const response = await fetch(`${DRIVE_API}/about?fields=user`, {
			headers: {Authorization: `Bearer ${token}`},
		});

		if (response.ok) {
			return token;
		}

		if (response.status === 401) {
			return this.refreshToken();
		}

		const text = await response.text();
		throw new Error(`Token validation failed: ${text}`);
	}

	private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
		const token = await this.getValidToken();
		const response = await fetch(url, {
			...options,
			headers: {
				Authorization: `Bearer ${token}`,
				...options.headers,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`GDrive API error ${response.status}: ${text}`);
		}

		return response.json() as Promise<T>;
	}
}
