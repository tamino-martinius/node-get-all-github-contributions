import { request } from "node:https";
import { URL } from "node:url";
import type {
  BranchesPage,
  BranchesPageResponse,
  BranchNode,
} from "./types/graphql/branch.js";
import type {
  CommitNode,
  CommitsPage,
  CommitsPageResponse,
} from "./types/graphql/commit.js";
import type {
  PaginatedResponse,
  RateLimit,
  ViewerResponse,
} from "./types/graphql/general.js";
import type {
  OrganizationNode,
  OrganizationsPage,
  OrganizationsPageResponse,
} from "./types/graphql/organization.js";
import type {
  OrganizationRepositoriesPageResponse,
  RepositoriesPage,
  RepositoriesPageResponse,
  RepositoryNode,
} from "./types/graphql/repository.js";
import { Logger } from "./util/Logger.js";

interface GitHubApiOptions {
  token: string;
  apiUrl?: string;
  pageSize?: number;
  rateLimitGracePeriod?: number;
  onRateLimitChange?: (rateLimit: RateLimit) => void;
}

const DEFAULT_RATE_LIMIT_GRACE_PERIOD = 1_000; // 1 second
const DEFAULT_PAGE_SIZE = 50; // 100 items per page

export class GitHubApi {
  #token: string;
  #apiUrl: string = "https://api.github.com/graphql";
  #url: URL;
  #user?: ViewerResponse["viewer"];
  #rateLimit: RateLimit = {};
  #onRateLimitChange: (rateLimit: RateLimit) => void;
  #pageSize: number;
  #rateLimitGracePeriod: number;

  constructor(config: GitHubApiOptions) {
    this.#token = config.token;
    if (config.apiUrl) this.#apiUrl = config.apiUrl;
    this.#url = new URL(this.#apiUrl);
    this.#onRateLimitChange = config.onRateLimitChange ?? (() => {});
    this.#pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#rateLimitGracePeriod =
      config.rateLimitGracePeriod ?? DEFAULT_RATE_LIMIT_GRACE_PERIOD;
  }

  async #getToken(): Promise<string> {
    if (this.#rateLimit.remaining === undefined) {
      // Token not yet used, so we can use it
      return this.#token;
    }
    if (this.#rateLimit.remaining > 0) {
      // Token has remaining requests, so we can use it
      return this.#token;
    }
    if ((this.#rateLimit.resetTimestamp ?? 0) < Date.now()) {
      // Token has reset, so we can use it
      this.#rateLimit.resetTimestamp = undefined;
      this.#rateLimit.remaining = undefined;
      return this.#token;
    }
    return new Promise((resolve) => {
      setTimeout(
        () => {
          resolve(this.#token);
        },
        (this.#rateLimit.resetTimestamp ?? 0) -
          Date.now() +
          this.#rateLimitGracePeriod,
      );
    });
  }

  async #query<TRequest, TResponse>(
    query: string,
    variables?: TRequest,
  ): Promise<TResponse> {
    const payload = {
      query,
      variables,
    };

    Logger.send({
      log: [
        "[query]",
        "=>",
        `${query.substring(0, 50).replace(/\s+/g, " ")}...`,
        variables
          ? `${JSON.stringify(variables).substring(0, 50)}...`
          : undefined,
      ],
      debug: ["[query]", "=>", payload],
    });

    const payloadString = JSON.stringify(payload);
    const token = await this.#getToken();

    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: this.#url.hostname,
          path: this.#url.pathname,
          method: "POST",
          protocol: this.#url.protocol,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": payloadString.length,
            Authorization: `bearer ${token}`,
            "User-Agent": "GitHub GraphQL Client",
          },
        },
        (res) => {
          const chunks: string[] = [];

          res.on("data", (chunk) => {
            Logger.debug("[query]", "<=", (<Buffer>chunk).toString("utf8"));
            chunks.push((<Buffer>chunk).toString("utf8"));
          });

          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(res.statusMessage);
            }

            const response = chunks.join("");
            let json: { data?: TResponse; errors?: unknown };

