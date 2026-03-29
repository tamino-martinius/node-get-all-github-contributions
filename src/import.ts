import { GitHubApi } from "./GitHubApi";
import { Logger } from "./Logger";
import type { RepositoryNode } from "./types/graphql/repository";
import type {
	AccountConfig,
	AccountProgress,
	Branch,
	Commit,
	ImportConfig,
	ImportData,
	ProgressStats,
	Repository,
} from "./types/import";

export class Import {
	#config: ImportConfig;
	#data: ImportData;
	#onDataChange?: (data: ImportData) => void;

	constructor(props: {
		config: ImportConfig;
		data?: ImportData;
		onDataChange?: (data: ImportData) => void;
	}) {
		this.#config = props.config;
		this.#data = props.data ?? {
			accounts: {},
			languageColors: {},
			importState: { accountProgress: {} },
		};
		this.#onDataChange = props.onDataChange;
	}

	#getNewAccountProgress(): Record<string, AccountProgress> {
		const configAccountLogins = this.#config.accounts.map(
			(accountConfig) => accountConfig.username,
		);
		const dataAccountLogins = Object.keys(this.#data.accounts);
		const accountLogins = [
			...new Set([...configAccountLogins, ...dataAccountLogins]),
		];
		return accountLogins.reduce<Record<string, AccountProgress>>(
			(record, accountLogin) => {
				const currentAccountData = this.#data.accounts[accountLogin];
				const currentAccountDataRepositories = Object.values(
					currentAccountData?.repositories ?? [],
				);
				const currentAccountDataBranches =
					currentAccountDataRepositories.flatMap((repository) =>
						Object.values(repository.branches),
					);
				const currentAccountDataCommits =
					currentAccountDataRepositories.flatMap((repository) =>
						Object.values(repository.commits),
					);
				const initialProgressStats: ProgressStats = {
					repoCount: currentAccountDataRepositories.length,
					branchCount: currentAccountDataBranches.length,
					commitCount: currentAccountDataCommits.length,
					additionCount: currentAccountDataCommits.reduce(
						(acc, commit) => acc + commit.additions,
						0,
					),
					deletionCount: currentAccountDataCommits.reduce(
						(acc, commit) => acc + commit.deletions,
						0,
					),
					changedFileCount: currentAccountDataCommits.reduce(
						(acc, commit) => acc + commit.changedFiles,
						0,
					),
				};

				record[accountLogin] = {
					rateLimits: [],
					progressStats: {
						initial: { ...initialProgressStats },
						total: { ...initialProgressStats },
						current: {
							repoCount: 0,
							branchCount: 0,
							commitCount: 0,
							additionCount: 0,
							deletionCount: 0,
							changedFileCount: 0,
						},
					},
					context: [],
					status: configAccountLogins.includes(accountLogin)
						? "pending"
						: "completed",
				};
				return record;
			},
			{},
		);
	}

	async sync() {
		this.#data.importState = {
			lastFullImportTimestamp: this.#data.importState.lastFullImportTimestamp,
			currentProgressTimestamp: Date.now(),
			accountProgress: this.#getNewAccountProgress(),
		};
		await Promise.all(
			this.#config.accounts.map((account) => {
				return this.syncImport(account);
			}),
		);
		this.#data.importState.lastFullImportTimestamp = Date.now();
	}

	async syncImport(account: AccountConfig) {
		const accountImportState =
			this.#data.importState.accountProgress[account.username];
		accountImportState.status = "in-progress";
		try {
			const tokenIndices = account.tokens.reduce<Record<string, number>>(
				(record, token, index) => {
					record[token] = index;
					return record;
				},
				{},
			);
			accountImportState.rateLimits = Array.from(
				{ length: account.tokens.length },
				() => ({
					lastUsedTimestamp: undefined,
					remaining: undefined,
					resetTimestamp: undefined,
					limit: undefined,
					used: undefined,
				}),
			);
			const github = new GitHubApi({
				tokens: account.tokens,
				onRateLimitChange(token, rateLimit) {
					Logger.debug(
						`Rate limit changed for token ${token}: ${JSON.stringify(rateLimit).substring(0, 100)}`,
					);
					accountImportState.rateLimits[tokenIndices[token]] = rateLimit;
				},
			});
			if (!this.#data.accounts[account.username]) {
				this.#data.accounts[account.username] = {
					repositories: {},
					organizations: {},
				};
			}
			const accountData = this.#data.accounts[account.username];
			const user = await github.getCurrentUser();
			accountData.user = user;
			const organizationNodes = await github.getAllOrganizationNodes();
			for (const organizationNode of organizationNodes) {
				accountData.organizations[organizationNode.id] = organizationNode;
			}
			const repositoryNodes = await github.getAllRepositoryNodes();
			for (const repositoryNode of repositoryNodes) {
				for (const language of repositoryNode.languages.nodes) {
					this.#data.languageColors[language.name] = language.color;
				}
				const currentRepositoryData: Repository | undefined =
					accountData.repositories[repositoryNode.id];
				if (!currentRepositoryData) {
					accountImportState.progressStats.total.repoCount += 1;
				}
				accountData.repositories[repositoryNode.id] = {
					name: repositoryNode.name,
					isPrivate: repositoryNode.isPrivate,
					url: repositoryNode.url,
					languages: repositoryNode.languages.nodes.map(
						(language) => language.name,
					),
					owner: repositoryNode.owner.login,
					defaultBranch:
						repositoryNode.defaultBranchRef?.name ??
						currentRepositoryData?.defaultBranch ??
						"main",
					branches: currentRepositoryData?.branches ?? {},
					commits: currentRepositoryData?.commits ?? {},
					lastCommitTimestamp: currentRepositoryData?.lastCommitTimestamp,
				};
			}
			const currentRepositoryNodes = repositoryNodes.reduce<
				Record<string, RepositoryNode>
			>((record, repositoryNode) => {
				record[repositoryNode.id] = repositoryNode;
				return record;
			}, {});
			for (const organizationNode of organizationNodes) {
				const organizationRepositoryNodes =
					await github.getAllRepositoryNodesByOrganization(organizationNode);
				for (const repositoryNode of organizationRepositoryNodes) {
					for (const language of repositoryNode.languages.nodes) {
						this.#data.languageColors[language.name] = language.color;
					}
					const currentRepositoryData: Repository | undefined =
						accountData.repositories[repositoryNode.id];
					if (!currentRepositoryData) {
						accountImportState.progressStats.total.repoCount += 1;
					}
					accountData.repositories[repositoryNode.id] = {
						name: repositoryNode.name,
						isPrivate: repositoryNode.isPrivate,
						url: repositoryNode.url,
						languages: repositoryNode.languages.nodes.map(
							(language) => language.name,
						),
						owner: repositoryNode.owner.login,
						defaultBranch:
							repositoryNode.defaultBranchRef?.name ??
							currentRepositoryData?.defaultBranch ??
							"main",
						branches: currentRepositoryData?.branches ?? {},
						commits: currentRepositoryData?.commits ?? {},
						lastCommitTimestamp: currentRepositoryData?.lastCommitTimestamp,
					};
					currentRepositoryNodes[repositoryNode.id] = repositoryNode;
				}
			}
			await Promise.all(
				Object.values(currentRepositoryNodes).map(async (repositoryNode) => {
					accountImportState.progressStats.current.repoCount += 1;
					const repositoryData = accountData.repositories[repositoryNode.id];
					accountImportState.context.push({
						repositoryNode,
					});
					const branchNodes =
						await github.getAllBranchNodesByRepository(repositoryNode);
					accountImportState.context[
						accountImportState.context.length - 1
					].branchCount = branchNodes.length;
					const lastCommitTimestamp = new Date(
						repositoryNode.pushedAt,
					).getTime();
					if (
						repositoryData?.lastCommitTimestamp &&
						repositoryData.lastCommitTimestamp !== lastCommitTimestamp
					) {
						return;
					}
					for (const branchNode of branchNodes) {
						accountImportState.progressStats.current.branchCount += 1;
						accountImportState.context.push({
							repositoryNode,
							branchNode,
						});
						const currentBranchData: Branch | undefined =
							repositoryData.branches[branchNode.id];
						if (!currentBranchData) {
							accountImportState.progressStats.total.branchCount += 1;
						}
						repositoryData.branches[branchNode.id] = {
							name: branchNode.name,
							latestCommitOid: currentBranchData?.latestCommitOid,
						};
						const branchData = repositoryData.branches[branchNode.id];
						if (
							currentBranchData &&
							currentBranchData.latestCommitOid === branchNode.target.oid
						) {
							continue;
						}
						const commitNodes = await github.getAllCommitNodesByBranch(
							repositoryNode,
							branchNode,
						);
						for (const commitNode of commitNodes) {
							const currentCommitData: Commit | undefined =
								repositoryData.commits[commitNode.oid];
							if (!currentCommitData) {
								accountImportState.progressStats.total.commitCount += 1;
								accountImportState.progressStats.total.additionCount +=
									commitNode.additions;
								accountImportState.progressStats.total.deletionCount +=
									commitNode.deletions;
								accountImportState.progressStats.total.changedFileCount +=
									commitNode.changedFilesIfAvailable ?? 0;
							}
							repositoryData.commits[commitNode.oid] = {
								oid: commitNode.oid,
								additions: commitNode.additions,
								deletions: commitNode.deletions,
								changedFiles: commitNode.changedFilesIfAvailable ?? 0,
								commitedAtTimestamp: new Date(
									commitNode.committedDate,
								).getTime(),
							};
							accountImportState.progressStats.current.commitCount += 1;
							accountImportState.progressStats.current.additionCount +=
								commitNode.additions;
							accountImportState.progressStats.current.deletionCount +=
								commitNode.deletions;
							accountImportState.progressStats.current.changedFileCount +=
								commitNode.changedFilesIfAvailable ?? 0;
						}
						branchData.latestCommitOid = branchNode.target.oid;
					}
					repositoryData.lastCommitTimestamp = lastCommitTimestamp;
				}),
			);
			accountImportState.status = "completed";
		} catch (err: unknown) {
			console.error(err);
			accountImportState.status = "error";
		}
	}

	public get data() {
		return this.#data;
	}
}
