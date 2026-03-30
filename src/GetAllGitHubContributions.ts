import { GitHubApi } from "./GitHubApi";
import type { BranchNode } from "./types/graphql/branch";
import type { OrganizationNode } from "./types/graphql/organization";
import type { RepositoryNode } from "./types/graphql/repository";
import type {
  Account,
  AccountProgress,
  Branch,
  Commit,
  ImportConfig,
  ImportData,
  ProgressStats,
  Repository,
} from "./types/import";
import { Logger } from "./util/Logger";
import { runParallel } from "./util/runParallel";

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
  #config: ImportConfig;
  #data: ImportData;
  #concurrency: number;
  #maxRetries: number;

  constructor(props: {
    config: ImportConfig;
    data?: ImportData;
  }) {
    this.#config = props.config;
    this.#data = props.data ?? {
      accounts: {},
      languageColors: {},
      importState: { accountProgress: {} },
    };
    this.#concurrency = props.config.import?.concurrency ?? DEFAULT_CONCURRENCY;
    this.#maxRetries = props.config.import?.maxRetries ?? DEFAULT_MAX_RETRIES;
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
      status: Object.keys(this.#config.tokens).includes(accountLogin)
        ? "pending"
        : "unknown",
    };
  }

  #initializeAccountProgress(): Record<string, AccountProgress> {
    const configuredAccountLogins = Object.keys(this.#config.tokens);
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
    accountData.user = user;
    const organizationNodes = await githubApi.getAllOrganizationNodes();
    for (const organizationNode of organizationNodes) {
      accountData.organizations[organizationNode.id] = organizationNode;
    }
    this.#printProgressDot();
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
    this.#printProgressDot();
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
    if (
      currentRepositoryData.lastCommitTimestamp &&
      currentRepositoryData.lastCommitTimestamp === lastCommitTimestamp
    ) {
      // No pushes since last sync, so no branches to sync
      accountProgress.progressStats.current.repoCount += 1;
      accountProgress.progressStats.current.branchCount += Object.values(
        currentRepositoryData.branches,
      ).length;
      this.#printProgressDot();
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

    this.#printProgressDot();
    return branchNodes.map((branchNode) => ({
      accountLogin,
      accountProgress,
      accountData,
      githubApi,
      repositoryNode,
      branchNode,
    }));
  }

  async #syncCommits(props: SyncCommitsProps): Promise<void> {
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
    if (
      currentBranchData.latestCommitOid &&
      currentBranchData.latestCommitOid === branchNode.target.oid
    ) {
      // No new commits since last sync, so no commits to sync
      accountProgress.progressStats.current.branchCount += 1;
      this.#printProgressDot();
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
    this.#printProgressDot();
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
          token: this.#config.tokens[accountLogin],
          onRateLimitChange: (rateLimit) => {
            accountProgress.rateLimit = rateLimit;
          },
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
    const historySyncProps = await this.#runFlattenParallel({
      items: branchSyncProps,
      callback: this.#syncBranches.bind(this),
    });
    this.#clearProgressDot();

    console.log("Syncing commits");
    await runParallel({
      items: historySyncProps,
      callback: this.#syncCommits.bind(this),
      maxConcurrency: this.#concurrency,
      maxRetries: this.#maxRetries,
    });
    this.#clearProgressDot();

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
