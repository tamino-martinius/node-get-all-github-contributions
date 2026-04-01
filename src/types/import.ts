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
}

export interface Repository {
  name: string;
  description?: string;
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
    accountProgress: Record<string, AccountProgress>;
  };
}
