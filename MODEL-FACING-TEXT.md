# Every word this extension puts in front of a model

Extracted verbatim from `src/`. Four audiences, kept separate because they cost differently:

- **A. Always in context** — tool descriptions and parameter descriptions. Paid on every turn.
- **B. Tool results** — paid once per call.
- **C. Injected messages** — enter the conversation and stay there.
- **D. The nudge classifier's own prompt** — sent to a different model, never to the session.

Errors thrown from a tool reach the model as that tool's result, so they are in **B**.

---

## A. Always in context

### `run_command`

Label: `Run command`

> Start a shell command in the background and return immediately. Give timeoutSeconds a number for work you are waiting on: the result is delivered to you automatically when it ends, so end your turn rather than polling or sleeping. Give it null for a service that runs until stopped and never notifies. It returns a job id, which job_list and job_stop take.

| Parameter | Description |
|---|---|
| `command` | Shell command |
| `cwd` | Working directory |
| `timeoutSeconds` | **Required.** Seconds to wait, as pi's bash tool counts them. Pass null for a service such as a dev server: it runs until stopped and never notifies. |

### `run_agent`

Registered only when the session has depth left. Label: `Run agent`

> Start a subagent on a task and return immediately. The result is delivered to you automatically when it finishes, so end your turn rather than polling or sleeping. The subagent starts with no context: put everything it needs in the task. It returns a job id, which job_list and job_stop take.

Then, when `isolated` is configured, a blank line and **your `isolated.instructions` string verbatim**. This is the one piece of model-facing text that comes from config rather than source. The value in the test config reads:

> An isolated subagent runs in a throwaway sandbox under /tmp/sandboxes/&lt;sandbox id&gt;. It stays up after the job ends; run `rm -rf /tmp/sandboxes/&lt;sandbox id&gt;` when you no longer need it.

| Parameter | Description |
|---|---|
| `task` | The complete instruction for the subagent |
| `timeoutSeconds` | **Required.** Seconds to wait before giving up, as pi's bash tool counts them |
| `cwd` | Working directory; not allowed with resumeFrom |
| `isolation` | isolated runs in a fresh sandbox — **this row exists only when `isolated` is configured**; with no provider the parameter is not registered at all |
| `resumeFrom` | Job id to continue |

### `job_list`

Label: `List jobs`

> Every job this session started with run_command or run_agent: status, elapsed, output paths and sandbox ids.

No parameters.

### `job_stop`

Label: `Stop job`

> Stop a running job by its id — a shell command or a subagent.

| Parameter | Description |
|---|---|
| `id` | *(none)* |

### The CLI flag

`--jobs-depth`, described as `Internal: remaining subagent depth`. It appears in `pi --help`, not in the model's context.

---

## B. Tool results

One section per tool. The four tools share a formatter, `describe()` in `src/jobs.ts`, but the
lines it emits differ per tool, so each is written out in full below rather than cross-referenced.

A thrown error reaches the model as that tool's result, so each tool's errors are listed with it.

### `run_command` — result of a successful call

Always three lines. `run_command` never takes an `isolation` parameter, so a command job can never
have a sandbox id, and command jobs have no result file.

```
<job id>  [running]  0s
ran: <label>
output: <agent dir>/jobs/<job id>/output
```

Concretely:

```
01a09638-0a27-72de-9e2b-7cf185110453  [running]  0s
ran: sleep 20; echo finished
output: /home/rmng/.pi/agent/jobs/01a09638-0a27-72de-9e2b-7cf185110453/output
```

- `<job id>` is a uuidv7.
- The status is **always** `[running]`. `run_command` returns the moment the job starts, so the
  model never sees any other status from this tool.
- The elapsed field is **always** `0s` for the same reason.
- `<label>` is the `command` argument: leading and trailing whitespace stripped, first line only,
  and if that line is longer than 120 characters it is cut at 120 and `…` is appended.
- There is **no** `result:` line. That line belongs to agent jobs only.
- There is **no** `sandbox:` line.
- `<agent dir>` is `$PI_CODING_AGENT_DIR`, or `~/.pi/agent` when that is unset.

### `run_command` — errors

None the model can cause. `run_command` validates nothing beyond the schema pi enforces for it, and
it returns as soon as the job is registered. A command that exits non-zero is reported later as a
job status, not as an error from this call.

### `run_agent` — result of a successful call

Four or five lines. The fifth appears only for a job that has a sandbox id.

Without a sandbox — a local subagent, or a `resumeFrom` of a local one:

```
<job id>  [running]  0s
ran: <label>
output: <agent dir>/jobs/<job id>/output
result: <agent dir>/jobs/<job id>/result
```

With a sandbox — `isolation: "isolated"`, or a `resumeFrom` of a job that had a sandbox:

```
<job id>  [running]  0s
ran: <label>
output: <agent dir>/jobs/<job id>/output
result: <agent dir>/jobs/<job id>/result
sandbox: <sandbox id>
```

Concretely:

```
01a0991f-e35b-7203-afe8-c73c03ac623e  [running]  0s
ran: Run the shell command: sleep 300. Then reply DONE.
output: /home/rmng/.pi/agent/jobs/01a0991f-e35b-7203-afe8-c73c03ac623e/output
result: /home/rmng/.pi/agent/jobs/01a0991f-e35b-7203-afe8-c73c03ac623e/result
```

- The status is **always** `[running]` and the elapsed field is **always** `0s`, as with
  `run_command`.
- `<label>` is the `task` argument, cut the same way: stripped, first line only, 120 characters
  plus `…`.
- The `result:` line is present on **every** `run_agent` result, including a job that later fails.
  The file it names does not exist yet at the moment this text is returned; it is written when the
  job ends.
- `<job id>` is a new uuidv7 on every call, including a `resumeFrom` call. A resumed job therefore
  reports different `output:` and `result:` paths from the job it continues.
- `<sandbox id>` is the `id` field printed by the configured `isolated.create` command.

### `run_agent` — errors

Eight distinct messages. The first five are argument errors and are raised before anything runs.

| # | Message | Raised when |
|---|---|---|
| 1 | `no such job: <id>` | `resumeFrom` names an id this session has no job for |
| 2 | `job <id> is still running; stop it or wait for it` | `resumeFrom` names a job that has not finished |
| 3 | `resumeFrom continues the original job's host; drop isolation` | `resumeFrom` and `isolation` are both given |
| 4 | `resumeFrom continues the original job's directory; drop cwd` | `resumeFrom` and `cwd` are both given |
| 5 | `another job is already continuing <id>` | a second resume of the same subagent session while the first is still running |
| 6 | `isolated.create failed: <stderr, trimmed>` | the configured `isolated.create` command exits non-zero |
| 7 | `isolated.create must print {id, ssh, cwd}: <stdout, trimmed>` | its output parses as JSON but is missing `id`, `ssh` or `cwd` |
| 8 | `isolated.create ssh must start with ssh: <the ssh value>` | its `ssh` field's first word is not `ssh` |

Messages 6 to 8 are reachable only when `isolated` is configured. If `isolated.create` prints
something that is not JSON at all, the model instead sees the raw `JSON.parse` message from the
runtime, for example `Unexpected token o in JSON at position 1`.

### `job_list` — result

Every job this session started, running and finished alike, oldest first, each rendered exactly as
that job's own tool would render it and separated by one blank line:

```
01a09638-0a27-72de-9e2b-7cf185110453  [done]  20s
ran: sleep 20; echo finished
output: /home/rmng/.pi/agent/jobs/01a09638-0a27-72de-9e2b-7cf185110453/output

01a0991f-e35b-7203-afe8-c73c03ac623e  [failed: exit 1]  3s
ran: Run the shell command: sleep 300. Then reply DONE.
output: /home/rmng/.pi/agent/jobs/01a0991f-e35b-7203-afe8-c73c03ac623e/output
result: /home/rmng/.pi/agent/jobs/01a0991f-e35b-7203-afe8-c73c03ac623e/result
```

When the session has started no jobs at all, the entire result is the two words:

```
no jobs
```

Unlike `run_command` and `run_agent`, this tool can show statuses other than `[running]` and
elapsed values other than `0s`. See "Status and elapsed" below.

### `job_list` — errors

None.

### `job_stop` — result of a successful call

The record for the job named by `id`, after the stop has fully settled, rendered exactly as that
job's own tool renders it. For a command job:

```
01a098fc-ea7e-7155-854c-ee29c54b99be  [failed: stopped]  40s
ran: sleep 300
output: /home/rmng/.pi/agent/jobs/01a098fc-ea7e-7155-854c-ee29c54b99be/output
```

For an agent job the `result:` line is present, and `sandbox:` too when it had one.

Stopping a job that has already finished is not an error: the tool returns that job's existing
record, with whatever status it already had.

### `job_stop` — errors

| Message | Raised when |
|---|---|
| `no such job: <id>` | `id` names no job this session started |

### Status and elapsed, as they appear in `job_list`, `job_stop` and the notifications in C

The bracketed field is one of:

| Text | Meaning |
|---|---|
| `[running]` | the job has not ended |
| `[done]` | the job ended successfully |
| `[failed: <reason>]` | the job ended unsuccessfully |

`<reason>` differs by job kind, because the two kinds are run by different code:

