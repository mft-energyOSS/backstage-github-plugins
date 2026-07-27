import { createGithubActionsDispatchAwaitAction } from './createGithubActionsDispatchAwaitAction';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { ConfigReader } from '@backstage/config';
import {
  DefaultGithubCredentialsProvider,
  GithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import axios from 'axios';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('github:actions:dispatch:await', () => {
  const config = new ConfigReader({
    integrations: {
      github: [{ host: 'github.com', token: 'fake-token' }],
    },
  });

  const integrations = ScmIntegrations.fromConfig(config);
  let githubCredentialsProvider: GithubCredentialsProvider;
  let action: ReturnType<typeof createGithubActionsDispatchAwaitAction>;

  const baseInput = {
    owner: 'my-org',
    repo: 'test-repo',
    workflow: 'test.yml',
    branchName: 'main',
    inputs: { trigger_event: 'unique-id' },
    // Keep the tests fast — the poll loop honours these.
    pollIntervalSeconds: 0.001,
    timeoutSeconds: 5,
  };

  const mockContext = (input: Record<string, unknown> = {}) =>
    createMockActionContext({ input: { ...baseInput, ...input } });

  beforeEach(() => {
    jest.resetAllMocks();
    githubCredentialsProvider =
      DefaultGithubCredentialsProvider.fromIntegrations(integrations);
    action = createGithubActionsDispatchAwaitAction({
      githubCredentialsProvider,
    });
  });

  describe('with run details returned by the dispatch', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValue({
        status: 201,
        data: {
          workflow_run_id: 4242,
          run_url: 'https://api.github.com/repos/my-org/test-repo/actions/runs/4242',
          html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
        },
      });
    });

    it('requests run details and polls the run by id', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
        },
      });

      const ctx = mockContext();
      await action.handler(ctx);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.github.com/repos/my-org/test-repo/actions/workflows/test.yml/dispatches',
        expect.objectContaining({
          ref: 'main',
          inputs: { trigger_event: 'unique-id' },
          return_run_details: true,
        }),
        expect.anything(),
      );

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.github.com/repos/my-org/test-repo/actions/runs/4242',
        expect.anything(),
      );

      expect(ctx.output).toHaveBeenCalledWith('workflowRunId', 4242);
      expect(ctx.output).toHaveBeenCalledWith('conclusion', 'success');
      expect(ctx.output).toHaveBeenCalledWith(
        'workflowRunUrl',
        'https://github.com/my-org/test-repo/actions/runs/4242',
      );
    });

    it('emits the run url before the run has completed', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: {
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
          },
        })
        .mockResolvedValue({
          data: {
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
          },
        });

      const ctx = mockContext();
      await action.handler(ctx);

      expect(ctx.output).toHaveBeenCalledWith(
        'workflowRunUrl',
        'https://github.com/my-org/test-repo/actions/runs/4242',
      );
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('throws when the run does not conclude successfully', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
        },
      });

      await expect(action.handler(mockContext())).rejects.toThrow(
        'Workflow did not succeed. Conclusion: failure',
      );
    });

    it('tolerates transient polling failures', async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error('Request failed with status code 502'))
        .mockRejectedValueOnce(new Error('Request failed with status code 502'))
        .mockResolvedValue({
          data: {
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
          },
        });

      const ctx = mockContext();
      await action.handler(ctx);

      expect(ctx.output).toHaveBeenCalledWith('conclusion', 'success');
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it('gives up after too many consecutive polling failures', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Bad credentials'));

      await expect(action.handler(mockContext())).rejects.toThrow(
        'Bad credentials',
      );
      expect(mockedAxios.get).toHaveBeenCalledTimes(5);
    });

    it('times out instead of polling forever', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          status: 'in_progress',
          conclusion: null,
          html_url: 'https://github.com/my-org/test-repo/actions/runs/4242',
        },
      });

      await expect(
        action.handler(mockContext({ timeoutSeconds: 0.05 })),
      ).rejects.toThrow(/Timed out after 0.05s/);
    });
  });

  describe('when GitHub does not return run details', () => {
    beforeEach(() => {
      // Older GitHub / GHES answers 204 No Content.
      mockedAxios.post.mockResolvedValue({ status: 204, data: undefined });
    });

    it('falls back to matching the run by name', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          workflow_runs: [
            {
              name: 'Triggered by someone-else',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/my-org/test-repo/actions/runs/1',
            },
            {
              name: 'Triggered by unique-id',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/my-org/test-repo/actions/runs/2',
            },
          ],
        },
      });

      const ctx = mockContext();
      await action.handler(ctx);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.github.com/repos/my-org/test-repo/actions/workflows/test.yml/runs',
        expect.objectContaining({
          params: {
            event: 'workflow_dispatch',
            branch: 'main',
            per_page: 100,
          },
        }),
      );

      expect(ctx.output).toHaveBeenCalledWith(
        'workflowRunUrl',
        'https://github.com/my-org/test-repo/actions/runs/2',
      );
      expect(ctx.output).toHaveBeenCalledWith('conclusion', 'success');
    });

    it('does not blow up on runs without a name', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: { workflow_runs: [{ status: 'completed' }] },
        })
        .mockResolvedValue({
          data: {
            workflow_runs: [
              {
                name: 'Triggered by unique-id',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/my-org/test-repo/actions/runs/2',
              },
            ],
          },
        });

      await expect(action.handler(mockContext())).resolves.not.toThrow();
    });
  });

  it('does not perform any request during a dry run', async () => {
    const ctx = createMockActionContext({ input: baseInput });
    (ctx as { isDryRun?: boolean }).isDryRun = true;

    await action.handler(ctx);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(ctx.output).toHaveBeenCalledWith('conclusion', 'dry-run');
    expect(ctx.output).toHaveBeenCalledWith(
      'workflowRunUrl',
      'https://github.com/my-org/test-repo/actions/workflows/test.yml',
    );
  });

  it('fails when trigger_event is missing', async () => {
    await expect(
      action.handler(mockContext({ inputs: {} })),
    ).rejects.toThrow('Missing input `trigger_event`');
  });

  it('fails when the dispatch itself is rejected', async () => {
    mockedAxios.post.mockRejectedValue(new Error('Not Found'));

    await expect(action.handler(mockContext())).rejects.toThrow('Not Found');
  });
});
