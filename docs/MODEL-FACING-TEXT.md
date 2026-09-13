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
| The `bash` prompt snippet, in the system prompt's tool list | every turn | never |
| Tool call header | never | the tool's name and the job's title |
| Tool results | in full | a short line the tool wrote for you alone, and a command's last lines |
| Job completion notifications | in full | a short line, under a `[pi-background]` label, and a command's last lines |
| Job overrun notifications | in full | a short line, under a `[pi-background]` label |
| The nudge | in full | the same text, as a user message |
| The nudge classifier's prompt | never | never |
| The job count in pi's footer | never | always, when a job is running |
| The `/jobs` listing | never | when you run `/jobs` |
| Configuration and startup errors | never | when they happen |

The model's view and yours are produced separately for every tool and every notification. A tool
returns `content` for the model and `details` for the TUI; only `content` reaches the provider.

---

## A. Tool descriptions and parameters

### What the model sees

Every turn, for as long as the tool is registered.

#### `bash`

This tool is named `bash`, so it replaces pi's built-in shell tool. The model has no other shell.

> Run a shell command. A command you expect to take less than 180 seconds runs while you wait, and returns its output with the exit code. Anything longer, and any service, starts in the background at once and is delivered to you when it ends, so end your turn rather than polling or sleeping. A command that passes your estimate is not stopped: it moves to the background and you are told when it ends, with a job id that job_list and job_stop take. Nothing is ever killed by the clock — only job_stop ends a command early. A long output is cut to its end, and the result then names the file holding all of it; a result that names no file is whole.

It also contributes one line to the system prompt's list of available tools:

> Run shell commands (ls, grep, find, etc.); a long one moves to the background

| Parameter | Description |
|---|---|
| `command` | Shell command |
| `title` | Short title for this job, shown in the job list |
| `cwd` | Working directory |
| `expectedSeconds` | Roughly how long you expect this to take, in seconds. It decides whether you wait for the command or it starts in the background. Nothing is killed at that mark: if the command is still running you are told so, and you decide whether to let it continue. Pass null for a service such as a dev server, which you are not waiting on. |

`command`, `title` and `expectedSeconds` are required. `title` is required because it is the only
thing you ever see: the command itself never reaches your screen.

**`expectedSeconds` is not a deadline.** Nothing in this extension kills a job on a clock. It
decides only who waits: under 180 seconds the model waits for the command, at 180 or more it starts
in the background. See section C for what happens when a command passes it.

#### `run_agent`

Always registered. A session with no depth left still has it, and the call is refused when it is
made.

> Start a subagent on a task and return immediately. The result is delivered to you automatically when it finishes, so end your turn rather than polling or sleeping. The subagent starts with no context: put everything it needs in the task. It returns a job id, which job_list, job_stop and resume_agent take. Pass isolation "isolated" to run it in a fresh sandbox; what to do with that sandbox afterwards comes back with the job id.

Nothing here comes from the config file. Your `isolated.instructions` string used to be appended
to this description, which every turn paid for whether or not a sandbox was ever made; it is now
returned with the job that actually made one, under `run_agent`'s result below.

| Parameter | Description |
|---|---|
| `task` | The complete instruction for the subagent |
| `title` | Short title for this job, shown in the job list |
| `expectedSeconds` | Roughly how long you expect this to take, in seconds. Nothing is killed at that mark: if it is still running you are told so, and you decide whether to let it continue. |
| `cwd` | Working directory |
| `isolation` | isolated runs in a fresh sandbox; needs a sandbox provider to be configured |

#### `resume_agent`

Registered with `run_agent`.

> Continue a finished subagent with a follow-up task. It keeps the original job's context, directory and host, so it takes neither cwd nor isolation. It returns a new job id, which job_list, job_stop and resume_agent take.

| Parameter | Description |
|---|---|
| `jobId` | Job id of the finished subagent to continue |
| `task` | The follow-up instruction for the subagent |
| `title` | Short title for this job, shown in the job list |
| `expectedSeconds` | Roughly how long you expect this to take, in seconds. Nothing is killed at that mark: if it is still running you are told so, and you decide whether to let it continue. |

#### `job_list`

