# Every word this extension produces

This extension writes text for two readers, and they do not see the same things.

- **The model** — the agent running your session. Everything it reads costs tokens.
- **You** — the person at the pi TUI.

A third reader appears once: the **nudge classifier**, a separate model that never sees your
session and whose session never sees it.

Every section below states both views.

---

## Summary: who sees what

| Text | The model | You |
|---|---|---|
| Tool descriptions and parameter descriptions | every turn | never |
| Tool call header | never | the tool's name and the job's title |
| Tool results | in full | a short line the tool wrote for you alone |
| Job completion notifications | in full | a short line, under a `[pi-background]` label |
| The nudge | in full | the same text, as a user message |
| The nudge classifier's prompt | never | never |
| The job counter under the editor | never | always, when a job is running |
| The `/jobs` listing | never | when you run `/jobs` |
| Configuration and startup errors | never | when they happen |

The model's view and yours are produced separately for every tool and every notification. A tool
returns `content` for the model and `details` for the TUI; only `content` reaches the provider.

---

## A. Tool descriptions and parameters

### What the model sees

Every turn, for as long as the tool is registered.

#### `run_command`

> Start a shell command in the background and return immediately. Give timeoutSeconds a number for work you are waiting on: the result is delivered to you automatically when it ends, so end your turn rather than polling or sleeping. Give it null for a service that runs until stopped; you are told if it stops on its own. It returns a job id, which job_list and job_stop take.

| Parameter | Description |
|---|---|
| `command` | Shell command |
| `title` | Short title for this job, shown in the job list |
| `cwd` | Working directory |
| `timeoutSeconds` | Seconds to wait, as pi's bash tool counts them. Pass null for a service such as a dev server: it has no time limit and runs until stopped. |

`command`, `title` and `timeoutSeconds` are required. `title` is required because it is the only
thing you ever see: the command itself never reaches your screen.

#### `run_agent`

Registered only when the session has depth left.

> Start a subagent on a task and return immediately. The result is delivered to you automatically when it finishes, so end your turn rather than polling or sleeping. The subagent starts with no context: put everything it needs in the task. It returns a job id, which job_list, job_stop and resume_agent take.

Then, when `isolated` is configured, a blank line and **your `isolated.instructions` string
verbatim**. This is the one piece of model-facing text that comes from config rather than source.
The value in the test config reads:

> An isolated subagent runs in a throwaway sandbox under /tmp/sandboxes/&lt;sandbox id&gt;. It stays up after the job ends; run `rm -rf /tmp/sandboxes/&lt;sandbox id&gt;` when you no longer need it.

| Parameter | Description |
|---|---|
| `task` | The complete instruction for the subagent |
| `title` | Short title for this job, shown in the job list |
| `timeoutSeconds` | Seconds to wait before giving up, as pi's bash tool counts them |
| `cwd` | Working directory |
| `isolation` | isolated runs in a fresh sandbox — **this row exists only when `isolated` is configured**; with no provider the parameter is not registered at all |

#### `resume_agent`

Registered with `run_agent`.

> Continue a finished subagent with a follow-up task. It keeps the original job's context, directory and host, so it takes neither cwd nor isolation. It returns a new job id, which job_list, job_stop and resume_agent take.

| Parameter | Description |
|---|---|
| `jobId` | Job id of the finished subagent to continue |
| `task` | The follow-up instruction for the subagent |
| `title` | Short title for this job, shown in the job list |
| `timeoutSeconds` | Seconds to wait before giving up, as pi's bash tool counts them |

This is a separate tool rather than a `resumeFrom` parameter on `run_agent` so that two whole
classes of error cannot happen: a resume can no longer be given a `cwd` or an `isolation` that
contradicts the job it is continuing.

#### `job_list`

> Every job this session still has running, grouped by kind, with elapsed time and timeout. A finished job is not listed: it reported itself when it ended.

No parameters.

#### `job_stop`

> Stop a running job by its id — a shell command or a subagent.

| Parameter | Description |
|---|---|
| `id` | Job id to stop |

### What you see

**None of the above.** Tool descriptions never appear in the TUI.

What you see instead is one line per tool call, written by the extension: the tool's name followed
by the job's title.

```
run_command long sleeper
run_agent greeter
resume_agent greeter follow-up
job_stop long sleeper
job_list
```

`job_stop` shows the title of the job it is stopping, looked up by id, so you never read an id.

Each tool also registers a `label` — `Run command`, `Run agent`, `Resume agent`, `List jobs`,
`Stop job` — which pi's interactive tool view does not display.

### What neither sees

The CLI flag `--jobs-depth`, described as `Internal: remaining subagent depth`. It appears in
`pi --help` only.

