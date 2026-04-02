import { GitHubApi } from "./GitHubApi.js";
import type { BranchNode } from "./types/graphql/branch.js";
import type { OrganizationNode } from "./types/graphql/organization.js";
import type { RepositoryNode } from "./types/graphql/repository.js";
import type {
  Account,
  AccountProgress,
  Branch,
  Commit,
  ImportConfig,
  ImportData,
  ProgressStats,
  Repository,
} from "./types/import.js";
import { Logger } from "./util/Logger.js";
import { runParallel } from "./util/runParallel.js";

type SyncAccountBaseDataProps = {
  githubApi: GitHubApi;
  accountData: Account;
  accountLogin: string;
  accountProgress: AccountProgress;
};

type SyncRepositoriesProps = SyncAccountBaseDataProps & {
  organizationNodes: OrganizationNode[];
};

type SyncBranchesProps = Omit<SyncRepositoriesProps, "organizationNodes"> & {
  repositoryNode: RepositoryNode;
};

type SyncCommitsProps = SyncBranchesProps & {
  branchNode: BranchNode;
};

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_MAX_RETRIES = 2;

const DEFAULT_PROGRESS_STATS: ProgressStats = {
  repoCount: 0,
  branchCount: 0,
  commitCount: 0,
  additionCount: 0,
  deletionCount: 0,
  changedFileCount: 0,
};

export class GetAllGitHubContributions {
  #data: ImportData;
  #concurrency: number;
  #maxRetries: number;
  #pageSize?: number;
  #rateLimitGracePeriod?: number;
  #skippedOrganizations: string[];
  #skippedRepositories: string[];
  #recheckWithRemainingRateLimit: boolean;
  #tokens: Record<string, string>;

