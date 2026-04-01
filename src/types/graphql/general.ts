export interface RateLimit {
  lastUsedTimestamp?: number;
  remaining?: number;
  resetTimestamp?: number;
  limit?: number;
  used?: number;
}

export interface ViewerResponse {
  viewer: {
    id: string;
    name?: string;
    bio?: string;
    login: string;
    avatarUrl: string;
    url: string;
    gists: {
      totalCount: number;
    };
    followers: {
      totalCount: number;
    };
    following: {
      totalCount: number;
    };
    commitComments: {
      totalCount: number;
    };
    issueComments: {
      totalCount: number;
    };
  };
}

export interface PaginatedResponse<T> {
  totalCount: number;
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string;
  };
  nodes: T[];
}
