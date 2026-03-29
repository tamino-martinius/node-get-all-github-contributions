import type { PaginatedResponse } from "./general";

export interface OrganizationNode {
	id: string;
	login: string;
	name: string;
	avatarUrl: string;
	url: string;
}

export interface OrganizationsPage
	extends PaginatedResponse<OrganizationNode> {}

export interface OrganizationsPageResponse {
	viewer: {
		organizations: OrganizationsPage;
	};
}
