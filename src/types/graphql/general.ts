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
    login: string;
    avatarUrl: string;
    url: string;
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
