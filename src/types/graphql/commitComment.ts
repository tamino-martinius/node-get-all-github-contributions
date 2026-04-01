import type { PaginatedResponse } from "./general.js";

export interface CommitCommentNode {
  createdAt: string;
}

export interface CommitCommentsPage
  extends PaginatedResponse<CommitCommentNode> {}

export interface CommitCommentsPageResponse {
  viewer: {
    commitComments: CommitCommentsPage;
  };
}
