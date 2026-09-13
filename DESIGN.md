# pi-jobs — design

One pi extension: subagents, background commands, a completion nudge, and an activity signal
for an external supervisor. Linux, single user.

---

## Constitution

**This section outranks everything below it.** The rest of this document is a snapshot of
reasoning, not a contract. If a decision below contradicts a principle here, the decision
is wrong: change it, and record the change in §0. Never implement something you believe is
wrong merely because it is written down. A design document that is followed against its
own principles is how the thing we are replacing got to 9,950 lines.

**C1. This is a personal tool.** One user, one fleet, no public release. No backwards
compatibility, no migration path, no deprecation cycle. Breaking changes are free. Delete
rather than deprecate.

**C2. SOTA long-context models only.** Assume the model follows instructions, writes good
summaries, emits valid arguments, and can read a menu. Do not build guards for models that
cannot. Roughly half the original's bug history is damage control for small and quantised
models; none of it belongs here.

**C3. Do not overengineer.** The fewest moving parts that work. No abstraction with one
implementation. No configuration key without a reason to turn it. No layer added "in
case". When in doubt, leave it out — adding later is cheap, removing later is not.

**C4. Prefer deleting to adding.** The original failed by accretion: every incident added
a guard, and no guard was ever removed. When a new failure appears, the first question is
which existing mechanism should go, not which new one to add.

**C5. The host is the source of truth.** If Pi already knows it — token usage, entry ids,
skill paths, the context window, that an overflow happened — read it. Never re-derive,
re-estimate, or re-detect. Most of the original's complexity is a second, worse copy of
something Pi already had.

**C6. Never mutate history.** Message bytes, once written, are final. Every transformation
happens in the view. The session log is the record, so anything hidden stays recoverable.

**C7. Fail loudly.** A visible stop beats a quiet corruption. Log the reason with enough
detail to diagnose it days later. Never swallow an error to keep going.

**C8. When the model gets something wrong, fix the information, not the model.** The first
question is what we failed to tell it — not what guard to add.

**C9. Measure before tuning.** Numbers come from the log and from real sessions, not from
intuition. If it cannot be measured, it does not get a knob.

**C10. No fallback without evidence.** Do not write a second code path for a case you have
not seen happen. No `try`/`catch` that quietly substitutes a different answer, no "if the
host does not do X, do Y", no self-healing, no learned values, no compatibility shim, no
tolerance constant pulled out of the air. An unproven fallback is untested code that will
one day run instead of the correct path, and you will not know it did. If you think a case
is possible, prove it occurs before handling it. If you cannot prove it, let it fail
loudly (C7) and build the handling when the log shows you the real shape of it.
---

## §1. The model

A **job** is work the parent started that finishes later.

```
job
├── id       uuidv7
├── timeout  minutes; required for an agent, optional for a command
├── status   running | done | failed
├── reason   set when failed: an exit code, "timeout", or "stopped"
└── dir      ~/.pi/jobs/<id>/
```

For a command, `timeout` present means **awaited work**: it notifies when it ends, and the
session counts as active while it runs. `timeout` absent means a **service** — a dev server, a
watcher, a tail. A service never notifies and never makes the session active.

An agent always finishes, so an agent job always has a timeout and is always awaited.

One predicate, `isAwaited(job)` — `timeout` is present — drives the notification rule (§6) and
the activity file (§8). Whether a command will finish on its own is stated by the agent that
started it, not inferred later.

---

## §2. Tool surface

| Tool | Parameters | Returns |
|---|---|---|
| `run_command` | `command`, `cwd?`, `timeoutMinutes?` | id, output path, one line on delivery |
| `run_agent` | `task`, `timeoutMinutes`, `cwd?`, `isolation?`, `resumeFrom?` | id, output path, sandbox id when isolated |
| `job_list` | — | one row per job this session: id, what ran, status and reason, elapsed, output path, sandbox id when isolated |
| `job_stop` | `id` | final status |

