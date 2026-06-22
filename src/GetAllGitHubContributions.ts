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
  #branchRecheckBuckets: number;
  #incrementalHistory: boolean;
  #activeBranchBucket = 0;
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
    this.#branchRecheckBuckets = props.config.import?.branchRecheckBuckets ?? 0;
    this.#incrementalHistory = props.config.import?.incrementalHistory ?? false;
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
    continueOnError?: boolean;
  }): Promise<U[]> {
    return runParallel({
      items: props.items,
      callback: props.callback,
      maxConcurrency: this.#concurrency,
      maxRetries: this.#maxRetries,
      continueOnError: props.continueOnError,
    });
  }

  async #runFlattenParallel<T, U>(props: {
    items: T[];
    callback: (item: T) => Promise<U[]>;
    continueOnError?: boolean;
  }): Promise<U[]> {
    const results = await this.#runParallel({
      items: props.items,
      callback: props.callback,
      continueOnError: props.continueOnError,
    });
    // Items that failed (and were skipped via continueOnError) leave holes in
    // the results array; flat() drops them, so downstream stages only see the
    // work that actually succeeded.
    return results.flat();
  }

  // Stable bucket assignment for a branch. djb2 over the id, then the murmur3
  // fmix32 finalizer so the low bits are well mixed (plain djb2 % buckets is
  // badly skewed for power-of-two bucket counts). Stable across runs because
  // branch node ids are stable.
  #bucketOf(id: string, buckets: number): number {
    let hash = 5381;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return (hash >>> 0) % buckets;
  }

  // A repository is fully synced once every recorded branch has had its commits
  // fetched at least once (latestCommitOid set). A repository with branches
  // still awaiting their first fetch is re-enumerated every run so nothing is
  // permanently stranded. (An empty branch set is vacuously fully synced.)
  #isRepositoryFullySynced(repository: Repository): boolean {
    return Object.values(repository.branches).every(
      (branch) => branch.latestCommitOid !== undefined,
    );
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

  async #syncBranches(
    props: SyncBranchesProps,
    options: { recheck: boolean } = { recheck: false },
  ): Promise<SyncCommitsProps[]> {
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
      currentRepositoryData.lastCommitTimestamp != null &&
      currentRepositoryData.lastCommitTimestamp === lastCommitTimestamp;
    // Skip enumeration only when nothing has been pushed since the last run AND
    // the repository is already fully synced. A not-fully-synced repository
    // (e.g. branches whose commits were deferred by rotation or never fetched)
    // is always re-enumerated so its outstanding branches are not stranded.
    if (
      isSkipped ||
      (hasNoUpdates &&
        !options.recheck &&
        this.#isRepositoryFullySynced(currentRepositoryData))
    ) {
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
        latestCommitTimestamp: currentBranchData?.latestCommitTimestamp,
      };
    }

    // Update the last commit timestamp after all branches are synced
    currentRepositoryData.lastCommitTimestamp = lastCommitTimestamp;
    accountProgress.progressStats.current.repoCount += 1;

    // Decide which branches to forward for commit syncing this run. The default
    // branch is always included; non-default branches only when their stable
    // bucket matches the active bucket for this run, so all branches are covered
    // within `#branchRecheckBuckets` runs. Rechecks and disabled rotation
    // (buckets < 2) forward every branch.
    const rotationActive = this.#branchRecheckBuckets >= 2 && !options.recheck;
    const forwardedBranchNodes = rotationActive
      ? branchNodes.filter(
          (branchNode) =>
            branchNode.name === currentRepositoryData.defaultBranch ||
            this.#bucketOf(branchNode.id, this.#branchRecheckBuckets) ===
              this.#activeBranchBucket,
        )
      : branchNodes;

    // Branches deferred to a later run still count toward the current progress.
    accountProgress.progressStats.current.branchCount +=
      branchNodes.length - forwardedBranchNodes.length;

    return forwardedBranchNodes.map((branchNode) => ({
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
    options: { recheck: boolean } = { recheck: false },
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
    if (hasNoUpdates && !options.recheck) {
      accountProgress.progressStats.current.branchCount += 1;
      return;
    }

    // Incremental fetch: once a branch has been synced before, only request the
    // user's commits newer than the last one already seen (minus a 1s buffer to
    // be safe on equal timestamps; duplicates are de-duplicated by oid below).
    // Rechecks always do a full fetch to reconcile.
    const since =
      this.#incrementalHistory &&
      !options.recheck &&
      currentBranchData.latestCommitOid &&
      currentBranchData.latestCommitTimestamp != null
        ? new Date(
            currentBranchData.latestCommitTimestamp - 1_000,
          ).toISOString()
        : undefined;

    const commitNodes = await githubApi.getAllCommitNodesByBranch(
      repositoryNode,
      branchNode,
      { since },
    );
    let latestCommitTimestamp = currentBranchData.latestCommitTimestamp;
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
      const commitedAtTimestamp = new Date(commitNode.committedDate).getTime();
      currentRepositoryData.commits[commitNode.oid] = {
        oid: commitNode.oid,
        additions: commitNode.additions,
        deletions: commitNode.deletions,
        changedFiles: commitNode.changedFilesIfAvailable ?? 0,
        commitedAtTimestamp,
      };
      if (
        latestCommitTimestamp == null ||
        commitedAtTimestamp > latestCommitTimestamp
      ) {
        latestCommitTimestamp = commitedAtTimestamp;
      }
    }

    // Update the latest commit markers after all commits are synced
    currentBranchData.latestCommitOid = branchNode.target.oid;
    currentBranchData.latestCommitTimestamp = latestCommitTimestamp;
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
        commitSyncProps.filter((commitSyncProp) => {
          const currentRepository =
            commitSyncProp.accountData.repositories[
              commitSyncProp.repositoryNode.id
            ];
          return (
            currentRepository &&
            Object.keys(currentRepository.commits).length === 0
          );
        }),
      ),
    );
    // Process one by one to avoid hitting the rate limit on many in parallel
    for (const commitSyncProp of commitSyncPropsWithoutCommits) {
      await this.#syncCommits(commitSyncProp, { recheck: true });
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
      await this.#syncCommits(commitSyncProp, { recheck: true });
    }
  }

  async sync() {
    console.log("Syncing GitHub contributions");
    const startTime = Date.now();
    const accountProgress = this.#initializeAccountProgress();

    // Advance the branch-rotation counter once per run and derive this run's
    // active bucket. The counter is persisted in importState so the rotation
    // round-robins across runs regardless of timing.
    const previousRotationCounter =
      this.#data.importState.branchRotationCounter ?? 0;
    this.#activeBranchBucket =
      this.#branchRecheckBuckets >= 2
        ? previousRotationCounter % this.#branchRecheckBuckets
        : 0;
    if (this.#branchRecheckBuckets >= 2) {
      console.log(
        `Branch rotation: bucket ${this.#activeBranchBucket + 1}/${this.#branchRecheckBuckets} active this run`,
      );
    }

    this.#data.importState = {
      lastFullImportTimestamp: this.#data.importState.lastFullImportTimestamp,
      currentProgressTimestamp: Date.now(),
      branchRotationCounter: previousRotationCounter + 1,
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
      continueOnError: true,
    });
    this.#clearProgressDot();

    console.log("Syncing commits");
    await runParallel({
      items: commitSyncProps,
      callback: this.#syncCommits.bind(this),
      maxConcurrency: this.#concurrency,
      maxRetries: this.#maxRetries,
      // A few unreachable branches (transient 403/502, lost access) should not
      // abort the run and discard everything else that synced successfully.
      continueOnError: true,
    });
    this.#clearProgressDot();

    if (this.#recheckWithRemainingRateLimit) {
      console.log("Rechecking branches");
      // Refetch all branches (including the ones which were detected to have no updates)
      const commitSyncProps = await this.#runFlattenParallel({
        items: branchSyncProps,
        callback: (branchSyncProp) =>
          this.#syncBranches(branchSyncProp, { recheck: true }),
      });
      this.#clearProgressDot();

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