> Every job this session has running in the background, grouped by kind, with elapsed time and the duration you expected. A finished job is not listed: it reported itself when it ended.

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
bash long sleeper
run_agent greeter
resume_agent greeter follow-up
job_stop long sleeper
job_list
```

`job_stop` shows the title of the job it is stopping, looked up by id, so you never read an id.

Each tool also registers a `label` — `bash`, `Run agent`, `Resume agent`, `List jobs`, `Stop job`
— which pi's interactive tool view does not display.

### What neither sees

The CLI flag `--jobs-depth`, described as `Internal: remaining subagent depth`. It appears in
`pi --help` only.

---

## B. Tool results

One section per tool, and one per reader. The two views are produced separately: the model gets a
record it can act on, you get one line that says what changed.

### `bash`

`bash` returns one of three results. Which one depends on `expectedSeconds` and on what the command
did while the model waited.

#### What the model sees — the command ended while it waited

`expectedSeconds` under 180, and the command finished first. The body is the output file, cut to its
last `DEFAULT_MAX_LINES` lines or `DEFAULT_MAX_BYTES` bytes — Pi's own two numbers, 2000 and 50KB,
imported from it rather than chosen here — or `(no output)` when the command printed nothing.

```
<the output, or the end of it>

The command exited with code <exit code> after <elapsed>.
```

An `It ended because …` line is added after the exit sentence when the runner reported a reason.
Nothing else is added when the model is holding the whole output. Concretely:

```
alpha
omega

The command exited with code 0 after 2s.
```

**The path appears only when something was cut**, as one more line of the body, after a blank line,
where it sits next to the output it describes:

```
<the end of the output>

This is the last 9.8KB of 23.3KB. The whole output is at <agent dir>/jobs/<job id>/output.

The command exited with code 0 after 2s.
```

Bytes, where Pi's own bash tool counts lines. Pi held the whole output in memory and could count it;
ours is on disk and only its end was read, so the number that is true without a second read is the
file size (C5, C7).

The line belongs to the body rather than to the sentences after it, which is why no caller decides
whether to add it: `tail` reads `status` off the job and appends it or does not. That is the same
field `index.ts` branches on to pick this result over the next one, so the two cannot disagree.

No job id: the command is over, so `job_list` will not list it and `job_stop` has nothing to stop.
When the output was cut, the path is the handle that outlives the call; when it was not, there is
nothing left to fetch and naming a file would only invite a wasted read (C8).

#### What the model sees — the wait ended and the command did not

`expectedSeconds` under 180, and either the estimate passed or the human interrupted. The body is
cut the same way, and is left out entirely when there is none. No `This is the last …` line is added
here whatever was cut, because the job's `status` is still `running`: the command is still writing,
so the last line of the result already names the file and promises more, and a second path would say
the same thing twice.

```
<the end of the output>

Command <title> is still running after <elapsed>, longer than the <expectedSeconds>s you expected.
It has not been stopped and is now in the background.
Its job id is <job id>.
Its whole output is collected at <agent dir>/jobs/<job id>/output.
You will be notified when it ends.
```

When the human interrupted instead, that first sentence reads:

```
Command <title> is still running after <elapsed>; you stopped waiting for it.
```

Concretely:

```
tick-1
tick-2
tick-3
tick-4

Command tick loop is still running after 4s, longer than the 4s you expected.
It has not been stopped and is now in the background.
Its job id is 01a09a6a-d8b4-740c-83ef-91218d51df7a.
Its whole output is collected at /home/rmng/.pi/agent/jobs/01a09a6a-d8b4-740c-83ef-91218d51df7a/output.
You will be notified when it ends.
```

#### What the model sees — the command started in the background

`expectedSeconds` of 180 or more, or `null`. The model never waited, so there is no output yet.

```
Command <title> is started in the background. You will be notified when it finishes, and again if it is still running after <expectedSeconds>s.
Its job id is <job id>.
Its output is collected at <agent dir>/jobs/<job id>/output.
```

The first line differs for a service, which is not waited on at all:

```
Command <title> is started in the background. You will be notified if it stops.
```

`<agent dir>` is `$PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that is unset. A command job never
has a sandbox, because `bash` has no `isolation` parameter.

#### What you see

One of three, matching the three above. The first two carry the end of the output, cut shorter than
the model's — **the last 5 lines or 1000 bytes**, whichever is shorter — followed by a blank line.
The two halves are cut apart on purpose, and Pi does the same: the model is reading the output and
you are glancing at it, so 2000 lines of a build log belongs in its result and not in your
scrollback. Pi shows five lines of its own for the same reason.