Four tools, four tight schemas. The two start tools call the same internal `start()`; what is
shared is the runtime, not the surface.

`resumeFrom` is refused alongside `isolation` or `cwd` — a continuation inherits the original job's
host and directory — and refused on a job that is still running, or whose session another running
job is already continuing. Two children appending to one session file is history corruption, and
the alternative to each throw is a silently inert parameter.

`job_list` reads the in-memory registry. Jobs die with pi (§5.1), so it lists this session's jobs
and nothing else; a directory left by an earlier session holds output, not live state.

**It takes no label parameter.** A row is identified by what was actually run — the command, or
the first line of the task, truncated. A name the model has to invent can drift from what ran;
this cannot.

The sandbox id in a row matters because there is no `job_release`: it is what the destroy command
takes, and this is where the model finds it again after a compaction.

There is still no `job_logs`. Output is one file and pi has `read`. Live status across several
jobs is not one file, which is the difference.

There is no `job_release`. Destroying a sandbox is one shell command, named in
`isolated.instructions` (§3.5), and the model has `bash`.

---

## §3. Subagents

### §3.1 Transport

`pi --mode json`. The child streams JSON-line events on stdout and exits when the run is over.

```js
local     spawn(process.execPath, [piCli, "--mode","json", `--jobs-depth=${n-1}`, ...], { signal })
isolated  spawn("ssh", [...sshArgs, `cd <cwd> && pi --mode json --jobs-depth=${n-1} ...`], { signal })

child.stdin.end(task);                    // the task is the prompt, on stdin
child.stdout.pipe(createWriteStream(output));   // raw, unparsed
```

**The task goes on stdin, never in argv,** so no shell ever sees it. The working directory does go
on the remote command line, so it is single-quoted. In json mode pi reads stdin once at startup as the
prompt, and `ssh` forwards stdin to the remote command, so there is no quoting anywhere — not
through a local shell, not through a remote one. Verified: identical result locally and over
`ssh -T`, exit 0, clean stderr.

**Stdout is piped, not parsed.** Nothing watches the stream while it runs, so there is no reader
to write. The final text is extracted once, at finalise, by reading the tail of `output` and scanning
backwards for the first `message_end` record with an assistant role. A run that succeeded and
produced none is a loud failure; a run that failed may legitimately have none.

`sshArgs` is the `ssh` string from `isolated.create` split on whitespace, and the remote command
is one argument after it. No `-T` is passed: it is the default when a command is given.

`piCli` is `process.argv[1]` and `process.execPath` is the node binary running us — on this
machine `/home/rmng/.nvm/versions/node/v26.4.0/bin/pi` and `.../bin/node`. There is no search
path and no fallback; a wrong value fails the spawn loudly.

**A child cannot block on a question.** In json mode `ctx.hasUI` is false, so an extension's
dialog calls return at once instead of waiting for an answer.

### §3.2 Child session and resume

```
--session-dir ~/.pi/jobs/<id>/ --session-id <id>
```

This is the resume point, not a forensic extra. A second `pi --mode json` process started with
the same two flags and a new task on stdin continues the same conversation — verified: the second
run recalled a codeword the first was told, and the session file grew from 1,434 to 4,124 bytes.

`run_agent({ resumeFrom: <jobId> })` reuses that job's session directory, session id, working
directory and — for an isolated job — its ssh command, so the continuation lands on the same host
in the same place. Its own `output`, `stderr` and `result` go to the new job's directory. An
isolated job can be resumed while its sandbox exists, which it does until the destroy command is
run (§3.5).

The child is not given `--no-extensions`. It loads what any pi loads, including this extension.

### §3.3 What the parent does not decide for the child

No `--tools`, no allowlist, no agent file, no role, no system-prompt injection. The parent writes
the whole task. The child's own registry is the authority on what it can do.

### §3.4 Files

