# Scheduled GitHub dashboard

The composite Action builds the CLI from its own checkout and scans the caller's checked-out repository. It uses Node 22 and requires Git. Configure `aspects` in `.jev-checkup.yml`; no additional aspect is enabled automatically.

## One-time setup

Before enabling a workflow that performs a fresh scan, add the repository secret `TYPESAFE_API_KEY` in **Settings → Secrets and variables → Actions**. Keep the key out of the repository and configuration files. A caller workflow should check that the secret is present and fail with a short message before invoking the Action; never print the key or include it in a diagnostic. The `GITHUB_TOKEN` value can come from `${{ github.token }}` when issue publication is enabled.

Use a reviewed commit SHA for the Action reference. The example below is a template for another repository: replace `REVIEWED_COMMIT_SHA` before installing it. This repository's self-adopting workflow uses `uses: ./` after checkout.

```yaml
name: Codebase health
on:
  workflow_dispatch:
  schedule:
    - cron: '0 3 * * 1'
permissions:
  contents: write
  issues: write # Omit if issue publication is disabled.
concurrency:
  group: jev-checkup-history
  cancel-in-progress: false
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
      - uses: shm11C3/jev-checkup@REVIEWED_COMMIT_SHA
        with:
          config: .jev-checkup.yml
          history-branch: jev-checkup-history
          issue: new # Omit for Job Summary only.
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

The caller must checkout the repository and provide credentials. `GITHUB_TOKEN` authorizes issue API calls; the checkout's Git credentials authorize history pushes. `contents: write` is needed for the durable branch, `issues: write` only when posting. An empty `history-branch` input disables branch persistence. `paths` takes one repository-relative path per line. `state-dir` defaults to `.jev-checkup`, and `config` defaults to the repository's `.jev-checkup.yml`.

This repository's self-adopting workflow uses `paths: |` with `src` and `test` and its checked-in `.jev-checkup.yml` selects `test-honesty` and `naming-honesty`. Keep that configuration aligned with the aspects present on the default branch before enabling the workflow.

The Action skips all pull-request events, including fork and `pull_request_target`, before setup or secret use. It is intended for scheduled/manual scans, not PR evaluation. A fresh uncached scan sends the configured source scope to TypeSafe AI and consumes API usage.

## Artifacts and history

`run-json` is the output path to the saved run (`<state-dir>/run.json`). It contains source; apply repository-equivalent access controls if uploading it as an artifact. The same restriction applies to the history branch. CLI scan output containing literal evidence is not printed to Action logs; the Job Summary uses only the source-free GitHub renderer.

History is stored as immutable `runs/<run-id>.json` files in a dedicated branch with a tool marker. Existing branches without that marker are rejected. A private Git index stages only history files, and the current checkout/index remain untouched. Pushes never force-update the branch; concurrent updates fail explicitly, so use a workflow concurrency group shared by every job writing that branch. Failed/incomplete scans return nonzero; a saved incomplete run still receives a summary and history entry.

Observation caching is optional: cache only `<state-dir>/observations` with a caller-managed `actions/cache` step if useful. Losing the cache can cause new API usage; it does not erase branch history. Labels are not automatically fetched from the history branch and should live in a trusted revision-controlled location, supplied through the configured state directory for this increment.

Job summaries use GitHub's [summary environment file](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#adding-a-job-summary); Action inputs are passed through environment variables following the [composite action metadata contract](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#runs-for-composite-actions).
