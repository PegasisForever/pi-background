# pi-background — feature list to pick from

> **Frozen record, not current documentation.** This is the menu that was put in front of you
> before anything was built, with your marks on it, kept because the reasons for the picks are
> here and nowhere else. Its API details are the ones that were *proposed*, and several were
> changed afterwards — `timeoutMinutes` became `timeoutSeconds` and then `expectedSeconds`, which
> kills nothing; `resumeFrom` became the `resume_agent` tool; jobs gained a required `title`; and
> `run_command` became `bash`, replacing pi's own shell tool and waiting for a short command
> instead of always returning at once.
>
> The wording changed too: the model's half of every string is now written in sentences, and the
> job count moved from a widget of its own into pi's footer.
>
> For what the extension does now, read `docs/DESIGN.md`. For every string it emits, read
> `docs/MODEL-FACING-TEXT.md`. Neither of those is a record of how the design was reached; this
> is.

One pi extension for: subagents, background commands, completion nudge, activity signal.
Internal use only. Linux only. Inside RMNG clones.

Mark each item: `[x]` build it, `[ ]` skip it, `[?]` discuss.
Items are ordered so that everything above a line is needed by everything below it.

---

## 0. Summary of the research

I read the three projects you named, their issue trackers, and their commit history.
I also read the pi 0.85.1 harness docs and ran live tests against pi on this clone.

| Project | Source size | Issues filed | Core problem |
|---|---|---|---|
| nicobailon/pi-subagents | 100,962 lines | 850 | Does 15 jobs. 40% of the code is deletable for our use. |
| ismailsaleekh/pi-background-tasks | 31,437 lines | 11 | The background-task part is only 6,263 lines. The rest is unrelated. |
| ranxianglei/billion-context-pi | ~2,800 lines (delegate part) | ~25 delegate | Closest to right. Good ideas, listed below. |

**The single most useful number:** pi-subagents has 850 issues, and 45 of them come from one
design decision — it guesses in the parent process which tools the child process will have.
We do not need that decision at all, so those 45 bugs cannot happen to us.

### Three things we can do now that they could not