```
<agentDir>/jobs/<id>/output            the raw run record       (JSON lines for an agent, bytes for a command)
<agentDir>/jobs/<id>/stderr            the child's stderr       (agent jobs only)
<agentDir>/jobs/<id>/result            the final assistant text (agent jobs only)
<agentDir>/jobs/<id>/<ts>_<id>.jsonl   the child's session, written by pi (agent jobs only)
```

The notification carries the path, never the content (§6) — including for a failure. What the
model reads, and how much of it, is the model's choice.

The child's stderr is kept out of `output`: one stderr write landing inside a JSON record would
split the line and silently cost the final text. A job is never killed for producing output, and
reads are capped by pi's own `read` tool, not by this extension.

### §3.5 Isolated sandboxes

The extension runs `isolated.create` from the config (§9) and reads its stdout as one JSON line:

```json
{"id":"pega-sub-31","ssh":"ssh -o StrictHostKeyChecking=accept-new rmng@10.99.0.31","cwd":"/home/rmng/work"}
```

The command runs through `pi.exec`, so it gets pi's environment and the tool's abort signal. Its
reply is shape-checked before use: by the time it is parsed the sandbox already exists, so a
malformed line would otherwise lose the id that is its only destroy handle.

`isolated.instructions` is appended to the `run_agent` description, so the parent knows how an
isolated child behaves before it chooses one — including the destroy command and that it must run
it when finished.

A sandbox is never destroyed by this extension. It outlives the job so the parent can read what
the child built.

### §3.6 Nesting and depth

A child loads this extension, so a child can start jobs of its own. How far that goes is bounded
by one number that travels down the tree and can only decrease.

```
--jobs-depth=<remaining>
```

- A session started **without** the flag is a root. Its remaining depth is `maxDepth` from
  config, which is **1** when the key is absent.
- Starting an agent job passes `--jobs-depth=<remaining - 1>` to the child.
- A session whose remaining depth is `0` does not register `run_agent`.

Registered with `pi.registerFlag("jobs-depth", { type: "string" })`, always written in the
`--name=value` form. Flag values are `undefined` during the extension factory and readable at
`session_start`, so tools are registered in `session_start`.

**What this bounds is the height of the tree, not its size.** `maxDepth: 3` with three children
at each level is up to 39 sessions; nothing counts them, and §12 records that. It exists so a
chain terminates, not so a fleet is affordable.

**Below the root the number is never re-read from config.** An isolated child runs on another host
with its own config file, and a local child may run in another project with its own project
config; reading `maxDepth` there would let a child grant itself more depth than its parent
allowed. The resolved limit travels, not the policy.

**The flag also answers "am I a child?"**: in a child session the remaining depth comes from the
flag rather than config, and the nudge is off, because the parent already sees the child finish.

---

## §4. Command jobs

A command job runs through pi's own shell backend.

```js
await createLocalBashOperations().exec(command, cwd, {
  onData: (chunk) => appendFileSync(outputFd, chunk),
  signal,
});
```

`createLocalBashOperations` is exported from the package root, so the shell, its arguments, its
environment and process-tree termination are all the same code the built-in `bash` tool uses.
`getShellConfig()`, which `exec` calls, returns `{ shell: "/bin/bash", args: ["-c"] }` here.

**No options, and no `env`.** `exec` defaults `env` to pi's own `getShellEnv()`, which prepends the
managed bin directory — where pi's bundled `fd` and `rg` live. Passing an environment is therefore
what *breaks* a command that works in `bash`; omitting it inherits pi's exactly, with nothing to
keep in step. Verified: `fd --version` succeeds in a job. No `PI_*` variables are set, because
setting them would mean passing `env`.

**The `shellPath` and `shellCommandPrefix` settings are not read.** Reading them means building a
second `SettingsManager`, whose `projectTrusted` option defaults to `true` — so it would execute
`.pi/settings.json` from an untrusted project that pi's own `bash` tool refuses. Neither setting is
in use here, so the question is deleted rather than answered. If one is ever set, jobs will run
plain `bash` while the tool uses the configured shell; that is when to add it.

