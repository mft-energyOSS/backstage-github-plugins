import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { InputError } from '@backstage/errors';
import axios from 'axios';
import { examples } from './createGithubActionsDispatchAwaitAction.examples';
import { GithubCredentialsProvider } from '@backstage/integration';

const GITHUB_API = 'https://api.github.com';

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const DEFAULT_TIMEOUT_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/**
 * Number of consecutive failed polls tolerated before giving up. A single 5xx
 * or a secondary rate limit should not kill a long-running deployment.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

interface ActionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface ActionContextLike {
  logger: ActionLogger;
  signal?: AbortSignal;
}

/**
 * The run details GitHub returns from the dispatch endpoint when
 * `return_run_details` is requested.
 */
interface WorkflowRunDetails {
  runId: number;
  htmlUrl: string;
}

interface TriggerWorkflowParams {
  ctx: ActionContextLike;
  owner: string;
  repo: string;
  workflow: string | number;
  branchName: string;
  inputs: { trigger_event?: string } & {
    [k: string]: string;
  };
  token: string;
}

interface AwaitWorkflowCompletionParams {
  ctx: ActionContextLike;
  owner: string;
  repo: string;
  workflow: string | number;
  branchName: string;
  inputs: { trigger_event?: string } & {
    [k: string]: string;
  };
  token: string;
  /**
   * Authoritative run to poll. When absent we fall back to matching runs by
   * their display name against `inputs.trigger_event`.
   */
  runDetails?: WorkflowRunDetails;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}

function authHeaders(token: string) {
  return { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted while waiting for workflow completion'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Aborted while waiting for workflow completion'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Dispatches the workflow and, when GitHub supports it, returns the details of
 * the run that was created.
 *
 * `return_run_details` is not part of the published REST documentation yet, so
 * an older GitHub (or GHES) may keep answering `204 No Content`. In that case
 * we return `undefined` and the caller falls back to name matching.
 */
async function triggerWorkflow({
  ctx,
  owner,
  repo,
  workflow,
  branchName,
  inputs,
  token,
}: TriggerWorkflowParams): Promise<WorkflowRunDetails | undefined> {
  if (!inputs.trigger_event) {
    throw new Error(
      'Missing input `trigger_event`. Provide this input with unique value so that workflow can be uniquely identified.',
    );
  }

  ctx.logger.info(`Triggering workflow ${workflow} for repo ${owner}/${repo}`);

  const { status, data } = await axios.post(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      ref: branchName,
      inputs: inputs,
      return_run_details: true,
    },
    { headers: authHeaders(token), signal: ctx.signal },
  );

  ctx.logger.info(
    `Workflow ${workflow} triggered successfully with status ${status}`,
  );

  if (data?.workflow_run_id) {
    return {
      runId: data.workflow_run_id as number,
      htmlUrl: data.html_url as string,
    };
  }

  ctx.logger.warn(
    `GitHub did not return workflow run details for ${workflow}. Falling back to matching the run by name against trigger_event.`,
  );
  return undefined;
}

/**
 * Fetches the run to await.
 *
 * With `runDetails` this is a direct lookup by id. Without it we list recent
 * dispatch runs on the branch and match `trigger_event` against the run name,
 * which requires the workflow to set `run-name` accordingly.
 */
async function fetchRun({
  owner,
  repo,
  workflow,
  branchName,
  inputs,
  token,
  runDetails,
  signal,
}: {
  owner: string;
  repo: string;
  workflow: string | number;
  branchName: string;
  inputs: { trigger_event?: string };
  token: string;
  runDetails?: WorkflowRunDetails;
  signal?: AbortSignal;
}): Promise<
  { status: string; conclusion: string | null; html_url: string } | undefined
> {
  if (runDetails) {
    const response = await axios.get(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/actions/runs/${runDetails.runId}`,
      { headers: authHeaders(token), signal },
    );
    return response.data;
  }

  const response = await axios.get(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
    {
      headers: authHeaders(token),
      signal,
      params: {
        event: 'workflow_dispatch',
        branch: branchName,
        per_page: 100,
      },
    },
  );

  const runs = response.data.workflow_runs ?? [];
  return runs.find((run: { name?: string }) =>
    run.name?.includes(inputs.trigger_event!),
  );
}

async function awaitWorkflowCompletion({
  ctx,
  owner,
  repo,
  workflow,
  branchName,
  inputs,
  token,
  runDetails,
  timeoutSeconds,
  pollIntervalSeconds,
}: AwaitWorkflowCompletionParams): Promise<{
  conclusion: string;
  workflowRunUrl: string;
}> {
  let workflowRunUrl = runDetails?.htmlUrl ?? '';
  let consecutiveFailures = 0;

  const deadline = Date.now() + timeoutSeconds * 1000;

  for (;;) {
    if (ctx.signal?.aborted) {
      throw new Error('Aborted while waiting for workflow completion');
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutSeconds}s waiting for workflow ${workflow} in ${owner}/${repo} to complete.${
          workflowRunUrl ? ` Run: ${workflowRunUrl}` : ''
        }`,
      );
    }

    let run;
    try {
      run = await fetchRun({
        owner,
        repo,
        workflow,
        branchName,
        inputs,
        token,
        runDetails,
        signal: ctx.signal,
      });
      consecutiveFailures = 0;
    } catch (error) {
      if (ctx.signal?.aborted) {
        throw error;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw error;
      }

      ctx.logger.warn(
        `Failed to poll workflow run (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES}): ${
          (error as Error).message
        }`,
      );
      await sleep(pollIntervalSeconds * 1000, ctx.signal);
      continue;
    }

    if (run) {
      workflowRunUrl = run.html_url;
      ctx.logger.info(`Checking status for workflow run ${workflowRunUrl}`);

      if (run.status === 'completed') {
        const conclusion = run.conclusion ?? 'unknown';
        if (conclusion !== 'success') {
          ctx.logger.error(
            `Workflow did not succeed. Conclusion: ${conclusion}`,
          );
          throw new Error(
            `Workflow did not succeed. Conclusion: ${conclusion}`,
          );
        }
        ctx.logger.info(
          `Workflow completed successfully. Conclusion: ${conclusion}`,
        );
        return { conclusion, workflowRunUrl };
      }
    }

    await sleep(pollIntervalSeconds * 1000, ctx.signal);
  }
}