| Job kind | `<reason>` | Produced when |
|---|---|---|
| command | `exit <n>` | the shell command exited with status `n` |
| command | `exit signal` | the shell reported no exit status |
| command | `stopped` | `job_stop` aborted it |
| command | `timeout` | `timeoutSeconds` elapsed |
| command | `stopped (<message>)` or `timeout (<message>)` | it aborted and the underlying error said more than the abort itself |
| agent | `exit <n>` | the child `pi` process exited with status `n` |
| agent | `killed by <signal>` | the child was killed, for example `killed by SIGKILL` |
| agent | `The operation was aborted` | `job_stop` aborted it, or `timeoutSeconds` elapsed — the child process reports the abort before the job layer can label it |
| agent | `no assistant message in the last 4194304 bytes of <path>` | the child exited 0 but produced no final assistant message |
| agent | `unparsable event in <path> line <n>` | the child's JSON output stream was corrupt |
| agent | any spawn error message | for example `spawn ssh ENOENT` |

The elapsed field is: `<n>s` below one minute, `<m>m<ss>s` below one hour, `<h>h<mm>m` above —
for example `9s`, `3m58s`, `2h04m`.

---

## C. Injected messages

Two kinds, three sources. They enter the conversation and stay there.

### A finished `run_command` job's notification

Sent by the extension, not by a tool, when a command job started with a **number** for
`timeoutSeconds` ends. A command job started with `null` never sends this.

Delivered as a custom message of type `pi-background`, with `deliverAs: "followUp"` and
`triggerTurn: true`, so it wakes the agent for a new turn. It is wrapped in tags:

```
<pi-background>
01a0962c-6dd4-73cf-8ad4-e807ce713de8  [done]  20s
ran: sleep 20; echo finished
output: /home/rmng/.pi/agent/jobs/01a0962c-6dd4-73cf-8ad4-e807ce713de8/output
</pi-background>
```

The three lines inside the tags are the same shape `run_command` returned, with `[running]  0s`
replaced by the job's final status and its real duration. There is no `result:` line and no
`sandbox:` line, for the same reasons as in B.

The message carries **no instruction**. The "end your turn rather than polling" wording exists
only in the tool description in A.

### A finished `run_agent` job's notification

Sent on the same mechanism, with the same `pi-background` type and the same wrapping tags. Every
agent job sends one: `run_agent` requires a number for `timeoutSeconds`, so the null case that
silences a command job cannot occur here.

Without a sandbox:

```
<pi-background>
01a0991f-e35b-7203-afe8-c73c03ac623e  [done]  8s
ran: Run the shell command: sleep 300. Then reply DONE.
output: /home/rmng/.pi/agent/jobs/01a0991f-e35b-7203-afe8-c73c03ac623e/output
result: /home/rmng/.pi/agent/jobs/01a0991f-e35b-7203-afe8-c73c03ac623e/result
</pi-background>
```

With a sandbox, a fifth line `sandbox: <sandbox id>` follows `result:`.

The `result:` file exists by the time this message is sent. It holds the subagent's final
assistant message as plain text, and is empty when a failed job produced none. The message does
not quote it: the model must read the file.

Like the command notification, this carries no instruction.

### The nudge

Sent as an ordinary user message, as if the person had typed it. At most **five** per user turn;
the counter resets on the next input that did not come from this extension.

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

---

## D. The nudge classifier's prompt

Sent to `nudgeModel`, never to the session. System prompt:

> Below is an assistant message that ended a turn. If it promised a next action that it did not perform, reply with that action in at most 15 words. Otherwise reply with exactly: NO

The single user message is the last assistant message's text, with nothing added — no framing, no session context, no tool history.

Its reply is read as: empty → throw; `NO` (any case) → no nudge; anything else → the action.

---

## E. Text that reaches you, never the model

Listed so the boundary is auditable. These are thrown or logged outside a tool call, so pi shows
them as an extension error or on stderr.

| Where | Text |
|---|---|
| `session_start` | `pi-background.json: <schema message>` |
| `session_start` | `pi-background.json: nudgeModel and nudgeThinking must be set together` |
| `session_start` | `pi-background: --jobs-depth must be a whole number, got "<value>"` |
| startup | `pi-background: could not read starttime from /proc/self/stat` |
| `agent_settled` | `nudgeModel not found: <model>` |
| `agent_settled` | `nudge classifier failed: <provider error>` |
| `agent_settled` | `nudge classifier produced no text: <model> at thinking "<level>" within 2048 tokens` |

The widget under the editor (`2 commands, 1 subagent`) and the `/jobs` listing are also yours
alone. The widget is UI, and `/jobs` writes a `custom` session entry, which pi keeps out of LLM
context by design — unlike `sendMessage`, which is how job completions do reach the model.

The three `agent_settled` ones recur at every turn end until the configuration is fixed. That is
deliberate: there is no latch, so a broken classifier cannot go quiet.

---

## What this extension does **not** say to the model

No system-prompt contribution, no `promptSnippet`, no `promptGuidelines`, no skills, no prompt templates. Everything above is the complete surface. A session with this extension loaded and no jobs running carries only the four tool descriptions.