1. **`agent_settled` exists.** pi added it in 0.83 (upstream issue #2110). It fires once, after
   all retries and queued messages, and means "pi will not continue on its own". Both
   pi-subagents and pi-background-tasks were designed before it existed and still carry the
   machinery they built to guess this. Your features 3 and 4 are only possible because of it.
   I confirmed it fires in interactive, json and rpc mode.

2. **`pi --mode rpc` over SSH works with no remote agent.** I ran a child pi locally and the same
   child over `ssh -T`, and the behaviour was identical: streaming, mid-run steering, and
   `agent_settled`. So "local subagent" and "isolated subagent" differ only in the command used
   to start the process. The existing RMNG fork installs a systemd service and an HTTP server in
   each child to do this. That whole layer can be deleted.

3. **A blocked child is visible for free.** Over RPC, a child that asks a question emits
   `extension_ui_request` and waits. I confirmed this live. pi-subagents built a 1,813-line
   file-mailbox subsystem for this and got its only open P0 deadlock out of it (their #2185).

---

## 1. The core model (pick one)

### - [x] 1a. One concept: a **job**  *(recommended)*

A job is anything the parent started that finishes later. Two kinds:

| Kind | What it is | How it runs |
|---|---|---|
| `command` | a shell command | `bash -lc <cmd>`, output to a file |
| `agent` | a subagent | `pi --mode rpc`, local or over SSH |

Both share: one id, one status, one output file, one completion notification, one status tool,
one stop tool. This is your point 2b. It removes a whole duplicate set of tools, states,
notification paths and TUI rows.

### - [ ] 1b. Two separate concepts, as the existing projects do

More tools for the model to choose between, two of everything to test and fix.
I do not recommend it.

---

## 2. Job lifetime and timeout (this is your point 2a)

### - [x] 2a. `timeout` is required and decides the job's meaning  *(recommended)*

- **Timeout set** → this is **awaited work**. On finish it notifies the parent and wakes a turn.
  The session is "working" while it runs.
- **Timeout absent** → this is a **service** (dev server, watcher). It never notifies, never
  wakes a turn, and never makes the session count as "working".

This one rule is what makes feature 6 (activity) deterministic and feature 5 (nudge) safe.
Today RMNG has to ask a language model "is `npm run dev` going to finish?" — under this rule
the agent has already said so.

### - [x] 2b. Model-chosen timeout, clamped

The model passes `timeoutMinutes`. No global default can fit both a 30-second grep and a
two-hour build. billion-context learned this in their issue #286. Clamp to 24 hours so a bad
value cannot hold a slot forever.

Note: remove clamp. I only use pi with long context SOTA models, always trust the model will do the right thing. we can delete a lot of logics using this reason.

### - [x] 2c. Jobs die when pi dies

A job is a child of the pi process. On quit or `/reload` we stop every job.

I recommend this. Keeping jobs alive across a pi restart is where pi-subagents got its
"process-terminal proof" consensus protocol (39 issues), and it still ships a bug where the
proof says the process is dead while its children are alive (their #2053).

### - [ ] 2d. Exception: `command` jobs survive `/reload`

Cheap to add **only if** we write output straight to a file instead of reading a pipe.
Then reattaching is `kill(pid, 0)` plus reading the file. pi-background-tasks cannot do this
because it uses pipes, which is their open issue #6.

Cost: about 40 lines. Risk: low. Say yes if a 20-minute test run dying on `/reload` annoys you.

---

## 3. Subagents

### - [x] 3a. One generic subagent type  *(your point 1a — recommended)*

No presets, no roles, no agent markdown files, no `--tools` allowlist. The parent writes the
whole instruction. The child runs pi with its normal tools.

What this deletes, measured in the reference projects:
- pi-subagents `src/agents/` — 7,461 lines, and its 57-field agent config.
- pi-subagents child tool plan — 262 lines of intersection logic, **45 issues**.
- billion-context role table, per-role models, tool allowlist — about 200 lines.

What you lose: a read-only subagent cannot be stopped from writing files. Their own README
admits the allowlist is not a real boundary anyway, because `bash` walks around it. If you want
a read-only child, say so in the task text.

### - [x] 3b. Transport: `pi --mode rpc` over stdio  *(recommended)*

One code path. Local is `spawn("pi", ["--mode","rpc", ...])`. Remote is
`spawn("ssh", [host, "pi --mode rpc ..."])`. Verified working on this machine.

Gives us, with no extra work: live progress, mid-run steering, abort, `agent_settled`,
and the blocked-on-a-question signal.

Note: pi exports an `RpcClient` class, but it hardcodes `spawn("node", ...)` and cannot answer
a child's question, so it cannot be used for the SSH case. We write our own reader — about 80
lines around pi's own `attachJsonlLineReader`.

### - [x] 3c. `isolation: "local" | "isolated"`  *(your point 1b)*

The model picks per call. `local` runs in the same clone. `isolated` gets its own sandbox.

### - [x] 3d. Isolated sandboxes come from a config command  *(your point 1b — recommended)*

The extension runs one command from its config file. That command prints an SSH command on
stdout. The extension then uses that SSH command as the transport, and calls a matching
teardown command when the job ends.

```jsonc
// ~/.pi/agent/settings.json
"pi-background": {
  "isolated": {
    "create":  "rmng-sandbox-create",   // prints: ssh -o ... rmng@10.99.0.31
    "destroy": "rmng-sandbox-destroy {id}"
  }
}
```

This keeps RMNG out of the extension. The extension knows nothing about clones. You can point
it at anything that can print an SSH command.

Note: add an additional config "isolated instructions", to add to the prompt, to tell the parent agent the bahavior of the isolated sandbox, for exmaple, how to access files in the sandbox.

### - [ ] 3e. RMNG sandbox script, shipped beside the extension

The concrete `rmng-sandbox-create` for our fleet. This is where RMNG knowledge lives.

**This needs a decision from you — see section 9.**

### - [x] 3f. Steering, stop, and resume of a running subagent

`steer` and `stop` are two RPC commands, so they are nearly free. Resume needs the child's
session file pinned to a known path, which is one extra CLI flag. Copy the session file when
resuming so the resumed run is itself resumable (billion-context issue #235).

### - [x] 3g. A blocked child reaches the parent

When a child emits `extension_ui_request`, we surface the question in the parent's job status
and let the parent answer it. Roughly 30 lines. Replaces pi-subagents' 1,813-line intercom.

### - [x] 3h. Nested subagents

A subagent starting its own subagent. I recommend **no**. It is the source of depth caps,
fan-out budgets and tree accounting in both projects, and you can run two jobs from the parent.

---

## 4. Results and notification

### - [x] 4a. The result is a file path, not the content  *(recommended)*

This is billion-context's best idea and the reason their tool is cheap. The completion message
carries: status, the job name, the elapsed time, and the path. The model reads the file only
when it needs the detail.

Exception: a **failed** job carries the first 500 characters inline, because deciding whether to
retry must not need a second tool call.

### - [x] 4b. Delivery: `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`

The one API pi gives us. Notes from the research:
- It returns nothing and cannot be awaited. Mark a job "notified" only **after** the call
  returns, never before (billion-context commit 0889696 — marking first turned one lost result
  into a permanently lost one).
- Never suppress a **failure** notification for any reason (their 95a3620).

### - [ ] 4c. Batch simultaneous completions

Five jobs finishing together currently cost five model turns, each carrying one line. Debounce
2 seconds, hard cap 10 seconds, one message. About 25 lines. Fixes their issue #157.

### - [?] 4d. Undelivered-failure recovery

If a notification cannot be delivered, attach it to the next job tool result of any kind. About
30 lines. Without it, "launch 5 jobs, get 3 answers, agent reports done" is possible.

Ask: why is it possible for the notification to not be delivered?

### - [x] 4e. The four-place "do not poll" instruction  *(not optional if you want 4b to work)*

The single largest lesson from pi-background-tasks. Their fix for "the agent sleeps and polls
instead of ending its turn" was **one line of code and forty lines of prompt text**, and the
instruction had to appear in all four of:
tool description, prompt guidelines, the launch receipt, and the notification body.
One place was not enough.

### - [ ] 4f. Skip the notification if the model already read the result file

Saves a turn. Only for **successful** jobs. About 20 lines.

---

## 5. Completion nudge (your point 3)

### - [x] 5a. Nudge on `agent_settled`  *(recommended)*

When pi settles, look at the last assistant message. If it promised a next action and no job is
running, send a short message that tells the agent to continue.

Verified facts that shape this:
- `agent_settled` is the right hook. `agent_end` fires again on every retry.
- **It is re-entrant.** A nudge sent from `agent_settled` starts a nested run, which fires
  `agent_settled` again, which fires your handler again. pi has no loop guard. We need our own
  flag plus a per-user-turn counter, reset on `before_agent_start`.
- Never nudge after a network error, a provider error, or a user interrupt. `pi-goal-x`, which
  is already installed here, learned all three the hard way; I read its handler.

### - [x] 5b. Classifier: cheap model

`ctx.modelRegistry.complete(model, { messages }, { maxTokens: 8, cacheRetention: "none" })`.
It resolves credentials for us. You already have `google/gemini-3.8-flash` enabled.
Pass a fresh `sessionId` so the side call does not spoil the main conversation's prompt cache.

### - [ ] 5c. Classifier: no model, pattern only

Cheaper and fully predictable, but it will miss cases. Can be the fallback when the cheap model
is unreachable.

### - [x] 5d. Nudge budget

At most N nudges per user turn (suggest 3). Then stop and stay silent. Without this a model
that keeps promising things loops forever.

### - [ ] 5e. Keep the nudge out of the transcript forever

Store a tiny marker in the session and inject the real text once in `before_agent_start`.
Otherwise every nudge stays in context for the rest of the session.
Caveat found in pi's own tracker (#5581): `sendMessage` with `triggerTurn: true` skips
`before_agent_start`, so this needs the `sendUserMessage` path instead.

---

## 6. Activity signal for RMNG (your point 4)

### - [x] 6a. Write one state file per live pi process  *(recommended)*

`~/.pi/agent/state/<pid>.json`:

```json
{ "pid": 4711, "procStart": "8231447", "sessionId": "...", "cwd": "/home/rmng/project",
  "status": "working" | "waiting" | "idle", "waitingFor": "question", "updatedAt": 1789206200 }
```

Written on `agent_start`, `agent_settled`, `ui_prompt_start`, `ui_prompt_end`,
`session_shutdown`, and on every job start and finish.

- `working` — a turn is running, **or** a job with a timeout is still running.
- `waiting` — a question is on screen and a person must answer.
- `idle` — nothing will move without a person.

This is the same shape Claude Code already publishes, so RMNG's reader already exists.

### - [ ] 6b. RMNG server change: add a `Working` verdict

Today `crates/control-server/src/stuck.rs` cannot express "certainly working" — only a language
model can produce that answer. Six small changes let it read our file instead:
add `Verdict::Working`, a 10-line reader, one match arm in `session_state`, one in
`clone_state`, one early return in `read_clone`, one arm in `resolve_fleet`.

### - [ ] 6c. Delete the pi guesswork from RMNG

About 550 lines become dead: the pi transcript parser, the `.pi/tasks` walker, the wake-flag
heuristics, and the rule that forces a model call whenever a pi background task is running.
**Language-model calls for pi clones drop to zero.** Nothing changes for Claude Code, Cursor or
Codex.

### - [ ] 6d. Stale-file safety

A pi killed with SIGKILL leaves a `working` file behind. RMNG already solves this for Claude
Code: it compares the recorded process start time against field 22 of `/proc/<pid>/stat` inside
the container. A dead or recycled pid fails the check and the file is ignored. We get this free
by writing `procStart`. Add a 60-second heartbeat as a second guard.

---

## 7. Small things

### - [ ] 7a. `bash -lc`, never `$SHELL`
pi-background-tasks open issue #11: the user's shell was Nushell, the model always writes bash,
every command failed once.

### - [x] 7b. Output to a file, capped by truncation not by killing the job
pi-background-tasks kills a job that exceeds its output cap. That is a surprising default.

### - [ ] 7c. Idle watchdog on agent jobs
A child that finishes its work but never exits holds its output open, so waiting on exit never
returns. billion-context hit this (their #89). Two timers: no output for N minutes, and the hard
cap from 2b. Warning: once a watchdog can end a job, the exit code can be null, and **every**
place that decides success must read the job status, never the raw code (their #244).

### - [x] 7d. One status line in the footer
Count of running jobs. Skip the full-screen fleet view — that is 53 issues in pi-subagents and
596 lines in billion-context, for zero correctness.

### - [ ] 7e. Configurable keyboard shortcut, or none
pi-background-tasks hardcoded `shift+down` and silently broke another extension's binding
(their #16). You have 13 extensions installed.

### - [ ] 7f. No optional feature may throw during startup
Two of pi-background-tasks' four open bugs are the same shape: a side feature reads a file at
startup, throws, and takes the whole extension down (#13, #14).

---

## 8. Explicitly not built

Each line is a subsystem in one of the three projects, with the issue count it produced there.

| Not building | Why | Their cost |
|---|---|---|
| Agent presets and roles | You asked for one generic type | 7,461 lines |
| Tool allowlists for children | The child's own registry is the truth | **45 issues** |
| Workflow scripts, DAGs, fan-out | The model can call the tool twice | 7,000 lines, **102 issues** |
| Git worktree isolation | An RMNG sandbox is stronger | 2,575 lines, **42 issues** |
| Acceptance gates that judge the child's work | Refused correct work over words in the prompt | 2,576 lines, **38 issues** |
| Watchdog that reviews the main agent | Not a subagent feature | 4,749 lines |
| Missions, schedules, cron | `pi-schedule-prompt` already does this | 3,000 lines |
| Jobs that outlive the pi process | Needs a liveness consensus protocol | **39 issues** |
| Blocking child-to-parent ask channel | RPC gives it free | 1,813 lines, one P0 deadlock |
| Persistent model-failure cache | One timeout banned a model for 24h everywhere | **33 issues** |
| Windows support | Linux only | ~430 lines plus a state machine |
| Token and cost accounting | Log it, do not model it | ~200 lines, double-count bugs |
| A public API for other extensions | Internal tool | 1,459 lines |
| Fusion, multi-model voting, context compression | Separate concerns | 14,509 lines |

**Estimated size of what is left: 1,500 to 2,500 lines.**

Note: lets include cron in the extension, with this rule: a cron job is skipped if the agent is not settled yet, when the agent is settled, if it missed one or more of the same cron job, it only gets the latest one once.

---

## 9. Decisions only you can make

**9.1 — RMNG server version. This one blocks section 3e.**

The control-server you are running is 83 commits behind this checkout, and the difference
removes the feature the existing fork depends on.

| | Revision | `clone create --seed` | `--parent` nesting | Replacement |
|---|---|---|---|---|
| Running now | `592ad7e` | yes | yes | — |
| This checkout (HEAD) | `34dec94` | **removed** | **removed** | `rmng clone fork` |

`rmng clone fork` uses a ZFS snapshot, so it is faster than copying directories and does not
care how large the home is. But it copies the **whole** home including `~/.pi`, so the child
needs its own pi state cleaned after boot instead of excluded before.

`GET /api/server/version` says an upgrade is available and pending. Pick one:

- [ ] Build against `fork` (the future). Upgrade the server first.
- [ ] Build against `--seed` (today). Hold the server at `592ad7e`.
- [ ] Support both.

I'm still working on RMNG, because the remote ssh start command is flexible, so this extension does not depend on RMNG, you can easily test remote subagent locally (just ssh localhost)

**9.2 — Do we remove the extensions this replaces?**

You currently have `pi-background-tasks` and `billion-context-pi` installed. Both register
overlapping tools, and pi-background-tasks owns the `shift+down` shortcut.

- [ ] Remove `pi-background-tasks` when this ships
- [ ] Remove `billion-context-pi`'s delegate tools but keep its context compression
- [ ] Keep everything and live with the overlap

this shouldn't be a problem, when you are developing the extension, only enable this one extension.

**9.3 — How much of section 6 do you want me to do?**

- [x] Extension side only (6a). You change RMNG yourself later.
- [ ] Extension and RMNG server (6a–6d) in one go.

**9.4 — Nudge classifier**

- [x] Cheap model (5b) Note: make it configurable.
- [ ] Patterns only (5c)
- [ ] Model, falling back to patterns

---

## 10. Answering your two questions directly

**"Does reduced scope avoid whole classes of bugs?"**

Yes, and the numbers are large. Four scope decisions remove about 200 of pi-subagents' 850
issues by construction, not by fixing them:

1. *No tool allowlist for children* removes 45 issues. Their bug is that the parent guesses what
   tools the child process will have, keyed on tool names. Any extension in the parent that
   wraps or renames a built-in tool breaks it. Their newest open issue (#2189) is the case where
   no fix is possible, because the host renamed the tools.
2. *Jobs die with pi* removes 39 issues. No pid liveness, no heartbeat files, no "process
   terminal proof", no capacity reconciliation, no garbage collection of old runs.
3. *One code path for local and remote, one for foreground and background* removes the class
   where every fix has to land twice. pi-subagents has two complete agent loops (2,359 and
   5,391 lines) and their own issue #1936 says the same bug exists in both.
4. *One status value with one writer* removes most of their 58 state-machine issues. They have
   five different status enums in one file (`complete` in one, `completed` in another) and
   eleven separate functions that answer "is this finished?" and disagree.

**"What can a clean-room rewrite do that they could not?"**

1. Use `agent_settled`. It did not exist when they started. It is the exact signal you need for
   features 3 and 4, and pi now owns all the difficulty of computing it.
2. Use RPC as the only transport. It makes local and remote the same code, and it hands us the
   blocked-on-a-human signal that pi-subagents built 1,813 lines to get.
3. Use RMNG for isolation instead of git worktrees. Stronger isolation, and 2,575 lines and 42
   issues of worktree management stop existing.
4. Use `rmng clone fork`. Copy-on-write snapshots make a private sandbox per subagent cheap
   enough to be the default rather than an option.
5. Make the timeout carry meaning. Nobody else did this. It turns an open-ended question that
   currently needs a language model — "will this finish on its own?" — into something the agent
   already declared when it started the job.