/**
 * Creates a `github:actions:dispatch:await` Scaffolder action.
 *
 * @remarks
 *
 * Dispatches a GitHub Actions workflow and blocks until the resulting run
 * reaches a conclusion.
 *
 * @public
 */
export function createGithubActionsDispatchAwaitAction(options: {
  githubCredentialsProvider: GithubCredentialsProvider;
}) {
  const { githubCredentialsProvider } = options;

  return createTemplateAction({
    id: 'github:actions:dispatch:await',
    description: 'Trigger and await GitHub Action',
    examples,
    supportsDryRun: true,
    schema: {
      input: z => z.object({
        repo: z.string().describe('Name of the repository'),
        owner: z
          .string()
          .describe('Name of the owner. Could be organization or user'),
        workflow: z
          .string()
          .or(z.number())
          .describe('Id or filename of the workflow'),
        branchName: z
          .string()
          .describe('Name of the branch to trigger the workflow on'),
        inputs: z
          .object({
            trigger_event: z
              .string()
              .describe('Trigger event for the workflow'),
          })
          .catchall(z.string())
          .describe('Inputs to the workflow'),
        timeoutSeconds: z
          .number()
          .optional()
          .describe(
            `How long to wait for the workflow run to complete before failing the step. Defaults to ${DEFAULT_TIMEOUT_SECONDS}`,
          ),
        pollIntervalSeconds: z
          .number()
          .optional()
          .describe(
            `How often to poll GitHub for the run status. Defaults to ${DEFAULT_POLL_INTERVAL_SECONDS}`,
          ),
      }),
      output: z => z.object({
        conclusion: z
          .string()
          .describe("Conclusion of the workflow"),
        workflowRunUrl: z
          .string()
          .describe("URL link to workflow run"),
        workflowRunId: z
          .number()
          .optional()
          .describe("Id of the workflow run, when reported by GitHub"),
      }),
    },
    async handler(ctx) {
      const {
        owner,
        repo,
        workflow,
        branchName,
        inputs,
        timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
        pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS,
      } = ctx.input;

      const { token } = await githubCredentialsProvider.getCredentials({
        url: `https://github.com/${encodeURIComponent(
          owner,
        )}/${encodeURIComponent(repo)}`,
      });

      if (!token) {
        ctx.logger.error(
          `Failed to retrieve token for: https://github.com/${owner}/${repo}`,
        );
        throw new InputError(
          `No token available for: https://github.com/${owner}/${repo}. Make sure GitHub auth is configured correctly. See https://backstage.io/docs/auth/github/provider for more details.`,
        );
      }

      if (ctx.isDryRun) {
        ctx.logger.info(
          `Requested credentials from https://github.com/repos/${owner}/${repo}`,
        );
        ctx.logger.info(
          `Will tigger the workflow ${workflow} for repo ${owner}/${repo} on branch ${branchName} with inputs ${inputs}`,
        );
        ctx.logger.info(
          `Will await completion of the workflow ${workflow} for repo ${owner}/${repo}, timing out after ${timeoutSeconds}s`,
        );
        ctx.logger.info(`Dry run complete`);
        ctx.output('conclusion', 'dry-run');
        ctx.output(
          'workflowRunUrl',
          `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`,
        );
        return;
      }

      const runDetails = await triggerWorkflow({
        ctx,
        owner,
        repo,
        workflow,
        branchName,
        inputs,
        token,
      });

      // Surface the run as soon as we know it, so operators can follow along
      // instead of staring at a step that blocks for minutes.
      if (runDetails) {
        ctx.logger.info(`Awaiting workflow run ${runDetails.htmlUrl}`);
        ctx.output('workflowRunId', runDetails.runId);
        ctx.output('workflowRunUrl', runDetails.htmlUrl);
      }

      const { conclusion, workflowRunUrl } = await awaitWorkflowCompletion({
        ctx,
        owner,
        repo,
        workflow,
        branchName,
        inputs,
        token,
        runDetails,
        timeoutSeconds,
        pollIntervalSeconds,
      });

      ctx.output('conclusion', conclusion);
      ctx.output('workflowRunUrl', workflowRunUrl);
    },
  });
}