Stdout and stderr arrive merged, as the `bash` tool merges them, and are appended to `output`.

pi's shell backend spawns detached on POSIX and tracks the pid itself, killing what it started on
exit. The abort signal is what ends a job (§5.2).
---

## §5. Lifecycle

### §5.1 Jobs die when pi dies

One idempotent `session_shutdown` handler aborts every job and **waits for each to settle**, so
every output file is closed before the session goes away. It runs for quit, `/reload`, `/new`,
`/resume` and `/fork`. The shutting-down flag **is** reset when the next session starts: pi caches
the extension module process-wide and clears it only on `/reload`, so after `/new`, `/resume` or
`/fork` it is the same module. Without the reset no job would ever notify again for the life of the
process. It is safe because shutdown has already awaited every job.

This is not only tidiness: an extension that leaves a live child or an unreferenced handle behind
hangs `pi -p` forever, after `session_shutdown` has already fired.

### §5.2 Stopping and timeout are one mechanism

Every job carries one `AbortSignal`:

```js
const stop = new AbortController();
const signal = timeoutMinutes
  ? AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMinutes * 60_000)])
  : stop.signal;
```

`job_stop` aborts `stop` and waits for the job to settle, so it reports the final status rather
than `running`. A timeout aborts through `AbortSignal.timeout`, which is Node's — this extension
runs no timers. Which one fired is read from `stop.signal.aborted`, so `reason` is
`"stopped"` or `"timeout"` with no extra state.

A command job passes the signal to `exec`, which kills the process tree. An agent job passes it to
`spawn`, which kills the child; for an isolated job that closes the `ssh` connection and the
remote pi exits on stdin EOF.

An awaited job always carries a timeout, and a service that runs forever is doing its job, so
there is no idle watchdog.

### §5.3 One finalise

One function sets the job's `status` and `reason`, sends the notification, and refreshes the
activity file. There is no second place that decides whether a job succeeded.

---

## §6. Notification

```js
pi.sendMessage(
  { customType: "pi-jobs", content, display: true },
  { deliverAs: "followUp", triggerTurn: true },
)
```

**An awaited job notifies when it ends. A service never notifies.** That is the whole rule, and it
is `isAwaited(job)` from §1. No exit code is inspected.

The message carries the status, the elapsed time, what was run — the command, or the first line of
the task — and the path to read.

**There is no delivery-failure handling, because there is no delivery failure to catch.**
`pi.sendMessage` returns `void` and its implementation is
`this.sendCustomMessage(...).catch(err => runner.emitError(...))` — every asynchronous failure is
caught by pi and reported as an `extension_error`, which pi already surfaces. Nothing reaches our
call site, so the call returning tells us nothing and there is nothing to branch on. pi reports
it; we do not report it again (C5).

**One lifecycle rule, not a guard.** `finalise` does not notify while the session is shutting
down. Aborting a job on shutdown (§5.1) makes it finish, and a message sent into a session being
torn down has nowhere to land — and the synchronous wrapper does throw on a runner that has been
invalidated by session replacement. One boolean, on a path we control both ends of.

**Telling the model not to poll** happens in one place: the tool description, where the model
decides whether to wait. It states that the call returns at once and that the model will be woken.

---

## §7. The nudge

### §7.1 Trigger and checks

`agent_settled` — it fires once, after all retries, auto-compaction and queued messages, and means
pi will not continue on its own. `agent_end` fires again on every retry and is the wrong hook.

```
1. five nudges already this turn     -> skip
2. the run ended in error or abort   -> skip
3. an awaited job is running         -> skip; the job will wake it
4. classify the last assistant text  -> nudge or skip
```

Check 2 reads `stopReason` on the last assistant message. A user interrupt, a provider error after
pi exhausted its retries, and an aborted assistant message are all states where continuing is
wrong.

