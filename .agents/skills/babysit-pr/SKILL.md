---
name: babysit-pr
description: "Monitor a pull request through review and CI. Use when the user asks to monitor, watch, or babysit a PR."
---

# Babysit a PR

Repositories we work in usually have one or more AI review bots attached. Which ones, and how many,
is not something this skill knows: bots get installed, renamed, rate-limited and removed without
anyone updating a doc. Babysitting a PR means staying with it until the required checks are green on
the latest commit and every piece of feedback that actually arrived has an answer — reading each
finding, fixing the real ones, and saying out loud, in writing, why the others were dismissed.

Use [EXTERNAS.md](../EXTERNAS.md#consultas-e-payloads-de-ferramentas) for field
selection, complete pagination and literal JSON UTF-8 payloads in PowerShell.

## Pick the target

- No argument: infer the PR from the current branch (`gh pr view --json number,headRefName,url`).
- A number or a URL: use it directly.
- No PR for this branch: say so and stop. Do not open one unless asked.

## Whoever shows up is the review

Never hard-code a roster of reviewers, and never wait for a named one. Discover them from the PR
itself: the reviewers are whoever commented, minus you.

```bash
me=$(gh api user --jq .login)
```

Filter on `.user.login != "$me"` rather than on `endswith("[bot]")`. A reviewer running under a
personal token looks exactly like a human, a bot renamed tomorrow still passes this filter, and
human reviewers landing in the same net is the correct outcome — their findings deserve the same
treatment as a bot's.

**A reviewer that does not show up is not an event.** It may have been uninstalled, be out of quota,
be down, or be skipping this diff on purpose; none of that is yours to diagnose, and none of it is
worth an alert. A PR that collects zero findings is a clean PR, not a broken watch. Mention a
specific reviewer's silence only if the user asked about that reviewer.

## Set up the watch

Prefer the harness's event-driven watch. When T3 exposes `watch_pull_request`,
read existing feedback first, register the watch and end the turn. Resume on
its events; do not run a parallel polling loop. Call `unwatch_pull_request`
when monitoring is finished and handing the PR back. In Claude Code, `Monitor`
with `persistent: true` and `TaskStop` are alternatives when available.
The polling example below is only a fallback when no event-driven watch exists
and the session allows it.

Four rules make the difference between a useful watch and noise:

- **Filter out your own account.** A watch that echoes your own replies back at you buries the real
  events. Everything else is in scope.
- **Watch all three feedback streams.** Findings arrive as inline comments (`pulls/<n>/comments`),
  as review submissions (`pulls/<n>/reviews` — a `CHANGES_REQUESTED` body lives here and nowhere
  else), and as PR-level comments (`issues/<n>/comments`, where a summary-only reviewer writes).
  Miss one stream and a whole reviewer goes unanswered while the watch reports silence.
- **Remember what you reported by id, not by clock.** A timestamp cursor is wrong in both
  directions: snapshot it before the fetch and whatever is posted while the fetch runs gets reported
  twice, snapshot it after and that same window is lost. Keep the ids you already emitted and skip
  those instead. Retries then cost nothing, and the first round can safely inventory the feedback
  that predates the watch — which is exactly the feedback you still owe an answer. Do not pre-seed
  that set to keep a restart quiet: feedback lands in the gap between deciding everything is handled
  and the seeding actually running, and what you seed away is never reported.
- **Cover failure, not just success.** Emit on failed checks too, or a red CI looks exactly like a
  quiet one. Dedupe those the same way, or one red check re-notifies on every single poll.

`--paginate` is not optional: the API returns comments oldest first, so on a busy PR the newest
findings sit on the last page and an unpaginated call would never see them.

Pass your login through the environment and keep the jq program in single quotes. Interpolating a
shell variable into `--jq "…"` drags every backslash through an escape ladder, and `gsub("\\s+")`
arrives at jq as an invalid `\s` — `[[:space:]]` sidesteps the question. Do not send stderr to
`/dev/null` either: a filter that fails to parse then looks exactly like a PR with no feedback.

```bash
export ME=$(gh api user --jq .login)
seen=$(mktemp)   # o que já foi reportado: chave de comentário, de review, linha de check

emit() {  # $1 = caminho da API, $2 = rótulo
  KIND=$2 gh api "repos/<owner>/<repo>/$1" --paginate --jq '
    .[]
    | select(.user.login != env.ME and (.body // "") != "")
    | "\(env.KIND):\(.id)\t[\(env.KIND)] \(.user.login)\(if .path then " \(.path):\(.line)" else "" end)\(if .state then " \(.state)" else "" end) — \(.body | split("<details>")[0] | gsub("[[:space:]]+"; " ") | .[0:400])"
  ' | while IFS=$'\t' read -r key line; do
    grep -qxF "$key" "$seen" || { printf '%s\n' "$line"; printf '%s\n' "$key" >> "$seen"; }
  done
}

while true; do
  emit "pulls/<n>/comments"  finding
  emit "pulls/<n>/reviews"   review
  emit "issues/<n>/comments" comment
  gh pr checks <n> --json name,bucket,link \
    --jq '.[] | select(.bucket != "pending") | "[CI \(.bucket | ascii_upcase)] \(.name) \(.link)"' \
  | while read -r line; do
      grep -qxF "$line" "$seen" || { printf '%s\n' "$line"; printf '%s\n' "$line" >> "$seen"; }
    done
  sleep 90
done
```

`seen` is a file and not a variable on purpose: each `emit` pipes into a `while` loop, and a loop on
the right-hand side of a pipe runs in a subshell that cannot write back to its parent's variables.

These shortened lines are notifications only. An id in `seen` means reported,
not examined or answered. Read the full bodies from all three streams below
before deciding what to do with a finding.

## Only act on what is newer than the latest push

Anything a reviewer said about a commit you have already replaced may be history — but check it, and
compare like with like. Inline comments and reviews carry a `commit_id`: that is what you match
against the current head SHA. For an event that exposes only a timestamp, compare it against the
timestamp of the PR's latest `synchronize` event, not against a SHA.

Stale is not the same as wrong: before dismissing older feedback, confirm the problem it describes
is actually gone. Feedback about code your new commits never touched is still live. And never
re-litigate a thread you already answered.

A review can contain findings in inline comments, its submitted review body
or PR-level comments. Read all three streams without removing `<details>` or
truncating bodies; a watch summary does not replace this read:

```bash
gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate \
  --jq '.[] | {id, user: .user.login, path, line, commit_id, in_reply_to_id, body}'
gh api repos/<owner>/<repo>/pulls/<n>/reviews --paginate \
  --jq '.[] | {id, user: .user.login, state, commit_id, body}'
gh api repos/<owner>/<repo>/issues/<n>/comments --paginate \
  --jq '.[] | {id, user: .user.login, updated_at, body}'
```

## Verify every finding against the source

Read the code (or the doc) the finding talks about before changing anything. Review bots hallucinate
context, quote stale lines, and cite rules the repository does not apply. A finding is only real
once you have seen the problem yourself.

When you disagree, gather the evidence first — the rule invoked is not configured anywhere, the
surrounding files all use the pattern it flagged, the "bug" is unreachable — and put that evidence
in the reply. "Not applicable" without a reason is not a dismissal, it is a shrug.

## CI failures: ours or infrastructure

- **Ours:** compile, lint, typecheck, test, or snapshot failures pointing at code this branch
  touched. Fix them.
- **Infrastructure:** runner provisioning, network and registry timeouts, rate limits, Actions
  outages. Re-run the job; do not "fix" it by editing tests, pinning dependencies, or loosening CI
  config. If it fails the same way after a retry or two, stop and report it — that is a user-help
  situation, not a puzzle to solve alone.

When classification is genuinely ambiguous, diagnose once (`gh run view <id> --log-failed`) before
choosing.

## Replying and resolving

Before an authorized reply, resolution or other GitHub write, reread the
current head, PR state and affected thread or labels. Reassess changes that
could invalidate the action and check for an equivalent reply already posted.
If a write times out or returns an ambiguous result, read back the affected
state before retrying. Retry only the unfinished action, and verify the result.
If readback remains unavailable, report the pending action and stop dependent
writes. A failed or truncated retrieval is not proof that feedback is absent.

Answer where the finding lives: an inline thread gets a threaded reply
(`gh api repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies -X POST --input <file>`), a PR-level
comment gets a PR-level one (`gh pr comment <n> --body-file <file>`). Every finding gets an answer:
applied (with the commit), or dismissed (with the reason). If a reviewer leaves feedback that is not
worth addressing, reply **and resolve** the thread so the next round starts clean.

Anything posted on GitHub in the maintainer's name is written in this format, so a human reading the thread
can tell an agent wrote it:

````md
[MODEL-SLUG] RESPONDING ON BEHALF OF THE MAINTAINER
-----

[actual reply]
````

`MODEL-SLUG` is the model actually doing the work (for example `claude-opus-5[1m]`). Write the reply
in the language of the repository — pt-BR here. Bodies with accented text go through
`--input`/`--body-file`, never as a command-line string (see `AGENTS.md`).

## Keep up with `main`

Watch for movement on `main` and rebase when the branch falls behind or the PR reports a conflict.
If an overlapping PR has made this one obsolete, stop monitoring, report it, and **ask before
closing** — closing is only automatic when the user authorized it explicitly.

## Do not let the review expand the PR

Review feedback is a magnet for scope creep. Address the real shortcomings of the change under
review; a suggestion that improves something the PR never set out to touch belongs in a follow-up,
and saying so in the reply is a complete answer.

## Say something only when something happened

No filler updates, no "still watching" comments on the PR, no summary that repeats the previous
summary. That includes the reviewer lineup: a bot showing up, going quiet, or disappearing between
runs is not news. When nothing changed, stay quiet.

## Finishing

You cannot know who was supposed to review, so quiet is the signal, not a roll call. Stop when the
required checks are green on the latest commit and every finding posted against it has an answer.
On a completion event, fetch current checks and all feedback streams again
before declaring readiness. With a polling fallback, allow a couple of rounds
without new feedback. Then report: head SHA, check status,
who did review, findings applied, findings dismissed and why, and anything still open.

**Merge only if the user explicitly asked for it.** Otherwise the deliverable is the report that the
PR is ready.
