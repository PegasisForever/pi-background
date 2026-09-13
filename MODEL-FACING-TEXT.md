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

### Every successful call to `run_command`, `run_agent` and `job_stop`

One record, built by `describe()`:

```
01a09638-0a27-72de-9e2b-7cf185110453  [running]  0s
ran: sleep 20; echo finished
output: /home/rmng/.pi/agent/jobs/01a09638-0a27-72de-9e2b-7cf185110453/output
```

`[running]` becomes `[done]` or `[failed: <reason>]`, where `reason` is `exit <n>`, `exit signal`, `stopped`, `timeout`, or a thrown message. An agent job adds a `result:` line, and an isolated one adds `sandbox: <id>`.

### `job_list`

The same record per job, blank-line separated, or the single word `no jobs`.

### Errors the model can cause

| Tool | Message |
|---|---|
| `run_agent` | `no such job: <id>` |
| `run_agent` | `job <id> is still running; stop it or wait for it` |
| `run_agent` | `resumeFrom continues the original job's host; drop isolation` |
| `run_agent` | `isolated.create must return an ssh command: <string>` |
| `job_stop` | `no such job: <id>` |

---

## C. Injected messages

### A job's completion notification

Delivered as a custom message with `deliverAs: "followUp"` and `triggerTurn: true`, only for a job that had a timeout:

```
<pi-jobs>
01a0962c-6dd4-73cf-8ad4-e807ce713de8  [done]  20s
ran: sleep 20; echo finished
output: /home/rmng/.pi/agent/jobs/01a0962c-6dd4-73cf-8ad4-e807ce713de8/output
</pi-jobs>
```

The body is the same `describe()` record as a tool result. It carries no instruction — the "do not poll" wording lives only in the tool description (§6.3 of the design).

### The nudge

Sent as an ordinary user message, at most once per user turn:

> You said you would &lt;action&gt;, but did not. Continue.

`<action>` is whatever the classifier returned, at most about 15 words, e.g. `Read the file /tmp/does-not-matter.txt.` — which yields:

> You said you would Read the file /tmp/does-not-matter.txt., but did not. Continue.

Note the classifier's phrasing lands mid-sentence, so capitalisation and a trailing full stop can read awkwardly.

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
| `session_start` | `pi-jobs.json: <schema message>` |
| `session_start` | `pi-jobs.json: nudgeModel and nudgeThinking must be set together` |
| `session_start` | `pi-jobs: --jobs-depth must be a whole number, got "<value>"` |
| startup | `pi-jobs: could not read starttime from /proc/self/stat` |
| `agent_settled` | `nudgeModel not found: <model>` |
| `agent_settled` | `nudge classifier failed: <provider error>` |
| `agent_settled` | `nudge classifier produced no text: <model> at thinking "<level>" within 2048 tokens` |
| stderr | `pi-jobs: <job id> settled but reporting failed: <error>` |

The widget under the editor (`2 commands, 1 subagent`) and the `/jobs` listing are also yours
alone. The widget is UI, and `/jobs` writes a `custom` session entry, which pi keeps out of LLM
context by design — unlike `sendMessage`, which is how job completions do reach the model.

The three `agent_settled` ones recur at every turn end until the configuration is fixed. That is
deliberate: there is no latch, so a broken classifier cannot go quiet.

---

## What this extension does **not** say to the model

No system-prompt contribution, no `promptSnippet`, no `promptGuidelines`, no skills, no prompt templates. Everything above is the complete surface. A session with this extension loaded and no jobs running carries only the four tool descriptions.