### §7.2 At most five nudges per user turn

Calling `sendUserMessage` from inside `agent_settled` starts a nested run, which settles, which
calls the handler again. pi has no loop guard, so the chain has to terminate on a count.

`nudgesThisTurn` is incremented before sending and reset on the `input` event when
`event.source !== "extension"`. pi reports the source directly — `"interactive"` for a typed
prompt, `"rpc"` for a client, `"extension"` for `sendUserMessage` — so anything from a person or a
client resets the count and our own nudge does not. Testing against `"interactive"` alone would
never reset under RPC, making the limit per session rather than per turn.

The cap is `5`, a constant in the source. One was too few: an agent that is nudged, does the thing,
and then stops mid-promise again is the case the feature exists for.

### §7.3 The classifier

```js
const rt = await ModelRuntime.create();          // 54 ms, once per session, lazily
const reply = await rt.completeSimple(model, { systemPrompt, messages }, {
  reasoning: nudgeThinking, cacheRetention: "none", maxTokens: 2048,
});
```

`maxTokens` caps reasoning **and** output together, so it must survive the model's thinking. Total
tokens measured on this prompt:

| model | level | reasoning | total |
|---|---|---|---|
| `openai-codex/gpt-5.6-luna` | `minimal` | 81 | 98 |
| `google/gemini-3.8-flash` | `high` | 241 | 251 |
| `openrouter/meta/muse-spark-1.3-contributor` | `low` | 530 | 569 |
| `openrouter/meta/muse-spark-1.3-contributor` | `high` | 696 | 756 |

At 64 the answer came back truncated to `"Read the"`. At 512 muse-spark returned an empty string,
having spent 506 tokens reasoning. 2048 clears the widest measurement with room to spare.

`completeSimple` is the provider-neutral call: `reasoning` takes a pi thinking level and pi maps it
to whatever the provider wants. It resolves credentials itself, including OAuth-backed
subscription providers, and the call is bounded by an `AbortSignal.timeout` so a stalled
connection cannot park `agent_settled` forever. `ModelRuntime` is exported from the package root.
The `ModelRegistry` facade on `ctx.modelRegistry` does have `complete()`, but its options are
API-specific; the provider-neutral `reasoning` exists only on `completeSimple`.

The only message is the last assistant text. The reply is either `NO` or the unfinished action in
a few words, and the nudge quotes that action back rather than saying "continue".

**`nudgeThinking` is not a quality dial.** Measured on `google/gemini-3.8-flash`: omitting
`reasoning` returns an empty assistant message in 288 ms, three times out of three; `high` returns
a correct answer. Which levels a model honours varies, so the level must be stated.

### §7.4 An empty reply is a visible failure

`completeSimple` **resolves on provider errors instead of rejecting** — a 429, a 500 or an expired
token arrives as a message with `stopReason: "error"` and an `errorMessage`. Those are raised, not
read as an empty reply, so a transient failure cannot switch the nudge off for the session.

Past that, a model can still return no text at all. Measured: `google/gemini-3.8-flash`
with `reasoning` omitted returns an empty assistant message in 288 ms, three times out of three —
too fast to have reached the network, so the level itself was refused. Budget starvation is the
other cause and §7.3's 2048 is sized to avoid it.

An empty classifier reply **throws**, naming the model, the level and the budget. pi reports an
extension error itself, so there is no session latch, no notification call, and no third return
value distinguishing "no text" from "nothing to nudge about". It recurs at every turn end until the
configuration is fixed, which is the loud stop C7 asks for. A
feature that silently switches itself off and stays off is the quiet degradation C7 exists to
prevent.

`nudgeModel` and `nudgeThinking` are both required or both absent; one without the other is a
startup error.

The nudge text is an ordinary user message and stays in the transcript.

---

## §8. The activity file

