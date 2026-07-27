# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-27

### Changed

- `github:actions:dispatch:await` now asks GitHub for the details of the run it
  created (`return_run_details`, as adopted upstream in
  [backstage#33132](https://github.com/backstage/backstage/pull/33132)) and
  polls that run by id. Matching runs by `run-name` against `trigger_event` is
  kept only as a fallback for GitHub deployments that do not return run details.
  No template or workflow changes are required.

### Added

- Optional `timeoutSeconds` input (default `3600`). Previously the action polled
  forever if the run never appeared or never finished.
- Optional `pollIntervalSeconds` input (default `5`).
- `workflowRunId` output.
- `workflowRunUrl` is now emitted as soon as the run is known, so the link is
  available while the run is still in progress, and is emitted on dry runs too.

### Fixed

- The poll loop honours the scaffolder task's abort signal instead of running on
  after the task has been cancelled.
- Transient GitHub API failures no longer fail the step immediately; up to five
  consecutive failed polls are tolerated.
- The action no longer sleeps a full poll interval after the run has completed.
- Runs without a name no longer crash the fallback matching path.
- Declared the previously undeclared `axios`, `yaml`, `@backstage/errors`,
  `@backstage/plugin-scaffolder-node` and `@backstage/backend-plugin-api`
  dependencies.
- Replaced the tests that called the live GitHub API with mocked ones.

## [1.1.0] - 2025-11-13

### Changed

- Updated Backstage to version 1.44.2
- Updated dependencies across packages (app, backend, github-actions plugin)
- Updated Yarn plugin and configuration
- Updated LICENSE to MIT License under MFT Energy A/S 2025

### Fixed

- Updated dependency tree with latest compatible versions

## [1.0.0] - 2025-11-13

### Added

- Initial release
