# Source playbooks

Choose a playbook only when the question or a concrete gap calls for that
source. These are optional query examples, not a checklist of categories to
search. Use them directly or in an assigned investigation. Tool names, schemas
and providers are examples; verify what is available in the session and adapt
to its permissions. Missing access is a limit to report, not a reason to install
an integration or change modes.

Start with a known record or targeted query. Follow relevant leads until the
assigned question is answered or accessible leads are exhausted. Record empty
queries with their scope; they do not prove that a record or event never existed.
The project's source and data-access rules take precedence over these examples.

| Category | Playbook | Example MCP it documents |
|---|---|---|
| Source control history | [`code-archaeology.md`](./sources/code-archaeology.md) | git, `gh` |
| Issue / ticket tracker | [`linear.md`](./sources/linear.md) | Linear (adapt for Jira, GitHub Issues, Plane, Shortcut) |
| Long-form documents | [`notion.md`](./sources/notion.md) | Notion (adapt for Confluence, Google Docs, Coda) |
| Real-time team chat | [`slack.md`](./sources/slack.md) | Slack (adapt for Discord, Microsoft Teams, Mattermost) |
| Infrastructure observability | [`datadog.md`](./sources/datadog.md) | Datadog (adapt for New Relic, Honeycomb, Grafana, Splunk) |
| Error / exception tracking | [`sentry.md`](./sources/sentry.md) | Sentry (adapt for Rollbar, Bugsnag, Airbrake) |
| Product analytics warehouse | [`databricks.md`](./sources/databricks.md) | Databricks SQL (adapt for Snowflake, BigQuery, ClickHouse, dbt) |

Cross-cutting:

- [`incident-postmortem.md`](./sources/incident-postmortem.md). Use when an
  incident link or an unresolved question about defensive behavior makes
  incident history relevant. A guard alone does not require searching every source.
