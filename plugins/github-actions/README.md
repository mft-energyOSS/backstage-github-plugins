# Backstage Scaffolder GitHub Actions extension

The github-actions-dispatch-await module
for [@backstage/plugin-scaffolder-backend](https://www.npmjs.com/package/@backstage/plugin-scaffolder-backend).

_This plugin was created through the Backstage CLI_

This plugins add the following actions to the scaffolder-backend:

- `github:actions:dispatch:await` - This action will wait for dispatched GitHub actions to complete before continuing.

### Installation

```bash
npm i @mft-energyoss/github-actions
```

Install package

```bash
yarn --cwd packages/backend add @mft-energyoss/github-actions
```

Then add the plugin to your backend, typically in packages/backend/src/index.ts:

```ts
const backend = createBackend();
// ...
backend.add(import('@mft-energyoss/github-actions'));
```

### How the run is identified

The action asks GitHub to return the details of the run it just created
(`return_run_details`), and then polls that run by id. This is exact — two
templates dispatching the same workflow at the same moment each await their own
run.

If GitHub answers the dispatch without run details (older GitHub Enterprise
Server, or if the parameter is withdrawn — it is not in the public REST docs
yet), the action falls back to its previous behaviour: listing recent
`workflow_dispatch` runs on the branch and matching `trigger_event` against the
run name. That fallback still needs `run-name`, so keeping it in your workflows
is recommended.

### Usage

Make sure that your GitHub workflow has this minimal configuration:

```yaml
# Only needed for the fallback path, but recommended.
run-name: Triggered by ${{ inputs.trigger_event }}

on:
  workflow_dispatch:
    inputs:
      trigger_event:
        description: 'A unique trigger event in order to await the workflow after. This could be a GUID or a simple string.'
        required: true
        type: string
        default: "unqiue_id"
```

Then, in your scaffolder template, you can use the action like this:

```yaml
  steps:
    - id: run_and_wait_for_workflow
      name: Run And Wait For Workflow
      action: github:actions:dispatch:await
      input:
        owner: mft-energyoss
        repo: backstage-github-plugins
        workflow: example-workflow.yml
        branchName: main
        inputs:
          trigger_event: ${{ user.entity.spec.profile.email ~ ' ' ~ context.task.id }}
        # Optional
        timeoutSeconds: 3600
        pollIntervalSeconds: 5
```

#### Inputs

| Input                 | Required | Default | Description                                                          |
| --------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `owner`               | yes      |         | Organization or user                                                   |
| `repo`                | yes      |         | Repository name                                                        |
| `workflow`            | yes      |         | Workflow id or filename                                                |
| `branchName`          | yes      |         | Branch or tag to dispatch on                                           |
| `inputs`              | yes      |         | Workflow inputs. Must include `trigger_event`                          |
| `timeoutSeconds`      | no       | `3600`  | Fail the step if the run has not concluded within this many seconds    |
| `pollIntervalSeconds` | no       | `5`     | How often to ask GitHub for the run status                             |

#### Outputs

| Output           | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `conclusion`     | Conclusion of the run. The step throws unless this is `success`        |
| `workflowRunUrl` | Link to the run, emitted as soon as the run is known — before it ends  |
| `workflowRunId`  | Run id, when GitHub reported it on dispatch                            |