---

## B. Tool results

One section per tool, and one per reader. The two views are produced separately: the model gets a
record it can act on, you get one line that says what changed.

### `run_command`

#### What the model sees

Three lines for an awaited command:

```
Command <title> is started in the background, you will be notified when it finishes.
job id: <job id>
The command output is piped to: <agent dir>/jobs/<job id>/output
```

The first line differs for a service, which has no deadline:

```
Command <title> is started in the background. It has no time limit; you will be notified if it stops.
```

Concretely:

```
Command long sleeper is started in the background. It has no time limit; you will be notified if it stops.
job id: 01a09979-cbb7-7639-87ae-48ae2d46581d
The command output is piped to: /home/rmng/.pi/agent/jobs/01a09979-cbb7-7639-87ae-48ae2d46581d/output
```

`<agent dir>` is `$PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that is unset. A command job never
has a sandbox, because `run_command` has no `isolation` parameter.

#### What you see

```
run_command long sleeper
Timeout: none
```

`Timeout:` is the number of seconds, or `none` for a service. No id, no path, no command.

#### Errors

None the model can cause. `run_command` validates nothing beyond the schema pi enforces for it,
and it returns as soon as the job is registered. A command that exits non-zero is reported later
as a completion, not as an error from this call.

### `run_agent`

#### What the model sees

```
Agent <title> is started in the background, you will be notified when it finishes.
job id: <job id>
```

An isolated subagent adds a third line:

```
sandbox: <sandbox id>
```

There is no output path and no result path. The raw output of an agent job is pi's JSON event
stream, which is of no use to the model; the path to its answer arrives with the completion
message, once the answer exists.

`timeoutSeconds` is a required number, so an agent job is always awaited.

#### What you see

```
run_agent greeter
Timeout: 120s
```

#### Errors

Three messages, all from the sandbox provider. `run_agent` no longer takes a `resumeFrom`, so it
has no argument errors left at all.

| # | Message | Raised when |
|---|---|---|
| 1 | `isolated.create failed: <stderr, trimmed>` | the configured `isolated.create` command exits non-zero |
| 2 | `isolated.create must print {id, ssh, cwd}: <stdout, trimmed>` | its output parses as JSON but is missing `id`, `ssh` or `cwd` |
| 3 | `isolated.create ssh must start with ssh: <the ssh value>` | its `ssh` field's first word is not `ssh` |

All three are reachable only when `isolated` is configured. If `isolated.create` prints something
that is not JSON at all, both readers instead see the raw `JSON.parse` message from the runtime,
for example `Unexpected token o in JSON at position 1`.

### `resume_agent`

#### What the model sees

The same three lines as `run_agent`, with a **new** job id. The `sandbox:` line is present when
the job being continued had one, since a resume stays on the same host.

```
Agent greeter follow-up is started in the background, you will be notified when it finishes.
job id: 01a0997c-9319-7639-87ae-48b4998f00b1
```

#### What you see

```
resume_agent greeter follow-up
Timeout: 120s
```

#### Errors

| Message | Raised when |
|---|---|
| `no such job: <id>` | `jobId` names an id this session has no job for |
| `job <id> is not a subagent` | `jobId` names a shell command |
| `job <id> is still running; stop it or wait for it` | the job has not finished |
| `another job is already continuing <id>` | a second resume of the same subagent session while the first is still running |

### `job_list`

#### What the model sees

Running jobs only, grouped by kind, with a count in each header. A finished job is not listed: it
already reported itself when it ended.

```
2 in progress background commands:

01a09979-cbb7-7639-87ae-48ae2d46581d
title: long sleeper
output path: /home/rmng/.pi/agent/jobs/01a09979-cbb7-7639-87ae-48ae2d46581d/output
elapsed: 0s
timeout: none

01a09979-cbb8-7639-87ae-48b1389afa99
title: quick failure
output path: /home/rmng/.pi/agent/jobs/01a09979-cbb8-7639-87ae-48b1389afa99/output
elapsed: 0s
timeout: 60s

1 in progress agent:

01a09979-cbb9-7639-87ae-48b3100fbdd1
title: greeter
elapsed: 0s
timeout: 120s
```

A group with no jobs is omitted. A header goes singular at one job. An agent entry carries no
output path, for the reason given under `run_agent`, and carries `sandbox: <id>` when it has one.

When nothing is running:

```
no jobs running
```

#### What you see

Exactly what `/jobs` prints — the running jobs as a table:

```
job_list
job id                                type     title                elapsed  timeout
01a09a13-04cf-73d2-88ce-082fbf7c871f  command  long sleeper              2s     none
01a09a13-04d2-73d2-88ce-0831f03dcabb  command  build the docs site       1s     600s
01a09a13-04d2-73d2-88ce-08326fada276  agent    greeter                   1s     300s
```

#### Errors

None.

### `job_stop`

#### What the model sees

```
Job <title> is stopped.
elapsed: <duration>
output path: <agent dir>/jobs/<job id>/output
```

The third line is `response path: <agent dir>/jobs/<job id>/result` for a subagent, since the raw
output of an agent job is a JSON event stream.

Stopping a job that has already ended is not an error. The first line says so instead:

```
Job long sleeper had already ended: stopped.
elapsed: 42s
output path: /home/rmng/.pi/agent/jobs/01a09979-cbb7-7639-87ae-48ae2d46581d/output
```

The word after the colon is one of `finished`, `failed`, `timed out` or `stopped`.

**A job ended by job_stop sends no completion message.** The model already has this answer, so a
second delivery would only cost it a turn.

#### What you see

```
job_stop long sleeper
```

One line. The job is gone from the counter under the editor, which is the rest of the answer.

#### Errors

| Message | Raised when |
|---|---|
| `no such job: <id>` | `id` names no job this session started |

### Outcome words, elapsed and exit code

A job that has ended is one of four things. The same four words are used everywhere:

| Word | Meaning |
|---|---|
| `finished` | ended successfully |
| `failed` | ended unsuccessfully |
| `timed out` | `timeoutSeconds` elapsed |
| `stopped` | `job_stop` ended it |

An abort outranks whatever the underlying process reported, so a stopped or timed-out job says
`stopped` or `timed out` rather than repeating the operating system's phrasing for a kill.

`exit code` is the command's exit status, or `none` when it was killed and had none. It is
reported for commands only.

`exit reason` appears only when it says something the exit code does not. A command that exits 7
shows the code and no reason. An agent that failed shows a reason such as `spawn ssh ENOENT`,
`killed by SIGKILL`, `exit 1`, `no assistant message in the last 4194304 bytes of <path>`, or
`unparsable event in <path> line <n>`.

`elapsed` is `<n>s` below one minute, `<m>m<ss>s` below one hour, `<h>h<mm>m` above — for example
`9s`, `3m58s`, `2h04m`.

---

## C. Injected messages

Two kinds, three sources. They enter the conversation and stay there.

### A finished `run_command` job's notification

Sent by the extension, not by a tool, when a command job ends on its own. **Every** command job
sends one, awaited or service; only a job ended by `job_stop` stays silent.

#### What the model sees

A custom message of type `pi-background`, with `deliverAs: "followUp"` and `triggerTurn: true`, so
it wakes the agent for a new turn. Wrapped in tags:

```
<pi-background>
Background command quick failure failed.
job id: 01a09979-cbb8-7639-87ae-48b1389afa99
elapsed: 3s
exit code: 7
read the command output at: /home/rmng/.pi/agent/jobs/01a09979-cbb8-7639-87ae-48b1389afa99/output
</pi-background>
```

An `exit reason:` line sits between `exit code:` and the output path when there is one.

The message carries **no instruction**. The "end your turn rather than polling" wording exists
only in the tool description in A.

#### What you see

```
[pi-background]

Background command quick failure failed in 3s.
Exit code: 7
```

An `Exit reason:` line follows when there is one. No id, no path, no tags.

### A finished `run_agent` or `resume_agent` job's notification

Sent on the same mechanism, with the same type and tags.

#### What the model sees

```
<pi-background>
Agent greeter finished.
job id: 01a09979-cbb9-7639-87ae-48b3100fbdd1
elapsed: 5s

read the agent response at: /home/rmng/.pi/agent/jobs/01a09979-cbb9-7639-87ae-48b3100fbdd1/result
</pi-background>
```

There is no exit code: for a subagent the outcome word carries the whole answer. An `exit reason:`
line appears when it failed.

The `read the agent response at:` line is present **only when that file is not empty**. A killed
or crashed subagent often wrote nothing, and pointing the model at an empty file wastes a read.
The file holds the subagent's final assistant message as plain text. The message does not quote
it: the model must read the file.

Like the command notification, this carries no instruction.

#### What you see

```
[pi-background]

