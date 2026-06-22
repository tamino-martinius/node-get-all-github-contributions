import type { BranchNode } from "./graphql/branch.js";
import type { RateLimit } from "./graphql/general.js";
import type { RepositoryNode } from "./graphql/repository.js";

export interface ImportConfig {
  tokens: Record<string, string>;
  import?: {
    concurrency?: number;
    maxRetries?: number;
    pageSize?: number;
    rateLimitGracePeriod?: number;
    recheckWithRemainingRateLimit?: boolean;
    // Spreads non-default branch commit fetches across this many runs. Each run
    // always syncs every repository's default branch plus the deterministic
    // 1/branchRecheckBuckets slice of its other branches, so all branches are
    // covered within `branchRecheckBuckets` runs. Falsy or < 2 disables
    // rotation (every branch is synced every run, the original behavior).
    branchRecheckBuckets?: number;
    // When true, branches already synced once only fetch commits newer than the
    // last one seen (history `since`) instead of re-paginating full history.
    incrementalHistory?: boolean;
    skip?: {
      organizations?: string[];
      repositories?: string[];
    };
  };
}

export interface AccountConfig {
  username: string;
  token: string;
}

export interface User {
  id: string;
  login: string;
  name: string;
  bio: string;
  gistCount: number;
  followerCount: number;
  followingCount: number;
  commitCommentCount: number;
  issueCommentCount: number;
  commitCommentTimestamps: number[];
  issueCommentTimestamps: number[];
  avatarUrl: string;
  url: string;
}

export interface Organization {
  login: string;
  name: string;
  avatarUrl: string;
  url: string;
}

export interface Commit {
  oid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitedAtTimestamp: number;
}

export interface Branch {
  name: string;
  latestCommitOid?: string;
  // Committed date (ms epoch) of the most recent of the user's own commits seen
  // on this branch. Used as the `since` bound for incremental history fetches.
  latestCommitTimestamp?: number;
}

export interface Repository {
  name: string;
  description: string;
  stargazerCount: number;
  forkCount: number;
  isPrivate: boolean;
  lastCommitTimestamp?: number;
  url: string;
  homepageUrl?: string;
  languages: string[];
  owner: string;
  defaultBranch: string;
  commits: Record<string, Commit>;
  branches: Record<string, Branch>;
}

export interface Account {
  user?: User;
  organizations: Record<string, Organization>;
  repositories: Record<string, Repository>;
}

export interface ProgressStats {
  repoCount: number;
  branchCount: number;
  commitCount: number;
  additionCount: number;
  deletionCount: number;
  changedFileCount: number;
}

export interface ProgressContext {
  repositoryNode?: RepositoryNode;
  branchNode?: BranchNode;
  branchCount?: number;
}

export interface AccountProgress {
  rateLimit: RateLimit;
  progressStats: {
    initial: ProgressStats;
    total: ProgressStats;
    current: ProgressStats;
    new: ProgressStats;
  };
  status: "pending" | "in-progress" | "completed" | "error" | "unknown";
}

export interface ImportData {
  accounts: Record<string, Account>;
  languageColors: Record<string, string>;
  importState: {
    lastFullImportTimestamp?: number;
    currentProgressTimestamp?: number;
    // Monotonic per-run counter driving branch rotation; the active bucket for a
    // run is `branchRotationCounter % branchRecheckBuckets`.
    branchRotationCounter?: number;
    accountProgress: Record<string, AccountProgress>;
  };
}