            try {
              json = JSON.parse(response);
            } catch (_e) {
              return reject(
                "GitHub GraphQL API response is not able to be parsed as JSON",
              );
            }
            const rateLimitRemaining = res.headers["x-ratelimit-remaining"];
            const rateLimitUsed = res.headers["x-ratelimit-used"];
            const rateLimitReset = res.headers["x-ratelimit-reset"];
            const rateLimitLimit = res.headers["x-ratelimit-limit"];
            this.#rateLimit = {
              lastUsedTimestamp: Date.now(),
              remaining:
                typeof rateLimitRemaining === "string"
                  ? Number.parseInt(rateLimitRemaining, 10)
                  : undefined,
              resetTimestamp:
                typeof rateLimitReset === "string"
                  ? Number.parseInt(rateLimitReset, 10) * 1_000
                  : undefined,
              limit:
                typeof rateLimitLimit === "string"
                  ? Number.parseInt(rateLimitLimit, 10)
                  : undefined,
              used:
                typeof rateLimitUsed === "string"
                  ? Number.parseInt(rateLimitUsed, 10)
                  : undefined,
            };
            this.#onRateLimitChange(this.#rateLimit);
            if (!json.data) {
              if (json.errors) {
                Logger.error("[query]", "<=", json.errors);
                // TODO handle retries (rate limit/other errors)
                return reject({
                  error: json.errors,
                  rateLimit: this.#rateLimit,
                  token,
                });
              }
              Logger.error("[query]", "<=", "Unknown GraphQL error");
              return reject({
                error: "Unknown GraphQL error",
                rateLimit: this.#rateLimit,
                token,
              });
            }

            Logger.send({
              log: [
                "[query]",
                "<=",
                JSON.stringify(json.data, null, 2)
                  .substring(0, 50)
                  .replace(/\s+/g, " "),
              ],
              debug: ["[query]", "<=", json.data],
            });
            return resolve(json.data);
          });
        },
      );

      req.on("error", (err) => {
        Logger.error("[query]", "<=", err);
        reject({ error: err, token });
      });
      req.write(payloadString);
      req.end();
      Logger.debug("[query]", req);
    });
  }

  public async getCurrentUser() {
    if (this.#user) {
      return this.#user;
    }
    const response = await this.#query<Record<string, never>, ViewerResponse>(
      `
        query {
          viewer {
            id
            login
            avatarUrl
            url
          }
        }
      `,
    );
    this.#user = response.viewer;
    return response.viewer;
  }

  #createdPaginatedQuery(
    resource: string,
    cursor: string | undefined,
    filter: string,
    slot: string,
    asc: boolean = true,
  ): string {
    let pageQuery = `${asc ? "first" : "last"}: ${this.#pageSize}`;
    if (cursor) {
      pageQuery += `, ${asc ? "after" : "before"}: "${cursor}"`;
    }
    if (filter) {
      pageQuery += `, ${filter}`;
    }
    return `
      ${resource}(${pageQuery}) {
        totalCount
        pageInfo {
          ${asc ? "hasNextPage" : "hasPreviousPage"}
          ${asc ? "endCursor" : "startCursor"}
        }
        nodes {
          ${slot}
        }
      }
    `;
  }

  async #getAllPaginatedNodes<
    TRequest,
    TResponse,
    TResponseNode,
    TPaginatedResponse extends PaginatedResponse<TResponseNode>,
  >(props: {
    query: string; // the wrapping query (query { ... }) using {{pageQuery}} for the page query
    resource: string;
    filter: string;
    nodeQuery: string;
    variables?: TRequest;
    select: (response: TResponse) => TPaginatedResponse;
    asc?: boolean;
  }): Promise<TResponseNode[]> {
    const queryFn = (cursor?: string) =>
      this.#query<TRequest, TResponse>(
        props.query.replace(
          "{{pageQuery}}",
          this.#createdPaginatedQuery(
            props.resource,
            cursor,
            props.filter,
            props.nodeQuery,
            props.asc,
          ),
        ),
        props.variables,
      );
    let hasNextPage = true;
    let cursor: string | undefined;
    const nodes: TResponseNode[] = [];
    while (hasNextPage) {
      const response = await queryFn(cursor);
      const paginatedResponse = props.select(response);
      hasNextPage = paginatedResponse.pageInfo.hasNextPage;
      cursor = paginatedResponse.pageInfo.endCursor;
      nodes.push(...paginatedResponse.nodes);
    }
    return nodes;
  }

  public async getAllOrganizationNodes() {
    return this.#getAllPaginatedNodes<
      Record<string, never>,
      OrganizationsPageResponse,
      OrganizationNode,
      OrganizationsPage
    >({
      query: `
        query {
          viewer {
            {{pageQuery}}
          }
        }
      `,
      resource: "organizations",
      filter: "",
      nodeQuery: `
        id
        name
        login
        avatarUrl
        url
      `,
      select: (response) => response.viewer.organizations,
    });
  }

  public async getAllRepositoryNodes() {
    return this.#getAllPaginatedNodes<
      Record<string, never>,
      RepositoriesPageResponse,
      RepositoryNode,
      RepositoriesPage
    >({
      query: `
        query {
          viewer {
            {{pageQuery}}
          }
        }
      `,
      resource: "repositories",
      filter: "affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]",
      nodeQuery: `
        id
        name
        isPrivate
        pushedAt
        url
        languages(first: 5) {
          nodes {
            name
            color
          }
        }
        owner {
          login
        }
        defaultBranchRef {
          name
        }
      `,
      select: (response) => response.viewer.repositories,
    });
  }

  public async getAllRepositoryNodesByOrganization(
    organization: OrganizationNode,
  ) {
    return this.#getAllPaginatedNodes<
      { organization: string },
      OrganizationRepositoriesPageResponse,
      RepositoryNode,
      RepositoriesPage
    >({
      query: `
        query($organization: String!) {
          organization(login: $organization) {
            {{pageQuery}}
          }
        }
      `,
      resource: "repositories",
      filter: "affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]",
      nodeQuery: `
        id
        name
        isPrivate
        pushedAt
        url
        languages(first: 5) {
          nodes {
            name
            color
          }
        }
        owner {
          login
        }
        defaultBranchRef {
          name
        }
      `,
      select: (response) => response.organization.repositories,
      variables: {
        organization: organization.login,
      },
    });
  }

  public async getAllBranchNodesByRepository(repository: RepositoryNode) {
    return this.#getAllPaginatedNodes<
      { owner: string; name: string },
      BranchesPageResponse,
      BranchNode,
      BranchesPage
    >({
      query: `
        query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            {{pageQuery}}
          }
        }
      `,
      resource: "refs",
      filter: 'refPrefix: "refs/heads/"',
      nodeQuery: `
        id
        name
        target {
          ... on Commit {
            oid
          }
        }
      `,
      select: (response) => response.repository.refs,
      variables: {
        owner: repository.owner.login,
        name: repository.name,
      },
    });
  }

  public async getAllCommitNodesByBranch(
    repository: RepositoryNode,
    branch: BranchNode,
  ) {
    const user = await this.getCurrentUser();
    return this.#getAllPaginatedNodes<
      { owner: string; name: string; qualifiedName: string; userId: string },
      CommitsPageResponse,
      CommitNode,
      CommitsPage
    >({
      query: `
        query($owner: String!, $name: String!, $qualifiedName: String!, $userId: ID!) {
          repository(owner: $owner, name: $name) {
            ref(qualifiedName: $qualifiedName) {
              target {
                ... on Commit {
                  {{pageQuery}}
                }
              }
            }
          }
        }
      `,
      resource: "history",
      filter: `author: { id: $userId }`,
      nodeQuery: `
        oid
        additions
        deletions
        changedFilesIfAvailable
        committedDate
        committer {
          user {
            id
          }
        }
      `,
      select: (response) => response.repository.ref.target.history,
      variables: {
        owner: repository.owner.login,
        name: repository.name,
        qualifiedName: branch.name,
        userId: user.id,
      },
    });
  }
}