Agent greeter finished in 5s.
```

The subagent's answer is not shown to you. In practice you learn what it said one turn later, when
the model reads that file and tells you.

### The nudge

Sent as an ordinary user message, as if you had typed it. At most **five** per user turn; the
counter resets on the next input that did not come from this extension.

#### What the model sees

> You said you would &lt;action&gt;, but did not. Continue.

`<action>` is the classifier's reply verbatim, at most about 15 words. With a classifier reply of
`Run the test suite.` the model receives:

> You said you would Run the test suite., but did not. Continue.

The classifier's phrasing lands mid-sentence, so its capital letter and its full stop both stay in
place, as above. Nothing trims or re-cases it.

A nudge is sent only when: the session is not itself a subagent, `nudgeModel` is configured, fewer
than five nudges have been sent this turn, **no awaited job is running**, the last entry is an
assistant message that did not end in an error or an abort, its text is non-empty, and the
classifier replied with something other than `NO`.

A service does not count as an awaited job. A dev server left running for hours must not silence
the nudge, or mark your session busy, for as long as it lives.

#### What you see

The same sentence, in a user message block indistinguishable from one you typed. Nothing marks it
as machine-written.

---

## D. The nudge classifier's prompt

Sent to `nudgeModel`. **Neither the session model nor you ever sees it.**

System prompt:

> Below is an assistant message that ended a turn. If it promised a next action that it is going to do (only includes next actions the assistant is going to do, not include the next action it says the user is going to do), reply with that action in at most 15 words. Otherwise reply with exactly: NO

The parenthesis exists because the classifier used to fire on an assistant message that ended by
telling the user what to do next. That is not an unkept promise.

The single user message is the last assistant message's text, with nothing added — no framing, no
session context, no tool history.

Its reply is read as: empty → throw; `NO` (any case) → no nudge; anything else → the action, which
then reaches both readers as the nudge in C.

---

## E. Text only you see

The model never receives any of the following.

### The job counter under the editor

A one-line widget below the input box, present only while at least one job is running:

| Running jobs | Text |
|---|---|
| 1 command | `1 command` |
| 2 commands | `2 commands` |
| 1 subagent | `1 subagent` |
| 2 commands and 1 subagent | `2 commands, 1 subagent` |
| none | the widget is removed |

This is pure UI. It is not a session entry and is never saved.

### The `/jobs` listing

`/jobs` is described in pi's command list as:

> List running jobs (shown to you only, never sent to the model)

It writes a session entry of a custom type that pi keeps out of the model's context by design. One
row per running job, under a dimmed heading:

```
job id                                type     title                elapsed  timeout
01a09a13-04cf-73d2-88ce-082fbf7c871f  command  long sleeper             15s     none
01a09a13-04d2-73d2-88ce-0831f03dcabb  command  build the docs site      15s     600s
```

Five columns: `job id`, `type` (`command` or `agent`), `title`, `elapsed`, `timeout`. Every column
is sized to its widest cell; the two durations are right-aligned. `timeout` is `none` for a
service.

No status column, because everything listed is running. No sandbox id: it is in `job_list`'s
model-facing rows, not here. This is the same table `job_list` shows you.

When nothing is running, the whole entry is one line and there is no heading:

```
No jobs running.
```

### Configuration and startup errors

Thrown or logged outside a tool call, so pi shows them as an extension error or on stderr.

| Where | Text |
|---|---|
| `session_start` | `pi-background.json: <schema message>` |
| `session_start` | `pi-background.json: nudgeModel and nudgeThinking must be set together` |
| `session_start` | `pi-background: --jobs-depth must be a whole number, got "<value>"` |
| startup | `pi-background: could not read starttime from /proc/self/stat` |
| `agent_settled` | `nudgeModel not found: <model>` |
| `agent_settled` | `nudge classifier failed: <provider error>` |
| `agent_settled` | `nudge classifier produced no text: <model> at thinking "<level>" within 2048 tokens` |

The three `agent_settled` ones recur at every turn end until the configuration is fixed. That is
deliberate: there is no latch, so a broken classifier cannot go quiet.

---

## F. Text neither reads

Written to disk, read by nobody unless asked for:

| File | Holds |
|---|---|
| `<agent dir>/jobs/<job id>/output` | the job's stdout — the raw JSON event stream for an agent job |
| `<agent dir>/jobs/<job id>/stderr` | an agent child's stderr |
| `<agent dir>/jobs/<job id>/result` | an agent job's final assistant message, as plain text |
| `<agent dir>/state/<pid>.json` | the activity file: pid, process start time, session id, cwd, and `active` or `idle` |

The model reaches `output` and `result` only by reading the paths it was given. The activity file
is for RMNG, not for either reader.

The shell command itself is also in neither view after the call: it is in the tool call arguments
in the session file, and nowhere else. Your screen shows the title the model wrote.

---

## What this extension never says to the model

No system-prompt contribution, no `promptSnippet`, no `promptGuidelines`, no skills, no prompt
templates. Sections A to D are the complete surface. A session with this extension loaded and no
jobs running carries only the five tool descriptions.
