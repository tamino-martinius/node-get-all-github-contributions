import type { PaginatedResponse } from "./general";

export interface BranchNode {
	id: string;
	name: string;
	target: {
		oid: string;
	};
}

export interface BranchesPage extends PaginatedResponse<BranchNode> {}

export interface BranchesPageResponse {
	repository: {
		refs: BranchesPage;
	};
}