```
~/.pi/agent/state/<pid>.json
{ "pid": 4711, "procStart": "8231447", "sessionId": "01a0...", "cwd": "/home/rmng/project",
  "status": "active" }
```

One predicate, refreshed from one function that four call sites hit — `session_start`,
`agent_start`, `agent_settled`, and every job start and finish:

```
active = !ctx.isIdle() || awaitedJobsRunning > 0
```

`ctx.isIdle()` is pi's own answer, measured across the lifecycle as `true` at `session_start`,
`false` in `agent_start` and `true` in `agent_settled` — so there is no turn flag of ours to keep
in step, and nothing our code can leave stuck. The file is written to a temporary name and renamed,
so a reader cannot catch it half-written. It is deleted on `session_shutdown`.

`procStart` is field 22 of `/proc/self/stat`, read once at startup. A `kill -9` leaves the file
behind claiming `active`, so a reader compares `procStart` against the live `/proc/<pid>/stat`;
a dead or recycled pid fails the check. There is no heartbeat and no timestamp — liveness is
`procStart`, last-change is the file's mtime.

This is the extension side. The reader is a separate change.

---

## §9. Config

### §9.1 Two files

| File | Scope |
|---|---|
| `~/.pi/agent/pi-jobs.json` | the user, everywhere |
| `<cwd>/.pi/pi-jobs.json` | this project only |

Nothing is configured through the environment. The one value that travels from a parent to a
child — remaining depth — is a CLI flag (§3.6): visible in `ps`, part of the command already being
built, and needing no forwarding rules to survive an `ssh` hop.

### §9.2 The schema

```jsonc
{
  // How deep a chain of subagents may go. 1 = this session starts subagents, and they start
  // none. Absent means 1. It bounds the height of the tree, not the number of sessions (§12).
  "maxDepth": 1,

  // Classifier for the nudge. "<provider>/<modelId>", split on the first "/".
  // Absent means the nudge is off. Required together with nudgeThinking.
  "nudgeModel": "google/gemini-3.8-flash",
  "nudgeThinking": "high",

  // Provider for isolated subagents. Absent means isolation:"isolated" is not offered.
  "isolated": {
    "create":       "rmng-sandbox-create",
    "instructions": "Work happens in /home/rmng/work. Read a file there with: <ssh> cat <path>. The sandbox stays up after the job ends; run `rmng-sandbox-destroy <sandbox id>` when you are done with it."
  }
}
```

The shell is not here, and pi's own `shellPath` and `shellCommandPrefix` are not read either (§4). Command jobs
read them from pi (§4).

### §9.3 Merge

Shallow, per top-level key. `{ ...user, ...project }`.

A project that sets `isolated` sets both of its keys. A half-replaced provider — one project's
`create` with the user's `instructions`, naming a destroy command for another fleet — looks valid
and leaks sandboxes; shallow merging makes that shape unreachable. The other three keys are
scalars, so shallow and deep agree.

### §9.4 Reading, failing, reloading

Read once, at `session_start`. `/reload` re-runs `session_start`, so `/reload` picks up an edit.
There is no file watcher.

The merged object is validated against one typebox schema, so an unknown key at any depth, a wrong
type and an illegal `nudgeThinking` value are all loud failures. A malformed or unreadable file is
one too: no default, no partial load. A half-validated config is worse than none, because the loud
path advertises coverage the code does not have. **No file at all is not a failure** — it means no nudge, no
isolated jobs, and no nesting; local command jobs and local subagents work with no configuration.

The project file is read without a trust check (§12).

---

## §10. Layout

| File | Purpose |
|---|---|
| `index.ts` | config, flag, tool registration and descriptions, session events, activity file, nudge |
| `jobs.ts` | registry, `start`, `stop`, `finalise` → status + notify + activity, output files |
| `command-job.ts` | pi's shell backend, environment, output |
| `agent-job.ts` | argv for local and ssh, sandbox create, stdin, stdout pipe, result extraction |

