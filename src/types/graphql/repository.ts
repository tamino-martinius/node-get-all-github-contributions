import type { PaginatedResponse } from "./general.js";

export interface RepositoryNode {
  id: string;
  name: string;
  description?: string;
  isPrivate: boolean;
  pushedAt: string;
  url: string;
  homepageUrl?: string;
  stargazerCount: number;
  forkCount: number;
  languages: {
    nodes: {
      name: string;
      color: string;
    }[];
  };
  owner: {
    login: string;
  };
  defaultBranchRef?: {
    name: string;
  };
}

export interface RepositoriesPage extends PaginatedResponse<RepositoryNode> {}

export interface RepositoriesPageResponse {
  viewer: {
    repositories: RepositoriesPage;
  };
}

export interface OrganizationRepositoriesPageResponse {
  organization: {
    repositories: RepositoriesPage;
  };
}
