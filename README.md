# get-all-github-contributions

Sync all your GitHub contributions (commits) across multiple accounts, organizations, and repositories using the GitHub GraphQL API.

## Installation

```bash
npm install get-all-github-contributions
```

## Usage

### As a library

```typescript
import { GetAllGitHubContributions } from "get-all-github-contributions";
import type { ImportConfig, ImportData } from "get-all-github-contributions";

const config: ImportConfig = {
  tokens: {
    "your-github-username": "ghp_yourPersonalAccessToken",
  },
  import: {
    concurrency: 10,
    maxRetries: 2,
  },
};

// Optionally pass existing data to do an incremental sync
const data: ImportData = {
  accounts: {},
  languageColors: {},
  importState: { accountProgress: {} },
};

const sync = new GetAllGitHubContributions({ config, data });
await sync.sync();

// `data` is mutated in place and now contains all contributions
console.log(data.accounts);
```

### As a CLI script

1. Copy `config.example.json` to `config.json` and add your GitHub personal access tokens
2. Run the import:

```bash
npm run import
```

Data is saved to `data/data.json` and persisted every 30 seconds during the sync.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `tokens` | `Record<string, string>` | required | Map of GitHub username to personal access token |
| `import.concurrency` | `number` | `10` | Maximum concurrent API requests |
| `import.maxRetries` | `number` | `2` | Retry attempts for failed requests |
| `import.pageSize` | `number` | `50` | Number of items per page for GraphQL pagination |
| `import.rateLimitGracePeriod` | `number` | `1000` | Grace period in ms added when waiting for rate limit reset |
| `import.skip.organizations` | `string[]` | `[]` | Organization logins to skip |
| `import.skip.repositories` | `string[]` | `[]` | Repositories to skip (`owner/repo`) |

### GitHub Token

Create a personal access token at [github.com/settings/tokens](https://github.com/settings/tokens) with the `repo` and `read:org` scopes.

## Data Structure

The synced `ImportData` contains:

- **accounts** - Per-account data including user profile, organizations, repositories, branches, and commits
- **languageColors** - Map of language names to their GitHub colors
- **importState** - Sync progress and timestamps for incremental syncs

Each commit includes:

```typescript
interface Commit {
  oid: string;             // Git commit SHA
  additions: number;       // Lines added
  deletions: number;       // Lines deleted
  changedFiles: number;    // Number of files changed
  commitedAtTimestamp: number; // Unix timestamp
}
```

## How It Works

1. Fetches user profile and organizations for each configured account
2. Discovers all repositories (owned, collaborator, and organization member)
3. Enumerates branches per repository
4. Fetches commits authored by the authenticated user per branch
5. Skips repositories and branches that haven't changed since the last sync

All API calls use pagination and respect GitHub's rate limits with automatic retry and backoff.

## License

MIT
