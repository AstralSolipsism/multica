---
name: multica-working-on-issues
description: "Superseded by the multica-platform skill — load that instead. This file only records where the Labrastro issue contracts moved to."
user-invocable: false
allowed-tools: Bash(multica *)
---

# Moved into `multica-platform`

Labrastro's platform contracts are now one skill. Everything this skill used to
carry — PR linking and merge status, reading a linked PR's real state, custom
properties, status side effects, sub-issues and stages, and finding who else is
running — lives in:

```text
multica-platform  →  references/issues.md
                 →  references/pull-requests.md
```

Load the `multica-platform` skill and open the relevant reference(s). Its routing
table also names the reference for every other platform domain: mentions, agents,
squads, autopilots, projects, runtimes, and skill import.

The contracts were reorganized, not shortened — with one exception. The issue
`metadata` guidance was retired (MUL-6966), so a brief that sends you here for
it points at something that is no longer there. What replaces it: durable state
a person should see and filter by goes on a custom property, the stage the issue
is at goes in its status, and everything else — what you did this run, what you
found — goes in the result comment.

You are seeing this redirect because the Labrastro app on this machine is older
than the server it is talking to, so its task brief still refers to the previous
skill name. Updating the app removes this extra hop.
