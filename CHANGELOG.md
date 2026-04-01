# Changelog

## 0.1.4

- Add extended user profile fields: `name`, `bio`, `gistCount`, `followerCount`, `followingCount`
- Add commit comment and issue comment tracking with timestamps
- Add repository fields: `description`, `stargazerCount`, `forkCount`, `homepageUrl`
- Add `onApiCall` callback for monitoring API requests

## 0.1.3

- Add configurable `pageSize` and `rateLimitGracePeriod` for the import script

## 0.1.2

- Implement configuration to skip repositories / organization

## 0.1.1

- Added README with usage documentation

## 0.1.0

- Initial release
- Sync GitHub contributions across multiple accounts via GraphQL API
- Concurrent API requests with configurable concurrency and retries
- Incremental sync support (skips unchanged repositories and branches)
- Rate limit handling with automatic backoff
