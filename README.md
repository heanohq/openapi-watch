# openapi-watch

A GitHub Action that keeps an eye on a third-party OpenAPI spec. If you build on someone else's API, commit a copy of their spec to your repository as a baseline, and this action will check the live spec on a schedule. When it no longer matches, it opens an issue that lists what changed:

- endpoints added or removed
- parameters added, removed or changed
- request and response fields added, removed or changed (following `$ref`s, arrays, `allOf`/`oneOf`/`anyOf`)
- response status codes added or removed
- anything else outside `paths`, such as `info.version` or `components`

The full diff goes in the workflow run summary, and the issue links to it. If you like, it also opens a pull request that updates the baseline, so accepting the change is a merge.

Both documents are normalised before comparing: keys are sorted, `required` and `parameters` lists are sorted, and YAML and JSON are treated the same. Reformatting, reordering or switching between YAML and JSON won't open an issue.

## Usage

```yaml
name: Watch Basin API

on:
  schedule:
    - cron: '17 6 * * 1' # Mondays, 06:17 UTC
  workflow_dispatch:

permissions:
  contents: write # only needed for create-pr
  issues: write
  pull-requests: write # only needed for create-pr

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: heanoio/openapi-watch@v1
        with:
          spec-url: https://usebasin.com/api_docs/v1/swagger.yaml
          baseline-path: spec/basin-openapi.yaml
          create-pr: true
```

This is also in [`examples/basin-api-watch.yml`](examples/basin-api-watch.yml).

If the baseline file doesn't exist yet, every endpoint is reported as added, and with `create-pr: true` the pull request creates the file.

### What happens on each run

| Upstream spec | Result |
| --- | --- |
| Matches the baseline | Nothing, apart from closing an issue this action opened earlier (see `close-issue-when-unchanged`). |
| Differs, no open issue yet | Opens an issue (and a pull request, with `create-pr`). |
| Differs in the same way as last time | Leaves the issue alone, so a weekly schedule doesn't send weekly notifications. |
| Differs again, in a new way | Updates the issue description and adds a comment, so watchers are notified. The pull request branch is reset and updated. |

The action finds its own issue through a hidden marker in the description, so you can retitle it or change its labels. Each `baseline-path` gets its own issue, so one repository can watch several APIs.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `spec-url` | (required) | URL of the upstream spec, YAML or JSON. A path in the workspace also works. |
| `baseline-path` | (required) | Path of your committed copy of the spec. |
| `github-token` | `${{ github.token }}` | Token used for issues and pull requests. |
| `ignore` | | Comma-separated OpenAPI keywords to drop before comparing, e.g. `description,summary,example,examples`. Schema properties with the same names are kept. |
| `issue` | `true` | Open or update an issue when the spec has changed. |
| `issue-title` | `OpenAPI spec changed: <info.title>` | Title for the issue. |
| `issue-labels` | `openapi-watch` | Comma-separated labels for the issue. |
| `close-issue-when-unchanged` | `true` | Close the issue once the upstream spec matches the baseline again, for example after the pull request is merged. |
| `create-pr` | `false` | Also open a pull request that replaces the baseline with the upstream spec, exactly as downloaded. |
| `pr-branch` | `openapi-watch/<baseline-path>` | Branch for the pull request. It is reset to the base branch on every run. |
| `base-branch` | the default branch | Branch the pull request targets. |
| `dry-run` | `false` | Only report (log, outputs, run summary). Don't touch issues or pull requests. |
| `fail-on-change` | `false` | Fail the step when the spec has changed, after reporting. Useful as a check before a release. |

## Outputs

| Output | Description |
| --- | --- |
| `changed` | `true` if the upstream spec differs from the baseline, otherwise `false`. |
| `summary` | The Markdown summary (empty when unchanged). |
| `diff-file` | Path to a unified diff of the normalised documents. Upload it with `actions/upload-artifact` if you want to keep it. |
| `issue-url` | The issue that was opened or updated. |
| `pr-url` | The pull request that was opened or updated. |

## Permissions

The workflow needs `issues: write` to open issues. With `create-pr: true` it also needs `contents: write` and `pull-requests: write`, and the repository setting **Allow GitHub Actions to create and approve pull requests** (Settings → Actions → General) must be on.

Pull requests opened with the default `GITHUB_TOKEN` don't trigger other workflows, so your CI won't run on them. If you need it to, pass a fine-grained personal access token or a GitHub App token as `github-token`.

## Example issue

```markdown
Spec version: `1.0` → `1.1`

**1 endpoint added, 1 removed, 2 changed**

### Endpoints added

- `POST /forms` — Create a form

### Endpoints removed

- `DELETE /forms/{id}` — Delete a form

### Endpoints changed

#### `GET /forms`

- Parameter added: `search (query)` (string)
- Parameter changed: `per_page (query)`: integer → string
- Response `200` field added: `forms[].tags` (array of string)
- Response `200` field removed: `forms[].legacy_flag` (was boolean)
- Response `200` field changed: `forms[].name`: string, required → string, nullable, required
```

## Running it locally

The same comparison runs from the command line, without GitHub. It exits with 0 when the specs match, 1 when they differ and 2 on errors.

```bash
npm ci
node bin/openapi-watch.js https://usebasin.com/api_docs/v1/swagger.yaml path/to/basin-openapi.yaml --diff
```

## Development

```bash
npm ci
npm test
npm run build
```

`dist/` is committed, because GitHub runs actions straight from the repository. Run `npm run build` after changing anything in `src/`. CI fails if `dist/` is out of date, and the `self-test` job runs the action against the fixtures in `test/fixtures/`.

The only runtime dependency is [`yaml`](https://github.com/eemeli/yaml). GitHub API calls use `fetch`.

## Licence

[MIT](LICENSE)