```
bash list etc
ImageMagick-7
UPower
X11
adduser.conf

Finished in 0s.
Exit code: 0
```

```
bash rows
row-1
row-2
row-3
row-4

Still running after 4s, expected 4s.
Now in the background.
```

The line under the output reads `Still running after 4s; you stopped waiting.` when you
interrupted. A command that printed nothing shows no output block at all, and no `(no output)`.

```
bash dev server
Expected: none
```

`Expected:` is the number of seconds, or `none` for a service. No id, no path, no command, ever.

#### Errors

None the model can cause. `bash` validates nothing beyond the schema pi enforces for it. A command
that exits non-zero is reported through its exit sentence, not as an error from this call.

### `run_agent`

#### What the model sees

```
Agent <title> is started in the background. You will be notified when it finishes, and again if it is still running after <expectedSeconds>s.
Its job id is <job id>.
```

An isolated subagent adds a third line, and then a blank line and **your
`isolated.instructions` string verbatim** — the one piece of model-facing text that comes from
the config file rather than the source, delivered where a sandbox was actually made:

```
It is running in sandbox <sandbox id>.

<your isolated.instructions string>
```

There is no output path and no result path. The raw output of an agent job is pi's JSON event
stream, which is of no use to the model; the path to its answer arrives with the completion
message, once the answer exists.

`expectedSeconds` is a required number, so an agent job is always awaited.

#### What you see

```
run_agent greeter
Expected: 120s
```

#### Errors

Five. Three come from the sandbox provider; two are the refusals that replaced withholding the
tool.

| # | Message | Raised when |
|---|---|---|
| 1 | `This session has no subagent depth left, so it cannot start one. Do the work here.` | the session is a subagent at the configured depth |
| 2 | `No sandbox provider is configured, so isolation "isolated" cannot be used. Set "isolated" in settings.json, or leave isolation out and the subagent runs here.` | `isolation: "isolated"` with no `isolated` in the config |
| 3 | `isolated.create failed: <stderr, trimmed>` | the configured `isolated.create` command exits non-zero |
| 4 | `isolated.create must print {id, ssh, cwd}: <stdout, trimmed>` | its output parses as JSON but is missing `id`, `ssh` or `cwd` |
| 5 | `isolated.create ssh must start with ssh: <the ssh value>` | its `ssh` field's first word is not `ssh` |

Rows 3 to 5 are reachable only when `isolated` is configured. If `isolated.create` prints something
that is not JSON at all, both readers instead see the raw `JSON.parse` message from the runtime,
for example `Unexpected token o in JSON at position 1`.

### `resume_agent`

#### What the model sees

The same lines as `run_agent`, with a **new** job id. The sandbox line is present when the job
being continued had one, since a resume stays on the same host.

```
Agent greeter follow-up is started in the background. You will be notified when it finishes, and again if it is still running after 120s.
Its job id is 01a0997c-9319-7639-87ae-48b4998f00b1.
```

#### What you see

```
resume_agent greeter follow-up
Expected: 120s
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
2 background commands are in progress:

Command long sleeper has been running for 0s, with no estimate.
Its job id is 01a09979-cbb7-7639-87ae-48ae2d46581d.
Its output is collected at /home/rmng/.pi/agent/jobs/01a09979-cbb7-7639-87ae-48ae2d46581d/output.

Command quick failure has been running for 0s, against the 60s you expected.
Its job id is 01a09979-cbb8-7639-87ae-48b1389afa99.
Its output is collected at /home/rmng/.pi/agent/jobs/01a09979-cbb8-7639-87ae-48b1389afa99/output.

One agent is in progress:

Agent greeter has been running for 0s, against the 120s you expected.
Its job id is 01a09979-cbb9-7639-87ae-48b3100fbdd1.
```

A group with no jobs is omitted. A header goes singular at one job. An agent entry carries no
output path, for the reason given under `run_agent`, and carries a sandbox sentence when it has
one.

When nothing is running:

```
No jobs are running.
```

#### What you see

Exactly what `/jobs` prints — the background jobs as a table:

```
job_list
job id                                type     title                elapsed  expected
01a09a13-04cf-73d2-88ce-082fbf7c871f  command  long sleeper              2s     none
01a09a13-04d2-73d2-88ce-0831f03dcabb  command  build the docs site       1s     600s
01a09a13-04d2-73d2-88ce-08326fada276  agent    greeter                   1s     300s
```

#### Errors

None.

### `job_stop`

#### What the model sees

```
Job <title> is stopped after <duration>.
Its output is at <agent dir>/jobs/<job id>/output.
```

The second line is `Its response is at <agent dir>/jobs/<job id>/result.` for a subagent, since
the raw output of an agent job is a JSON event stream.

Stopping a job that has already ended is not an error. The first line says so instead:

```
Job long sleeper had already stopped after 42s.
Its output is at /home/rmng/.pi/agent/jobs/01a09979-cbb7-7639-87ae-48ae2d46581d/output.
```

The word before `after` is one of `finished`, `failed` or `stopped`.

**A job ended by job_stop sends no completion message.** The model already has this answer, so a
second delivery would only cost it a turn.

#### What you see

```
job_stop long sleeper
```

One line. The job is gone from the footer count, which is the rest of the answer.

#### Errors

| Message | Raised when |
|---|---|
| `no such job: <id>` | `id` names no job this session started |

### Outcome words, elapsed and exit code

A job that has ended is one of three things. The same three words are used everywhere:

| Word | Meaning |
|---|---|
| `finished` | ended successfully |
| `failed` | ended unsuccessfully |
| `stopped` | `job_stop` ended it |

There is no `timed out`, because nothing in this extension ends a job on a clock. Passing
`expectedSeconds` produces a message, not an outcome.

An abort outranks whatever the underlying process reported, so a stopped job says `stopped` rather
than repeating the operating system's phrasing for a kill.

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

### A finished command job's notification

Sent by the extension, not by a tool, when a command job ends on its own. A command job sends one
**unless the model already has the answer** — that is, unless `job_stop` ended it, or it ended
while the model was still waiting for it in the foreground, in which case the tool result of
section B was the answer.

#### What the model sees

A custom message of type `pi-background`, with `deliverAs: "followUp"` and `triggerTurn: true`, so
it wakes the agent for a new turn. Wrapped in tags:

```
<pi-background>
Background command quick failure failed after 3s, with exit code 7.
Its job id is 01a09979-cbb8-7639-87ae-48b1389afa99.

Its output:

Traceback (most recent call last):
  File "build.py", line 12
ValueError: no such target

</pi-background>
```

An `It ended because …` line sits between the first sentence and the job id when the runner
reported a reason. The body under `Its output:` is cut exactly as a foreground command's is — Pi's
2000 lines or 50KB — and reads `(no output)` when the command printed nothing. It is the same
`tail`, so when the cut lost something the same `This is the last 9.8KB of 23.3KB. The whole output
is at …` line ends the body, and when it did not, nothing does.

Nobody asked for this message, so it is tempting to cut it shorter than a result the model is
waiting on. It is not cut shorter, because the model cannot ask for more of a message it did not
request, and a build that failed overnight is exactly the output worth having in full.

The message carries **no instruction**. The "end your turn rather than polling" wording exists
only in the tool description in A.

#### What you see

The end of the output — your five lines, not the model's — then the sentence.

```
[pi-background]

Traceback (most recent call last):
  File "build.py", line 12
ValueError: no such target

Background command quick failure failed in 3s.
Exit code: 7
```

An `Exit reason:` line follows when there is one. No id, no path, no tags. An agent's completion
never carries output, because an agent's output is pi's JSON event stream.

### A finished `run_agent` or `resume_agent` job's notification

Sent on the same mechanism, with the same type and tags.

#### What the model sees

```
<pi-background>
Agent greeter finished after 5s.
Its job id is 01a09979-cbb9-7639-87ae-48b3100fbdd1.

Read the agent's response at /home/rmng/.pi/agent/jobs/01a09979-cbb9-7639-87ae-48b3100fbdd1/result.
</pi-background>
```

There is no exit code: for a subagent the outcome word carries the whole answer. An
`It ended because …` line appears when it failed.

The `Read the agent's response at …` line is present **only when that file is not empty**. A killed
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

### A job that has overrun

