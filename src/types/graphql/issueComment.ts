import type { PaginatedResponse } from "./general.js";

export interface IssueCommentNode {
  createdAt: string;
}

export interface IssueCommentsPage
  extends PaginatedResponse<IssueCommentNode> {}

export interface IssueCommentsPageResponse {
  viewer: {
    issueComments: IssueCommentsPage;
  };
}
