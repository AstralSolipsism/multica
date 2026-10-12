# Explicit chat skill invocation

Chat selectors store `[/label](slash://skill/id)`. The daemon validates the ID
against the assigned skills and uses the directory actually written during
environment preparation, including filesystem collision suffixes. Labels never
become commands. This is the OL-200 implementation, following OL-198's Kimi
directory correction.

## Input boundary

`SendDirectChatMessage` records the authenticated actor type in the task's
existing JSON context. Retries retain that context. A human originator does not
prove the message was written by a human: agents can use the chat API too.

The claim includes `chat_skill_message` containing only the member's ordinary
input rows. System onboarding rows and channel-ingested context are excluded.
An empty string means the sender/input was checked and is ineligible; an absent
field means an older server or a task queued before sender stamping, for which
the existing textual hint is retained.
No native command or body injection is generated without verified member input.
Blockquotes, code blocks and inline code do not select skills. Issue descriptions,
comments, wakeups and autopilot payloads never enter this path.

`Environment.SkillDirectories` is returned through the preparation helper's JSON
response. Prepare and Reuse populate it from successful writes, including Codex's
private home and Hermes's overlay. Missing installation information retains the
existing hint instead of guessing a path. The persistent runtime brief remains
unchanged; only this turn's selected-skill hint uses these resolved directories.

## Runtime inputs

| Runtime | Native capability check | Input |
| --- | --- | --- |
| Claude | SDK initialize response advertises the first selected command; slash commands are not disabled | Two text blocks: platform context and extra skill bodies first, then `/directory-name ` plus the user's message. Only the first skill uses native expansion. |
| Codex | `skills/list` returns the exact installed SKILL.md path/name with `enabled: true` | Append `$directory-name` for each recognized selection. Inject missing/disabled/unrecognized entries. |
| Antigravity | Effective executable's `--help` advertises `--disable-slash-commands`; effective args do not disable commands | Start `-p` with `/directory-name` and a newline. Inject additional selections. |
| Kimi | No native dependency in production | Inject every selected body and absolute skill directory. Retain the backend's existing inline runtime brief and single ACP text block. |
| Hermes and other runtimes | No native dependency | Inject every selected body and absolute skill directory. |

Injection strips a complete YAML frontmatter block and explicitly states that
the user selected this skill in the current message. Supporting files resolve
against the installed directory. Unknown IDs and non-selected user text remain
in the message. Ordinary messages, including `/compact`, keep their existing
platform-prefixed input order.

Capability probes use the effective executable/environment, never a version
threshold. Missing/rejected capabilities, missing command/catalog entries and
explicitly disabled slash commands use the injected input. No model turn is
retried just to discover a capability, so fallback cannot repeat tool effects.
Claude shares its existing initialization exchange when task supplements are
enabled; skill discovery alone does not enable supplement hooks.

## Kimi decision

Kimi uses injection as the final implementation for this issue. The native
`/skill:ol200-native-probe` was successfully tested on Kimi Code 2.1.1 on
2026-10-12. Injection was also tested through the actual ACP backend with the
runtime brief prepended and the workdir inside a Git repository's subdirectory.
Both the platform and user tokens reached the model alongside the selected body.

Native discovery depends on the project root, which can differ from the workdir
where Labrastro installs the skill. The native ACP leading-command behavior also
constrains text-block order and historically drops subsequent text blocks.
Injection handles multiple skills and these directory layouts uniformly, without
making delivery depend on the command catalog's notification timing. There is no
deferred native/injection decision or dependency on the Hermes home rollout.

## Verification after runtime upgrades

Default Go tests use fake executables and require no runtime account. Real smoke
tests are opt-in and may consume account quota. Run the specific provider after
an upgrade in a test environment with that CLI's authentication configured:

```bash
cd server
MULTICA_RUN_REAL_AGENT_SMOKE=1 go test -tags=agentintegration ./pkg/agent \
  -run '^TestExplicitSkillRealSmoke/claude$' -count=1 -v
```

Replace `claude` with `codex`, `antigravity`, `kimi` or `hermes`. Optional
`CLAUDE_SKILL_SMOKE_MODEL` (and the corresponding uppercase provider prefix)
chooses the test model; `*_SKILL_SMOKE_BIN` selects a test executable. The Kimi
native comparison is separately reproducible:

```bash
MULTICA_RUN_REAL_AGENT_SMOKE=1 go test -tags=agentintegration ./pkg/agent \
  -run '^TestKimiNativeSkillRealProbe$' -count=1 -v
```

Smoke tests check the response, platform/user context preservation and absence
of tool calls. Claude additionally requires a runtime-generated `<command-name>`
record, Codex requires a native `<skill>` rollout item, and Antigravity requires
`expanded slash command` in its log. A successful injection fallback does not
satisfy a native smoke check. Missing binaries are reported as skips; missing
authentication or failed protocol startup fails the corresponding check.

The 2026-10-12 local run passed Codex 0.160.1 native injection, Kimi 2.1.1 native
comparison and Kimi injection in a Git subdirectory. Claude 2.1.292 produced the
native command record, but its response check could not run without login.
Antigravity was absent, and the installed Hermes launcher pointed to a missing
bootstrap executable. Those response checks require a configured test host;
these results do not claim production verification (OL-204 owns that stage).
