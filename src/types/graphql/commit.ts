import type { PaginatedResponse } from "./general";

export interface CommitNode {
  oid: string;
  additions: number;
  deletions: number;
  changedFilesIfAvailable: number;
  committedDate: string;
  committer: {
    user: {
      id: string;
    };
  };
}

export interface CommitsPage extends PaginatedResponse<CommitNode> {}

export interface CommitsPageResponse {
  repository: {
    ref: {
      target: {
        history: CommitsPage;
      };
    };
  };
}
