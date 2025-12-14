# gdrive-folder-sync

Bidirectional sync between a local folder and Google Drive.

## Usage

1. Create a config file in the folder you want to sync (e.g., `~/Documents/synced-folder/.gdrive-folder-sync.json`):

```json
{
  "localPath": "~/Documents/synced-folder",
  "gdriveFolderId": "1abc123...",
  "tokenFile": "~/.config/gdrive-folder-sync/tokens.json"
}
```

2. (Optional) Set environment variables for token refresh:

```bash
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"
```

3. Run the daemon:

```bash
npx gdrive-folder-sync ~/Documents/synced-folder
```

### Config Options

| Option | Required | Description |
|--------|----------|-------------|
| `localPath` | Yes | Local folder to sync |
| `gdriveFolderId` | Yes | Google Drive folder ID |
| `tokenFile` | Yes | Path to JSON file with `access_token` and optionally `refresh_token` |
| `clientId` | No | OAuth client ID for token refresh (defaults to `GOOGLE_CLIENT_ID` env var) |
| `clientSecret` | No | OAuth client secret for token refresh (defaults to `GOOGLE_CLIENT_SECRET` env var) |

### Token File Format

```json
{
  "access_token": "ya29.a0...",
  "refresh_token": "1//03..."  // optional, needed for auto-refresh
}
```

If `clientId`, `clientSecret`, and `refresh_token` are all provided, expired tokens are automatically refreshed. Otherwise the daemon will fail when the access token expires.

### Excluded Files

These files are automatically excluded from sync:
- `.gdrive-folder-sync.json` (config)
- `.gdrive-folder-sync-state.json` (state)
- `.DS_Store`

## How It Works

- **Local → GDrive**: Watches for file changes, debounces for 15 seconds, then pushes
- **GDrive → Local**: Polls every 15 minutes for remote changes
- **Conflicts**: Last-write-wins based on modification time

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