  constructor(props: {
    config: ImportConfig;
    data?: ImportData;
  }) {
    this.#tokens = props.config.tokens;
    this.#concurrency = props.config.import?.concurrency ?? DEFAULT_CONCURRENCY;
    this.#maxRetries = props.config.import?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#pageSize = props.config.import?.pageSize;
    this.#recheckWithRemainingRateLimit =
      props.config.import?.recheckWithRemainingRateLimit ?? false;
    this.#rateLimitGracePeriod = props.config.import?.rateLimitGracePeriod;
    this.#skippedOrganizations = props.config.import?.skip?.organizations ?? [];
    this.#skippedRepositories = props.config.import?.skip?.repositories ?? [];
    this.#data = props.data ?? {
      accounts: {},
      languageColors: {},
      importState: { accountProgress: {} },
    };
  }

  #runParallel<T, U>(props: {
    items: T[];
    callback: (item: T) => Promise<U>;
  }): Promise<U[]> {
    return runParallel({
      items: props.items,
      callback: props.callback,
      maxConcurrency: this.#concurrency,
      maxRetries: this.#maxRetries,
    });
  }

  async #runFlattenParallel<T, U>(props: {
    items: T[];
    callback: (item: T) => Promise<U[]>;
  }): Promise<U[]> {
    const results = await this.#runParallel({
      items: props.items,
      callback: props.callback,
    });
    return results.flat();
  }

  #printProgressDot() {
    if (["log", "debug"].includes(Logger.logLevel)) {
      // Don't print progress dots in log or debug mode
      return;
    }
    process.stdout.write(".");
  }

  #clearProgressDot() {
    if (["log", "debug"].includes(Logger.logLevel)) {
      // Don't clear progress dots in log or debug mode
      return;
    }
    process.stdout.write("\n");
  }

  #getInitialAccountProgress(accountLogin: string): AccountProgress {
    const currentAccountData = this.#data.accounts[accountLogin];
    const currentAccountDataRepositories = Object.values(
      currentAccountData?.repositories ?? [],
    );
    const currentAccountDataBranches = currentAccountDataRepositories.flatMap(
      (repository) => Object.values(repository.branches),
    );
    const currentAccountDataCommits = currentAccountDataRepositories.flatMap(
      (repository) => Object.values(repository.commits),
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
    return {
      rateLimit: {},
      progressStats: {
        initial: { ...initialProgressStats },
        total: { ...initialProgressStats },
        current: { ...DEFAULT_PROGRESS_STATS },
        new: { ...DEFAULT_PROGRESS_STATS },
      },
      status: Object.keys(this.#tokens).includes(accountLogin)
        ? "pending"
        : "unknown",
    };
  }

  #initializeAccountProgress(): Record<string, AccountProgress> {
    const configuredAccountLogins = Object.keys(this.#tokens);
    const nonConfiguredAccountLogins = Object.keys(this.#data.accounts).filter(
      (accountLogin) => !configuredAccountLogins.includes(accountLogin),
    );
    const configuredAccountProgress = configuredAccountLogins.reduce<
      Record<string, AccountProgress>
    >((record, accountLogin) => {
      record[accountLogin] = this.#getInitialAccountProgress(accountLogin);
      return record;
    }, {});
    const nonConfiguredAccountProgress = nonConfiguredAccountLogins.reduce<
      Record<string, AccountProgress>
    >((record, accountLogin) => {
      record[accountLogin] = this.#getInitialAccountProgress(accountLogin);
      return record;
    }, {});
    this.#data.importState.accountProgress = {
      ...configuredAccountProgress,
      ...nonConfiguredAccountProgress,
    };
    return configuredAccountProgress;
  }

  async #syncAccountBaseData(
    props: SyncAccountBaseDataProps,
  ): Promise<SyncRepositoriesProps> {
    const { accountLogin, accountProgress, accountData, githubApi } = props;
    Logger.log("Syncing account base data for", accountLogin);
    accountProgress.status = "in-progress";
    const user = await githubApi.getCurrentUser();
    accountData.user = {
      id: user.id,
      login: user.login,
      name: user.name ?? "",
      bio: user.bio ?? "",
      gistCount: user.gists.totalCount,
      followerCount: user.followers.totalCount,
      followingCount: user.following.totalCount,
      commitCommentCount: accountData.user?.commitCommentCount ?? 0,
      issueCommentCount: accountData.user?.issueCommentCount ?? 0,
      commitCommentTimestamps: accountData.user?.commitCommentTimestamps ?? [],
      issueCommentTimestamps: accountData.user?.issueCommentTimestamps ?? [],
      avatarUrl: user.avatarUrl,
      url: user.url,
    };
    const organizationNodes = await githubApi.getAllOrganizationNodes();
    for (const organizationNode of organizationNodes) {
      accountData.organizations[organizationNode.id] = organizationNode;
    }
    if (
      accountData.user.commitCommentCount !== user.commitComments.totalCount
    ) {
      const commitCommentNodes = await githubApi.getAllCommitCommentNodes();
      accountData.user.commitCommentTimestamps = [
        ...new Set([
          ...accountData.user.commitCommentTimestamps,
          ...commitCommentNodes.map((commitCommentNode) =>
            new Date(commitCommentNode.createdAt).getTime(),
          ),
        ]),
      ];
      accountData.user.commitCommentCount = user.commitComments.totalCount;
    }
    if (accountData.user.issueCommentCount !== user.issueComments.totalCount) {
      const issueCommentNodes = await githubApi.getAllIssueCommentNodes();
      accountData.user.issueCommentTimestamps = [
        ...new Set([
          ...accountData.user.issueCommentTimestamps,
          ...issueCommentNodes.map((issueCommentNode) =>
            new Date(issueCommentNode.createdAt).getTime(),
          ),
        ]),
      ];
      accountData.user.issueCommentCount = user.issueComments.totalCount;
    }
    return {
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      organizationNodes,
    };
  }

  async #syncRepositories(
    props: SyncRepositoriesProps,
  ): Promise<SyncBranchesProps[]> {
    const {
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      organizationNodes,
    } = props;
    Logger.log(
      "Syncing repositories for",
      accountLogin,
      organizationNodes.map((organizationNode) => organizationNode.login),
    );
    const repositoryNodes = await githubApi.getAllRepositoryNodes();
    for (const repositoryNode of repositoryNodes) {
      for (const language of repositoryNode.languages.nodes) {
        this.#data.languageColors[language.name] = language.color;
      }
      const currentRepositoryData: Repository | undefined =
        accountData.repositories[repositoryNode.id];
      if (!currentRepositoryData) {
        accountProgress.progressStats.total.repoCount += 1;
      }
      accountData.repositories[repositoryNode.id] = {
        name: repositoryNode.name,
        description: repositoryNode.description ?? "",
        stargazerCount: repositoryNode.stargazerCount,
        forkCount: repositoryNode.forkCount,
        isPrivate: repositoryNode.isPrivate,
        url: repositoryNode.url,
        homepageUrl: repositoryNode.homepageUrl,
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
        await githubApi.getAllRepositoryNodesByOrganization(organizationNode);
      for (const repositoryNode of organizationRepositoryNodes) {
        for (const language of repositoryNode.languages.nodes) {
          this.#data.languageColors[language.name] = language.color;
        }
        const currentRepositoryData: Repository | undefined =
          accountData.repositories[repositoryNode.id];
        if (!currentRepositoryData) {
          accountProgress.progressStats.total.repoCount += 1;
          accountProgress.progressStats.new.repoCount += 1;
        }
        accountData.repositories[repositoryNode.id] = {
          name: repositoryNode.name,
          description: repositoryNode.description ?? "",
          stargazerCount: repositoryNode.stargazerCount,
          forkCount: repositoryNode.forkCount,
          isPrivate: repositoryNode.isPrivate,
          url: repositoryNode.url,
          homepageUrl: repositoryNode.homepageUrl,
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
    return Object.values(currentRepositoryNodes).map((repositoryNode) => ({
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      repositoryNode,
    }));
  }

  async #syncBranches(props: SyncBranchesProps): Promise<SyncCommitsProps[]> {
    const {
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      repositoryNode,
    } = props;
    Logger.log("Syncing branches for", accountLogin, repositoryNode.name);
    const currentRepositoryData = accountData.repositories[repositoryNode.id];
    const lastCommitTimestamp = new Date(repositoryNode.pushedAt).getTime();
    const isSkipped =
      this.#skippedOrganizations.includes(repositoryNode.owner.login) ||
      this.#skippedRepositories.includes(
        `${repositoryNode.owner.login}/${repositoryNode.name}`,
      );
    const hasNoUpdates =
      currentRepositoryData.lastCommitTimestamp &&
      currentRepositoryData.lastCommitTimestamp === lastCommitTimestamp;
    if (isSkipped || hasNoUpdates) {
      accountProgress.progressStats.current.repoCount += 1;
      accountProgress.progressStats.current.branchCount += Object.values(
        currentRepositoryData.branches,
      ).length;
      return [];
    }
    const branchNodes =
      await githubApi.getAllBranchNodesByRepository(repositoryNode);

    for (const branchNode of branchNodes) {
      const currentBranchData: Branch | undefined =
        currentRepositoryData.branches[branchNode.id];
      if (!currentBranchData) {
        accountProgress.progressStats.total.branchCount += 1;
        accountProgress.progressStats.new.branchCount += 1;
      }
      currentRepositoryData.branches[branchNode.id] = {
        name: branchNode.name,
        latestCommitOid: currentBranchData?.latestCommitOid,
      };
    }

    // Update the last commit timestamp after all branches are synced
    currentRepositoryData.lastCommitTimestamp = lastCommitTimestamp;
    accountProgress.progressStats.current.repoCount += 1;

    return branchNodes.map((branchNode) => ({
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      repositoryNode,
      branchNode,
    }));
  }

  async #syncCommits(
    props: SyncCommitsProps,
    recheck: boolean = false,
  ): Promise<void> {
    const {
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      repositoryNode,
      branchNode,
    } = props;
    Logger.log(
      "Syncing commits for",
      accountLogin,
      repositoryNode.name,
      branchNode.name,
    );
    const currentRepositoryData = accountData.repositories[repositoryNode.id];
    const currentBranchData = currentRepositoryData.branches[branchNode.id];
    const hasNoUpdates =
      currentBranchData.latestCommitOid &&
      currentBranchData.latestCommitOid === branchNode.target.oid;
    if (hasNoUpdates && !recheck) {
      accountProgress.progressStats.current.branchCount += 1;
      return;
    }

    const commitNodes = await githubApi.getAllCommitNodesByBranch(
      repositoryNode,
      branchNode,
    );
    for (const commitNode of commitNodes) {
      const currentCommitData: Commit | undefined =
        currentRepositoryData.commits[commitNode.oid];
      if (!currentCommitData) {
        accountProgress.progressStats.total.commitCount += 1;
        accountProgress.progressStats.total.additionCount +=
          commitNode.additions;
        accountProgress.progressStats.total.deletionCount +=
          commitNode.deletions;
        accountProgress.progressStats.total.changedFileCount +=
          commitNode.changedFilesIfAvailable ?? 0;
        accountProgress.progressStats.new.commitCount += 1;
        accountProgress.progressStats.new.additionCount += commitNode.additions;
        accountProgress.progressStats.new.deletionCount += commitNode.deletions;
        accountProgress.progressStats.new.changedFileCount +=
          commitNode.changedFilesIfAvailable ?? 0;
      }
      currentRepositoryData.commits[commitNode.oid] = {
        oid: commitNode.oid,
        additions: commitNode.additions,
        deletions: commitNode.deletions,
        changedFiles: commitNode.changedFilesIfAvailable ?? 0,
        commitedAtTimestamp: new Date(commitNode.committedDate).getTime(),
      };
    }

    // Update the latest commit oid after all commits are synced
    currentBranchData.latestCommitOid = branchNode.target.oid;
    accountProgress.progressStats.current.branchCount += 1;
  }

  #getPropsWithRemainingRateLimit(
    commitSyncProps: SyncCommitsProps[],
  ): SyncCommitsProps[] {
    return commitSyncProps.filter(
      (commitSyncProp) =>
        (commitSyncProp.accountProgress.rateLimit.remaining ?? 0) > 0,
    );
  }

  #shuffleArray<T>(array: T[]): T[] {
    return array.sort(() => Math.random() - 0.5);
  }

  async #recheckCommits(commitSyncProps: SyncCommitsProps[]): Promise<void> {
    // Priotize Branches without commits
    const commitSyncPropsWithoutCommits = this.#shuffleArray(
      this.#getPropsWithRemainingRateLimit(
        commitSyncProps.filter(
          (commitSyncProp) =>
            Object.keys(
              commitSyncProp.accountData.repositories[
                commitSyncProp.repositoryNode.id
              ].commits[commitSyncProp.branchNode.id],
            ).length === 0,
        ),
      ),
    );
    // Process one by one to avoid hitting the rate limit on many in parallel
    for (const commitSyncProp of commitSyncPropsWithoutCommits) {
      await this.#syncCommits(commitSyncProp, true);
    }

    // Recheck all other branches
    const commitSyncPropsWithoutCommitIds = new Set(
      commitSyncPropsWithoutCommits.map(
        (commitSyncProp) => commitSyncProp.branchNode.id,
      ),
    );
    const commitSyncPropsWithCommits = this.#shuffleArray(
      this.#getPropsWithRemainingRateLimit(
        commitSyncProps.filter(
          (commitSyncProp) =>
            !commitSyncPropsWithoutCommitIds.has(commitSyncProp.branchNode.id),
        ),
      ),
    );
    // Process one by one to avoid hitting the rate limit on many in parallel
    for (const commitSyncProp of commitSyncPropsWithCommits) {
      await this.#syncCommits(commitSyncProp, true);
    }
  }

  async sync() {
    console.log("Syncing GitHub contributions");
    const startTime = Date.now();
    const accountProgress = this.#initializeAccountProgress();
    this.#data.importState = {
      lastFullImportTimestamp: this.#data.importState.lastFullImportTimestamp,
      currentProgressTimestamp: Date.now(),
      accountProgress,
    };

    console.log(
      "Syncing initial progress stats:",
      Object.fromEntries(
        Object.entries(accountProgress).map(
          ([accountLogin, accountProgress]) => [
            accountLogin,
            accountProgress.progressStats.initial,
          ],
        ),
      ),
    );

    const accountSyncProps = Object.entries(accountProgress).map(
      ([accountLogin, accountProgress]) => {
        if (!this.#data.accounts[accountLogin]) {
          this.#data.accounts[accountLogin] = {
            repositories: {},
            organizations: {},
          };
        }
        const accountData = this.#data.accounts[accountLogin];
        const githubApi = new GitHubApi({
          token: this.#tokens[accountLogin],
          pageSize: this.#pageSize,
          rateLimitGracePeriod: this.#rateLimitGracePeriod,
          onRateLimitChange: (rateLimit) => {
            accountProgress.rateLimit = rateLimit;
          },
          onApiCall: this.#printProgressDot,
        });
        return {
          accountLogin,
          accountProgress,
          accountData,
          githubApi,
        };
      },
    );

    console.log("Syncing user and organizations");
    Logger.debug("Account sync props:", accountSyncProps);
    const repositorySyncProps = await this.#runParallel({
      items: accountSyncProps,
      callback: this.#syncAccountBaseData.bind(this),
    });
    this.#clearProgressDot();

    console.log("Syncing repositories");
    const branchSyncProps = await this.#runFlattenParallel({
      items: repositorySyncProps,
      callback: this.#syncRepositories.bind(this),
    });
    this.#clearProgressDot();

    console.log("Syncing branches");
    const commitSyncProps = await this.#runFlattenParallel({
      items: branchSyncProps,
      callback: this.#syncBranches.bind(this),
    });
    this.#clearProgressDot();

    console.log("Syncing commits");
    await runParallel({
      items: commitSyncProps,
      callback: this.#syncCommits.bind(this),
      maxConcurrency: this.#concurrency,
      maxRetries: this.#maxRetries,
    });
    this.#clearProgressDot();

    if (this.#recheckWithRemainingRateLimit) {
      console.log("Rechecking commits");
      await this.#recheckCommits(commitSyncProps);
      this.#clearProgressDot();
    }

    this.#data.importState.lastFullImportTimestamp = Date.now();
    Object.values(accountProgress).forEach((accountProgress) => {
      accountProgress.status = "completed";
    });

    const duration = Date.now() - startTime;
    console.log(
      `Syncing completed in ${(duration / 1000 / 60).toFixed(2)} minutes`,
      Object.fromEntries(
        Object.entries(accountProgress).map(
          ([accountLogin, accountProgress]) => [
            accountLogin,
            accountProgress.progressStats.new,
          ],
        ),
      ),
    );
    console.log(`Syncing completed in ${duration}ms`);
  }
}