Sent when an awaited job passes `expectedSeconds` and is still running. A service never sends one.
The job is **not** stopped: this is a fact handed to the model, not an action taken on its behalf.

#### What the model sees

```
<pi-background>
Command underestimated job is still running after 10s, longer than the 10s you expected.
It has not been stopped. Leave it running, or stop it with job_stop.
Its job id is 01a09a37-1a83-72e4-99d5-2b05b3d9e3bc.
</pi-background>
```

`Command` is `Agent` for a subagent. The message names both options and recommends neither: the
extension cannot tell a stuck build from a large one, and the model started the job.

It repeats at every multiple of `expectedSeconds` — `2x`, `3x`, `4x` — **except** that a repeat is
skipped when one was sent less than five minutes ago. So `expectedSeconds: 1` on a job that runs an
hour sends one message at one second and then one every five minutes, not 3,600 of them.

**A command that ran in the foreground never sends the `1x` one.** Its `1x` mark is the moment the
wait ended, and the tool result of section B already said it there. The clock starts at that
handoff, so the first message of this kind arrives at the `2x` mark — and the five-minute floor
usually swallows that one too.

#### What you see

```
[pi-background]

Command underestimated job still running after 10s, expected 10s.
```

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

A nudge is sent only when: the session is not itself a subagent, `nudge` is configured, fewer
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

Sent to `nudge.model`. **Neither the session model nor you ever sees it.**

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

### The job count in pi's footer

One status, under the key `pi-background`, present only while at least one job is running:

| Running jobs | Text |
|---|---|
| 1 command | `1 command` |
| 2 commands | `2 commands` |
| 1 subagent | `1 subagent` |
| 2 commands and 1 subagent | `2 commands, 1 subagent` |
| none | the status is cleared |

The key is the extension's own name, so `pi-powerline-footer` can lift it out of its overflow row
into a segment of its own with a `customItems` entry naming that key. This is pure UI. It is not a
session entry and is never saved.

### The `/jobs` listing

`/jobs` is described in pi's command list as:

> List background jobs (shown to you only, never sent to the model)

It writes a session entry of a custom type that pi keeps out of the model's context by design. One
row per background job, under a dimmed heading:

```
job id                                type     title                elapsed  expected
01a09a13-04cf-73d2-88ce-082fbf7c871f  command  long sleeper             15s     none
01a09a13-04d2-73d2-88ce-0831f03dcabb  command  build the docs site      15s     600s
```

Five columns: `job id`, `type` (`command` or `agent`), `title`, `elapsed`, `expected`. Every column
is sized to its widest cell; the two durations are right-aligned. `expected` is `none` for a
service.

No status column, because everything listed is running. No sandbox id: it is in `job_list`'s
model-facing rows, not here. This is the same table `job_list` shows you.

When nothing is running, the whole entry is one line and there is no heading:

```
No background jobs.
```

### Configuration and startup errors

Thrown or logged outside a tool call, so pi shows them as an extension error or on stderr.

| Where | Text |
|---|---|
| load | `<file> + <file>: "pi-background": unknown key "<key>". The keys are maxDepth, nudge, isolated.` |
| load | `<file> + <file>: "pi-background": "<object>": unknown key "<key>". The keys are <keys>.` |
| load | `<file> + <file>: "pi-background": "<object>": "<key>" is required.` |
| load | `<file> + <file>: "pi-background": "<key>" is <value>, which that key does not take.` |
| load | `<file> is not valid JSON: <parser message>` |
| load | `<file>: "pi-background" must be a JSON object.` |
| `session_start` | `pi-background: --jobs-depth must be a whole number, got "<value>"` |
| startup | `pi-background: could not read starttime from /proc/self/stat` |
| `agent_settled` | `nudge.model not found: <model>` |
| `agent_settled` | `nudge classifier failed: <provider error>` |
| `agent_settled` | `nudge classifier produced no text: <model> at effort "<level>" within 2048 tokens` |

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

No system-prompt contribution of its own, no `promptGuidelines`, no skills, no prompt templates.
Sections A to D are the complete surface. A session with this extension loaded and no jobs running
carries the five tool descriptions and `bash`'s one-line `promptSnippet`, which pi puts in the
tool list of its own system prompt — that snippet is transcribed in section A. A session with no
subagent depth left still carries all five: which tools exist does not depend on the config (§9.4
of the design).
