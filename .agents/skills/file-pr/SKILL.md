---
name: file-pr
description: "Prepare or update a concise PR description, or file a pull request when the user asks."
---

# File a PR

Use the sections that match the request. Drafting or updating a local PR body
does not authorize filing, pushing or publishing edits to an existing PR.
Follow the scope already authorized in the session, without asking again for
actions it includes. Read [EXTERNAS.md](../EXTERNAS.md#fluxo-das-skills-de-engenharia)
for local workflow conventions.

Start with the diff, request and decisions already in context. Use the local
template and documented conventions before researching examples. Ask only
about material decisions still unresolved by that context. Complete the
reviewable draft before requesting any missing publication authorization.
Preparing text alone does not require a new branch, installation or setup.

## Before filing

- **Check whether an open PR for this branch already exists** (`gh pr view --json number,url,state`).
  Reuse it only when `state` is `OPEN`. The same command may resolve a `MERGED`
  or `CLOSED` PR. Use the session's delivery decision when already established;
  otherwise ask only if reopening a closed PR or creating a new one is a real
  unresolved choice. A merged PR cannot be reopened. A failed lookup is not
  proof that no PR exists; distinguish access failures from an empty result.
- **Confirm the target branch**, using an existing PR's base or the project's
  established base for a new PR. Fetch the relevant remote and review the diff
  against that base. Identify unrelated changes without discarding the dev's work.
- Check whether the branch needs updating before filing. Resolve conflicts
  within the authorized scope, preserving local changes and shared history;
  an automatic rebase is not a prerequisite for writing a PR description.
- One underlying problem per PR. Check how each material change contributes
  to that problem. Backend, contracts, SDK, tests and docs can need to change
  together. Separate independently useful fixes or unrelated cleanup; wording,
  file count and issue count alone do not determine scope.

## Title

PR titles usually become commit messages, so follow the documented repository
conventions and its template. If a concrete question about style remains,
consult a few relevant recent commits or merged PRs. Existing guidance that
settles the title does not require an additional history search.

In this repository the convention is **pt-BR, descriptive, no conventional-commit prefix**:

> **BAD** — `Fase 6`
> Says what sprint it was, not what changed. Useless in a `git log` six months later.
>
> **GOOD** — `Publica o app em Cloudflare Workers via @cloudflare/vite-plugin`

Whatever the local convention, prefer a concise, human-relatable title that explains **why the
change matters** over one that names the mechanism. The pair below comes from a repository that
*does* use conventional commits — copy the contrast, not the format:

> **BAD** — `perf(server): negotiate permessage-deflate on the websocket`
>
> **GOOD** — `perf(server): cut websocket frame size by 70%+ with gzipping`

The same contrast, written for this repository: `Reduz em 70% o tamanho dos frames do WebSocket com
compressão`.

## Description

Open with a plain explanation of **the problem**, grounded in the user's original prompt, then
briefly explain the solution. Do not lead with an inventory of what you implemented:

> **BAD** — "Removed implicit workspace carry-over from every 'new-thread' entry point (cmd+n /
> cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from
> context; branch, worktree, and env mode always come from the configured defaults. Deleted
> `buildContextualThreadOptions`, `startNewThreadInProjectFromContext`, and the v1 sidebar's
> seed-context machinery."
>
> **GOOD** — "My 'new-worktree' default was ignored when starting new threads on existing worktrees.
> Super unintuitive. Now your preferences always apply."

The reader is deciding whether to care, then whether it is right — in that order. Detail belongs
below that opening, and only the detail a reviewer needs.

### Visual explanation, evidence and impact

Adapt the useful parts of Matt Pocock's PR guidance to the change's size:

- After the problem and result, use the smallest visual that explains a
  non-obvious change: a short diff, pseudocode, a call or file tree, or Mermaid.
  Keep it next to the explanation it supports. A simple change can stay in prose.
- Give concrete evidence. For a fix, show the observed failure and the result
  after the correction when available. For a feature, show the behavior tested.
  UI work benefits from screenshots or a recording when applicable. Describe
  untested cases and unavailable checks; never invent a before result or call
  CI successful when it did not run.
- For a performance requirement or claim, check the protocol and evidence in
  [performance-analysis](../performance-analysis/SKILL.md) before stating a
  gain in the title or body. Report inconclusive measurements as inconclusive.
- Explain material merge risk: affected consumers, contracts or persisted data,
  and whether rollback is cheap or requires recovery or migration. Include the
  actual consequence, rather than a risk adjective by itself. Omit a separate
  risk section when it would add no useful information for a small change.

Write these parts in pt-BR and respect the repository's PR template if present.
This guidance is adapted from Matt Pocock's PR guidance; attribution is in
[CREDITS.md](CREDITS.md). It adds no separate skill dependency.

### Make the review navigable

For a broad diff, identify the few files where the behavior is decided and
suggest a reading order. Distinguish generated or mechanical changes from
logic so the reviewer can spend attention on contracts, migrations and effects.
Explain rollout order only when the change requires it. If unrelated changes
make the PR hard to assess, recommend splitting by independently useful work.

Improve the description and guidance within the authorized scope before
considering history changes. Rewriting commits or force-pushing requires that
the dev requested or authorized that action; making a PR easier to review
does not grant it implicitly. When an authorized rewrite should preserve
content, record the original head tree with `git rev-parse '<head-sha>^{tree}'`
and compare it with `git rev-parse 'HEAD^{tree}'` afterward. If they differ,
inspect the full content diff and resolve unintended changes before pushing.
Tree equality proves content identity, not runtime correctness.

### Automatic issue closure

Keep prose in pt-BR, but use GitHub's supported **English closing keywords**
in the PR body: `Closes #123`, `Fixes #123` or `Resolves #123`. Portuguese
phrases such as `Fecha #123` or `Resolve a issue #123` do not trigger closure.
For another repository, use `Closes owner/repository#123`; repeat the full
keyword and reference for each issue.

Use closing keywords only for issues fully resolved by the PR within the
authorized scope. For partial work, use a neutral reference such as
`Relacionado a #123`. GitHub interprets closing keywords in a PR description
only when its target is the repository's default branch; merging into another
branch does not close the issue through those keywords. Verify the target and
do not promise closure merely because the PR was opened.
See [GitHub's linking rules](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).

### Local evidence and formatting

Per `AGENTS.md`:

- UI changes carry visual evidence when applicable; motion or timing may need
  a short video rather than a still image.
- Write PR bodies to a UTF-8 file and pass `--body-file`; commit messages use
  `git commit -F <file>`. Pass titles as a literal argument or structured tool
  field, preserving accented text without building another shell command.
- Write the body **one paragraph per line, with no hard wrap**. GitHub renders PR, issue and
  comment bodies with hard line breaks on, so every newline in the file becomes a `<br>` and the
  paragraph breaks off where you stopped typing instead of where the container ends. The 80-column
  wrap that is right everywhere else in the repository — versioned `.md` files, commit messages —
  is exactly wrong here.

## Filing

Use draft status when requested or when the delivery is still incomplete.
Otherwise, file a ready-for-review PR after the relevant validation.

```bash
gh pr create --base <base-confirmada> --title "<título>" --body-file <file>
```

Never file a PR the user did not ask for, and never merge one unless they explicitly asked.

When the session exposes PR-linking tools, register an existing PR when starting
work on it and a new PR immediately after creation. Verify that the thread's PR
list includes it before finishing; report a linking failure separately.

If the user also asked to babysit it, continue with the `babysit-pr` skill.