Four files. Tool descriptions sit next to the registration they describe, and the notification is
sent inside `finalise`, so §5.3's "one place" is structural rather than a convention someone can
edit away.

---

## §11. Out of scope

Only the ones whose reason is not obvious from the design.

| Not built | Because |
|---|---|
| Steering a running subagent | it is what `--mode json` costs, and stop is enough |
| Answering a child's question | in json mode a child cannot block on one |
| Jobs outliving the pi process | needs a process-liveness consensus protocol |
| An idle watchdog | an awaited job already carries a timeout |
| Notification batching | add it when the log shows the cost |
| Undelivered-failure recovery | pi catches delivery failures itself and reports them as `extension_error` |
| A fan-out or breadth cap | see §12 |
| Parsing the child's event stream while it runs | nothing watches it; the tail is read once at the end |
| An in-process spawn, shell resolution, or signal escalation of our own | pi exports all three |
| Reading pi's `shellPath` / `shellCommandPrefix` | needs a second SettingsManager that trusts untrusted projects by default. §4 |
| `PI_*` variables in a command job | passing any environment loses pi's `PATH`. §4 |
| A session latch that disables the nudge | pi reports extension errors; a throw is louder and holds no state. §7.4 |
| A child process per nudge classification | 510 ms of startup per turn end |
| The session's own model as the classifier | it is pinned at max thinking; a cheap model answers in 1.8 s |

---

## §12. Limits

Written down so that when one bites, the real shape is handled rather than the imagined one.

1. **A sandbox is never reclaimed by this extension.** If the model forgets the destroy command,
   sandboxes accumulate.
2. **A service that crashes is silent.** Nothing notifies; it is discovered on the next read of
   `output` or when something that needed it fails.
3. **An agent job whose child hangs without output runs to its timeout.** No idle detection.
4. **A subagent cannot ask anything.** An extension inside it that would open a dialog gets an
   immediate empty answer and proceeds without that input.
5. **Depth bounds the height of the tree, not its size.** `maxDepth: 3` with three children at each
   level is up to 39 sessions, and if they are isolated, up to 39 sandboxes that nobody reclaims.
   Nothing counts them.
6. **A terminal opened inside a sandbox starts a root.** The flag is not there, so that pi reads
   that host's `maxDepth` and can delegate again. The limit is per-chain, not per-fleet.
7. **A command that backgrounds its own children survives a stop.** After aborting
   `bash -c 'sleep 99 & sleep 99'`, one `sleep 99` is still running: pi's process-tree kill does not
   reach a child orphaned by `&`.
8. **A project config is read without a trust check.** It can name the command that creates a
   sandbox. This is the one place where opening someone else's repository would run their command.
9. **The nudge text stays in the transcript.**
10. **A wedged child blocks shutdown.** `job_stop` and `session_shutdown` both wait for a job to
    settle. If a child ignores `SIGTERM`, or an `ssh` hangs on a dead network, that wait has no
    bound. A timeout here would be a constant with nothing behind it, so it stays unhandled until
    the log shows the real shape.
10. **An isolated sandbox must have this extension available to the child.** The child is started
    with `--jobs-depth`, a flag this extension registers, so a sandbox without it fails at once
    with `Error: Unknown option: --jobs-depth`. That is loud, and it is the sandbox image's job to
    satisfy — installed for the user, or present as `.pi/extensions/` in the sandbox cwd.

---

## §13. Build order

Each step is usable on its own and is tested before the next begins.

1. `index.ts` config and registration, `jobs.ts`, `command-job.ts`; `run_command`, `job_list` and
   `job_stop`; the `output` file.
2. The notification and the delivery sentence. Command jobs now wake the agent.
3. `agent-job.ts`, local only: spawn, stdin, pipe, result extraction, `run_agent`, `resumeFrom`.
4. Isolated jobs: `isolated.create`, the instructions string, depth. Tested against `ssh localhost`.
5. The activity file.
6. The nudge.
