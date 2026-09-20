# pi-background — design

One pi extension: subagents, background commands, a completion nudge, and an activity signal
for an external supervisor. Linux, single user. Published as is: no support, and no promise
that anything here stays the same (C1).

---

## Constitution

**This section outranks everything below it.** The rest of this document is a snapshot of
reasoning, not a contract. If a decision below contradicts a principle here, the decision
is wrong: change the decision and this document with it. Never implement something you believe is
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
├── id        uuidv7
├── title     the model's own name for it, required
├── expected  seconds you expect it to take, or null for a service (an agent may not be null)
├── status    running | done | failed | stopped
├── foreground  true while the model is still waiting for this command's result (§4.1)
├── exitCode  a command's exit status, or null when it was killed
├── reason    set when it says more than the status and the code do
└── dir       ~/.pi/agent/jobs/<id>/
```

`expectedSeconds` is **required on every call**. A number means **awaited work**. `null` means a
**service** — a dev server, a watcher, a tail — which is not waited on. There is no default, so the
caller states which it is rather than getting one by omission.

An agent always finishes, so `run_agent` and `resume_agent` do not accept `null`.

For a command the estimate also decides **who waits**. Under 180 seconds the command runs in front
of the model: the tool call does not return until it ends, and the result is the end of its output
with the exit code, like any shell tool. At 180 seconds or more, and for every service, the
command starts in the background at once. 180 is the line between "this is a shell command" and
"this is a job", and it is the model's own estimate that puts it on one side or the other.

**Nothing is ever killed by the clock.** `expectedSeconds` is an estimate, not a deadline: when it
elapses the job keeps running and the model is told it overran (§6). Only `job_stop` and
`session_shutdown` end a job early, which is why `status` has no `timeout` value and every job
carries one signal.

A foreground command that passes its estimate is not stopped either. The wait ends, the model is
handed what has been produced so far along with the job id, and the command carries on in the
background. That handoff **is** the overrun report, which is why a foreground job's overrun clock
starts at the handoff rather than at the start (§5.2a).

**Escape ends the wait, not the command.** pi aborts a tool call when the human interrupts. For a
foreground command that means "stop waiting for this": the job moves to the background exactly as
an overrun does, and the model is told which of the two happened. A job still carries one signal
and `job_stop` is still the only thing that ends one early (§5.2).

This is the correction of a real cost. As a deadline, an estimate that came in low killed work that
was going fine, and the model has no good way to estimate in the first place. As a check-in, a low
estimate costs one message. The failure mode moved from lost work to a little noise.

A service is still reported when it ends (§6): a crashed dev server that says nothing is a hole,
not a feature. What `null` decides is §8 and the overrun clock: a service does not make the session
active, does not silence a nudge, and is never reported for running long, because a process that is
supposed to run for hours must not do any of those.

`title` is required rather than derived. It is the only thing the human ever sees of a job (§2.1),
so there has to be one, and a model that knows why it started a job writes a better line than the
first 120 characters of a shell command. The command itself stays in the tool call arguments.

---

## §2. Tool surface

| Tool | Parameters | Returns |
|---|---|---|
| `bash` | `command`, `title`, `expectedSeconds` (number or null), `cwd?` | the end of the output and the exit code, or an id and the output path |
| `run_agent` | `task`, `title`, `expectedSeconds` (number), `cwd?`, `isolation?` when configured | id, and sandbox id when isolated |
| `resume_agent` | `jobId`, `task`, `title`, `expectedSeconds` (number) | id, and sandbox id when the original had one |
| `job_list` | — | the running jobs, grouped by kind: id, title, elapsed, expected, output path for a command, sandbox id when isolated |
| `job_service` | `id` | that the command now has no expected duration |
| `job_stop` | `id` | the job's final state |

Six tools, six tight schemas. The three start tools call the same internal `start()`; what is
shared is the runtime, not the surface.

**`bash` replaces pi's own.** Registering a tool by that name puts it in the registry in place of
the built-in one, so there is nothing to disable and no flag for the human to pass. It is the only
shell the model has, which is the point: a command cannot be started in a way that escapes the
job registry, and the built-in `timeout` parameter — a second clock that killed — is gone with the
tool that carried it. The cost is that every command now writes a job directory (§12).

**Resuming is a tool, not a parameter.** As `run_agent({ resumeFrom })` it had to refuse a `cwd`
and an `isolation` that contradict the job being continued, because a continuation inherits the
original's directory and host. A separate tool with neither parameter deletes both errors instead
of reporting them — the schema says what is possible, so nothing has to be rejected. What remains
on `resume_agent` are the four that a schema cannot express: an unknown id, a command rather than
a subagent, a job still running, and a session another running job is already continuing. Two
children appending to one session file is history corruption.

`job_list` reads the in-memory registry and **lists only what is running**. A finished job already
reported itself (§6), so listing it again repeats what is in context; and jobs die with pi (§5.1),
so a directory left by an earlier session holds output, not live state.

An agent row carries no output path. An agent's `output` is pi's raw JSON event stream, which is of
no use to the model; the path to its answer arrives with the completion message, once the answer
exists.

The sandbox id in a row matters because there is no `job_release`: it is what the destroy command
takes, and this is where the model finds it again after a compaction.

### §2.1 Two readers, never one text

Everything this extension emits is written twice: once for the model, once for you. They are
different texts, not one text shown twice, because the two readers need different things. The
model needs ids and paths to act on. You need to know what is running and what changed.

pi gives this for free. A tool result carries `content` for the model and `details` for the UI,
and only `content` reaches the provider; `renderCall` and `renderResult` draw from `details`, and
`registerMessageRenderer` does the same for a custom message. So the second text costs no tokens.

**A command's output is the one thing both readers get, and the only place the two are cut
differently.** The model is reading the output: it gets the last `DEFAULT_MAX_LINES` lines or
`DEFAULT_MAX_BYTES` bytes, whichever is shorter — Pi's own numbers, imported rather than chosen
(C5), so a change on its side is a change on ours. You are glancing at the output: you get the last
5 lines or 1000 bytes. Pi splits them the same way and for the same reason, showing its model 2000
lines and you 5. Everything around them differs as it always did: the model gets the id and the
path it needs to act, you get one sentence and the exit code. A command that printed nothing shows
you nothing, because the absence is the answer and `(no output)` is a line you would have to read.
An agent's output is never shown, to either of you: it is pi's JSON event stream.

**The path is named only when it is the answer to a question the model now has.** A result holding
the whole output ends at the exit code. A result that lost something says what it lost and where
the rest is, in one line — `This is the last 9.8KB of 23.3KB. The whole output is at …`. A result
for a command that is *still running* always names the path, cut or not, because there is more
coming whatever was shown. Naming a file beside output the model already has in full is a sentence
it pays for every call and can only waste a read on (C8).

That line is part of the body, not a decision any caller makes. `tail` reads `status` off the job
and appends it or does not, which is the same field `index.ts` branches on to choose between
`finished` and `handedOff` — so the two cannot fall out of step, and no call site had to change to
gain the behaviour (C4). The first version of this carried a `{ text, note }` pair out of `tail`
and asked three callers to decide what to do with the second half. It was fourteen lines longer and
had two places to keep in agreement instead of none.

**The model's half is written in sentences, and carries no markdown.** Your half stays terse: it
is read at a glance, not reasoned about.

| Surface | The model | You |
|---|---|---|
| A command that ended in front of it | its output, the exit code, and the path only if it was cut | its last 5 lines, then `Finished in 12s.` / `Exit code: 0` |
| A command that outlived the wait | its output, the id, the path, and not to wait for it | its last 5 lines, then `Still running after 60s, expected 60s.` / `Now in the background.` |
| Starting a background job | prose, the id, the output path | `bash dev server` and `Expected: none` |
| `job_list` | grouped records with ids and paths | the `/jobs` table |
| `job_service` | what changed, and the id back | the tool line alone; nothing on your side changes |
| `job_stop` | final state, elapsed, path | the tool line alone; the footer count is the rest of the answer |
| A completion | the tagged record and the path | one sentence, and the exit code for a command |

Two surfaces have no model side at all. A footer status counts what is live and is cleared when
nothing is; `/jobs` lists them as a table, as a durable entry, each column sized to its widest
cell, durations right-aligned, the heading dimmed. Both are transcribed in
`docs/MODEL-FACING-TEXT.md` §E.

**A command the model is still waiting for is in no listing.** The footer, `/jobs` and `job_list`
all read `backgrounded()`, which is every running job with the foreground flag off, so the rule is
stated once and no listing can be given a different one by accident. A job the model is holding the
call for is not news to either reader: the model cannot ask, because asking would need the call it
is holding, and you are already watching the tool call it came from. Counting it only meant that an
`ls` put a `1 command` in the footer for the length of an `ls` and took it away again. `detach`
clears the flag, so a command joins every listing at the moment it outlives the wait — the moment
it becomes something you did not already know.

**The status key is `pi-background`**, the extension's own name, so `pi-powerline-footer` can lift
it out of its overflow row into a segment of its own with a `customItems` entry naming that key.

No status column: a listed job is running by definition. `appendEntry` writes a `custom` session
entry, which pi keeps out of LLM context by design, so this costs no tokens however often you
look.

The id is here because it is the one thing that lets you line up a row with what the model said
about it. Nothing else on your side carries one.

What is missing from your side is the command and the task themselves. A row says what the model
called a job, not what it ran. That is the trade `title` buys (§1): a good title is a better line
than a truncated command, and a bad one is all you get.

The model-facing half of every string in this table is transcribed verbatim in
`docs/MODEL-FACING-TEXT.md`, alongside yours, so the boundary can be audited without reading the
code.

There is still no `job_logs`. Output is one file and pi has `read`. Live status across several
jobs is not one file, which is the difference.

There is no `job_release`. Destroying a sandbox is one shell command, named in
`isolated.instructions` (§3.5), and `bash` runs it.

---

## §3. Subagents

### §3.1 Transport

`pi --mode json`. The child streams JSON-line events on stdout and exits when the run is over.
It also gets `--provider` and `--model` for the model the parent session is running on, and
`--thinking` for its level, so a subagent works on the model you chose rather than whatever the
child would pick as its startup default. No model in the session means no flags, and the child
falls back to that default as any fresh pi run does.

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
--session-dir ~/.pi/agent/jobs/<id>/ --session-id <id>
```

This is the resume point, not a forensic extra. A second `pi --mode json` process started with
the same two flags and a new task on stdin continues the same conversation — verified: the second
run recalled a codeword the first was told, and the session file grew from 1,434 to 4,124 bytes.

`resume_agent({ jobId })` reuses that job's session directory, session id, working directory and
— for an isolated job — its ssh command, so the continuation lands on the same host in the same
place. It is a new job with a new id: its own `output`, `stderr` and `result` go to the new job's
directory, and its completion names it. An isolated job can be resumed while its sandbox exists,
which it does until the destroy command is run (§3.5).

The child is not given `--no-extensions`. It loads what any pi loads, including this extension.

### §3.3 What the parent does not decide for the child

No `--tools`, no allowlist, no agent file, no role, no system-prompt injection. The parent writes
the whole task. The child's own registry is the authority on what it can do.

The model is the one thing the parent hands down (§3.1), and it is not a decision of the parent's
own: it is read from the session (C5), so the child runs on the model the user chose for this
conversation. A session with no model has nothing to hand down and refuses the call (C10) rather
than starting a child on some other model.

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

`isolation` is registered on `run_agent` **only when `isolated` is configured**, the same rule
§3.6 applies to depth: put it in the schema rather than accept a call and refuse it. With no
provider there is no parameter, so there is nothing to explain and nothing to reject.

The create command runs through `pi.exec`, so it gets pi's environment and the tool's abort signal. Its
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
- A session whose remaining depth is `0` registers neither `run_agent` nor `resume_agent`.

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
flag rather than config.

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

Stdout and stderr arrive merged, as pi's own shell tool merges them, and are appended to `output`.

pi's shell backend spawns detached on POSIX and tracks the pid itself, killing what it started on
exit. The abort signal is what ends a job (§5.2).

### §4.1 The foreground wait

A command with an estimate under 180 seconds is started exactly as any other job, and then waited
for:

```js
const how = await waitInForeground(job, seconds, signal);   // "ended" | "overran" | "detached"
if (job.status !== "running") return finished(job);          // the status is the authority
detach(job, seconds, how === "overran");
return handedOff(job, how === "overran");
```

**The wait is outside the job, not inside it.** The registry starts the command the same way for
every case; only the tool waits. So a foreground command is a job with a job id, a directory and an
`output` file from its first millisecond, and handing it off is not a conversion — it is the waiter
letting go.

**The status is the authority, not the race.** A command can end in the same tick the estimate
expires, and `Promise.race` will report whichever of the two it happened to see first. `finalise`
sets `status` before anything else, so reading `job.status` after the wait says what really
happened. There is no `await` between that read and `detach`, so nothing can interleave.

**The output is read back from the file, never accumulated.** Collection is unchanged: every byte
goes to `output` as it always did. What the model is shown is the last `DEFAULT_MAX_LINES` lines or
`DEFAULT_MAX_BYTES` bytes of that file, whichever is shorter — pi's `truncateTail` does the cutting
with pi's own two numbers (C5). Only the end of the file is read, `DEFAULT_MAX_BYTES + 1` of it, so
a 4MB build log is never held in memory. That one byte of width over the limit is load-bearing, and
nothing more than one byte is needed. It makes the limit, never the read, the thing that cuts, and
two properties follow. The truncation flag becomes trustworthy: a window that exceeds the limit is
always reported as cut, so `truncated` is true of the whole file and not merely of the window. And
the fragment of a line that the window opens on — it starts at a byte offset, so it usually opens
mid-line, sometimes mid-character — can never be reached by a cut that takes whole lines from the
end, because reaching it would mean everything after it fitting inside the limit. It is dropped
rather than shown.

It is that flag, not a comparison of sizes, that decides whether the path is named. The number the
line reports is the file size, which `statSync` has already given us, because counting the lines of
the whole file would mean reading the whole file.

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

### §5.2 One way to end a job

`job_stop` is the only thing that ends a job early, so a job carries one `AbortSignal` and it comes
from one `AbortController`. There is no deadline signal to compose with it, and no state to read
afterwards to work out which of two things fired.

```js
const stop = new AbortController();
const signal = stop.signal;
```

`job_stop` aborts it and waits for the job to settle, so it reports the final state rather than
`running`.

**The abort outranks whatever the runner reported.** A killed process says whatever its runtime
says — `aborted` from pi's shell backend, `The operation was aborted` from Node's `spawn`. Both
mean the same thing and neither is the answer, so `finalise` takes the status from the signal and
discards the runner's version. Without that, the same stop reads differently depending on which
kind of job it was, and both readings are noise.

A command job passes the signal to `exec`, which kills the process tree — verified: aborting a
command whose shell had started a child left neither running. An agent job passes it to `spawn`,
which signals the child **alone, not its tree**. That is enough because the child is pi, which
kills what it started when it is signalled; it is not enough if that pi dies without cleaning up,
and §12.10 is what happens then. For an isolated job the signal closes the `ssh` connection and
the remote pi exits on stdin EOF.

### §5.2a The overrun clock

An awaited job gets one `setInterval` at `expectedSeconds`, cleared in `finalise`. It fires at
every multiple — `1x`, `2x`, `3x` — and each firing sends the overrun message of §6 unless one was
sent less than five minutes ago.

**A foreground job's clock starts when the wait ends, not when the job starts.** Its `1x` mark is
the handoff, and the handoff already told the model it had overrun, so a clock started at the job
would fire at the same instant and say it twice. Starting the interval in `detach` instead makes
the first tick the `2x` mark, which is what §1 promises. When the wait ended because the human
interrupted rather than because the estimate passed, no overrun has been reported yet, so
`overrunAt` is left unset and the first tick reports normally.

There is one timer per awaited job, and one `clearInterval` that must stay next to the code that
closes the output file.

**The five minutes is a floor on noise, not a schedule.** `expectedSeconds: 1` on a job that runs
an hour would otherwise send 3,600 messages and wake the agent for every one. With the floor it
sends one at 1s and then one every five minutes. A service has no interval at all, so a dev server
is never reported for running long — which is the whole of what it does.

The interval keeps firing while suppressed rather than being rescheduled. A timer callback that
compares two numbers costs nothing, and the alternative is arithmetic over multiples that has to
stay correct across a suppressed window.

### §5.3 One finalise

One function sets the job's `status`, `exitCode` and `reason`, closes the output file, clears the
overrun interval, sends the notification, and refreshes the activity file. There is no second place
that decides whether a job succeeded, and no second place that can leave a timer running.

### §5.4 The headless drain

In `print` (`-p`) and `json` modes the host exits as soon as the first prompt settles, and
`session_shutdown` (§5.1) would abort whatever is still running. So the `agent_settled` handler
waits first: while the session is not quiescent — host idle, nothing queued, no awaited job
running — it waits on the awaited jobs' `settled` promises raced against a wakeup that fires on
every transition that can end quiescence (a turn starting or ending, a job starting or settling).
The host awaits the handler before `prompt()` resolves, so the wait holds the process open and
every completion reports through the normal notification path (§6) instead of dying in shutdown.
A subagent child runs the same code, so a tree of them drains bottom-up with no new protocol.

There is no timer in the loop and no stability counter: each side of the race resolves on a real
transition, which is what makes the wait exact rather than tuned (C10). `Promise.all([])`
resolves at once, so an empty awaited list waits on the wakeup alone — racing it bare would spin
while a notification turn runs.

Services are not drained: a service never finishes, so waiting for one would wait forever. They
are still aborted at shutdown, and in headless mode each one gets one `stderr` line, because
there is no footer and no transcript entry to record it anywhere else (C7). What ends the wait
is quiescence or teardown: if shutdown wins the race the handler stays quiet instead of nudging
into a session that is going away.

---

## §6. Notification

Two kinds of message, one mechanism:

```js
pi.sendMessage(
  { customType: "pi-background", content, details: { lines }, display: true },
  { deliverAs: "steer", triggerTurn: true },
)
```

Delivery is steer: while the parent is mid-run the completion is injected after the current
assistant turn's tool calls, before the next LLM call, so the parent reads it without ending its
turn. When the parent is idle, `triggerTurn` starts one — the wake-up the tool results promise.
Both are pi's own documented behaviours for `steer`, not assumptions (C10).

### §6.1 A job ended

**A job notifies when it ends, unless the model already has the answer.** That is the whole rule.
No exit code is inspected.

The model already has the answer in exactly two cases. `job_stop` returned the final state, so
delivering it again would wake the agent for a turn to be told what it just did. And a foreground
command returned its own output and exit code, so a message would be the same answer twice. Every
other ending notifies.

A service is included. It is not waited on, but it can still crash, and a dev server that dies in
silence is discovered by something else failing an hour later.

The message carries the outcome word, the elapsed time, the title, the id, a command's exit code,
the end of its output, and the path to read the whole of it. `details` carries your half — one
sentence, no id, no path — rendered by `registerMessageRenderer` (§2.1).

### §6.2 A job overran

**An awaited job that passes `expectedSeconds` says so, and keeps running.** The message states the
elapsed time, what was expected, the id, and that the job has not been stopped. It names the
options — leave it, `job_stop` it, or, for a command, `job_service` it — and recommends none.

**`job_service` is the third option because the estimate is sometimes wrong in kind, not in size.**
A dev server given `expectedSeconds: 600` is not a slow command; it is a service that was started
with the wrong parameter, and it will report an overrun every five minutes for as long as it runs.
The tool sets `expectedSeconds` to null on a running command, which is the one thing that
distinguishes a service from an awaited job, and clears the timer. The command is untouched. It is
named where the mistake becomes visible — in the overrun message and in the hand-off result — and
not in the `bash` description, which would pay for it on every turn to mention a tool for a mistake
that has not happened yet (C8). A subagent is never offered it: §1 forbids a null estimate on one.

That last part is the point. The extension does not know whether a build taking four times its
estimate is stuck or merely large. The model started the job, knows what it is, and can read the
output file; the decision is its own, and the message exists to hand it the fact it could not
otherwise have.

Repeats are on §5.2a's interval, floored at five minutes.

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

### §6.3 Held follow-ups

An Alt+Enter follow-up queued while a run is live is claimed by the `input` handler —
`action: "handled"` removes it from pi's path entirely, so pi's queue never delivers it. The
first version claimed one only when awaited jobs were already running, and that was a bug: the
job a caller is about to start does not exist yet, so job state at input time cannot decide the
hold — the message raced the job and won. What decides the hold is the release, not the claim.

The release is one condition — no awaited jobs — checked at every job change and at settle. When
no job is ever involved, the settle release is pi's own turn-end delivery, so nothing changes;
when a job starts after the claim, the message waits for it. On release the message is replayed
with `sendUserMessage`, which starts a turn when the parent is idle and joins pi's follow-up
queue when it is not, so queue order is kept. A release replaces the nudge: it is the
continuation the nudge would have asked for. The footer counts held follow-ups beside the jobs,
and the hold is announced with one `notify` when jobs are running.

A service is never a reason to hold: it is not awaited, so it blocks no release (§1). A held
message is not pi's to restore: Esc does not recall it, and `/new` loses it with the session
(§12.21). A message sent by other means while one is held — Enter when idle, or a mid-run steer —
can be answered before it; the hold waits for jobs, not for other messages.

---

## §7. The nudge

### §7.1 Trigger and checks

`agent_settled` — it fires once, after all retries, auto-compaction and queued messages, and means
pi will not continue on its own. `agent_end` fires again on every retry and is the wrong hook.

```
1. five nudges already this turn     -> skip
2. the run ended in error or abort   -> skip
3. an awaited job is running         -> skip; the job will wake it, running or overrunning
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

The cap is `5` (§13). One was too few: an agent that is nudged, does the thing, and then stops
mid-promise again is the case the feature exists for. Nothing distinguishes 5 from 3 or 10.

### §7.3 The classifier

```js
const rt = await ModelRuntime.create();          // 54 ms, once per session, lazily
const reply = await rt.completeSimple(model, { systemPrompt, messages }, {
  reasoning: nudge.effort, cacheRetention: "none", maxTokens: 2048,
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

The prompt names what counts as a promise, in both directions. A stated decision counts, with
its shapes given (`I will`, `I will now`, `Let me`, `I am going to`): bare promises were
answered NO. A question, a request for permission or confirmation, a conditional offer (`if you
want`, `should I`, `I can`, `tell me if`), and an action the user is told to take are not
decisions, and doubt defaults to NO. The conditional-offer shapes exist because of a real
misfire: an assistant message ending *Tell me if you want me to unify the two Dockerfiles …*
was read as a promise to unify them, and the session was nudged for work it had correctly left
to the user. A turn that ends by asking the user something is correctly waiting for a person,
and nudging on it restarts a session that was right to stop.

Measured on `google/gemini-3.5-flash-lite` with a six-message probe (one conditional offer, one
user-directed action, one question-offer, three plain promises): at `minimal` effort the old
prompt fired on the conditional offer and missed all three promises, and the new prompt answers
NO to everything, promises included — `minimal` cannot follow the prompt either way. At `low`
both prompts score 6/6, with the new prompt's exclusions as the guard against the next
conditional-offer shape. The effort level is doing as much work as the wording.

**`nudge.effort` is not a quality dial.** Measured on `google/gemini-3.8-flash`: omitting
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

`nudge` is one object with two required fields, so "a model with no effort" is unrepresentable
rather than checked for. It replaced a flat `nudgeModel` / `nudgeThinking` pair and the extra rule
that kept them in step; the rule is gone because the state it guarded against cannot be written.

The nudge text is an ordinary user message and stays in the transcript.

---

## §8. The activity file

```
~/.pi/agent/state/<pid>.json
{ "pid": 4711, "procStart": "8231447", "sessionId": "01a0...", "cwd": "/home/rmng/project",
  "status": "active" }
```

One predicate, refreshed from one function that five call sites hit — `session_start`,
`agent_start`, `agent_settled`, and every job start and finish:

```
active = !ctx.isIdle() || awaitedJobsRunning > 0
```

The drain (§5.4), this file and the nudge guard (§7.1) all read the same predicate, so the
three cannot disagree about what settled means. In headless mode `agent_settled` arrives only
after the drain, which is why `active` spans the whole background-work duration there rather
than the first prompt-response.

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

### §9.1 One key, in Pi's own settings file

Our settings sit under `"pi-background"` in Pi's `settings.json`, not in a file of our own. It is
where `pi-powerline-footer` already keeps its configuration, so the user edits one file rather than
one per extension, and Pi's own settings UI is beside it.

| File | Scope |
|---|---|
| `~/.pi/agent/settings.json` | the user, everywhere |
| `<cwd>/.pi/settings.json` | this project only |

Safe because Pi re-reads the file and spreads it before every write it makes
(`core/settings-manager.js:381`), so a key it does not know about survives a theme change.

**Read at load, not in `session_start`.** Pi drops an extension whose factory throws and reports it
(`core/extensions/loader.js:483`); it swallows a throw from a handler and carries on. Reading in
`session_start` meant a one-character typo left the session running on defaults it was never told it
had fallen back to — the nudge silently off, `maxDepth` silently 1. `process.cwd()` stands in for
`ctx.cwd`, which the factory is not given.

Nothing is configured through the environment. The one value that travels from a parent to a
child — remaining depth — is a CLI flag (§3.6): visible in `ps`, part of the command already being
built, and needing no forwarding rules to survive an `ssh` hop.

### §9.2 The schema

```jsonc
{
  // How deep a chain of subagents may go. 1 = this session starts subagents, and they start
  // none. Absent means 1. It bounds the height of the tree, not the number of sessions (§12).
  "maxDepth": 1,

  // Classifier for the nudge. Absent means the nudge is off. One object, so a model without
  // an effort is unrepresentable rather than checked for: both fields are required inside it.
  // "model" is "<provider>/<modelId>", split on the first "/".
  "nudge": { "model": "openai-codex/gpt-5.6-luna", "effort": "low" },

  // Provider for isolated subagents. Absent means isolation: "isolated" is refused when used.
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

The merged object is validated against one typebox schema, so an unknown key at any depth, a
wrong type and an illegal `nudge.effort` value are all loud failures. A malformed or unreadable
file is one too: no default, no partial load. The unknown key is found **before** the schema
runs, because a schema checker reports only "must not have additional properties" and never names
the key, and the key's name is the one thing a typo needs. **No file at all is not a failure** —
it means no nudge, no isolated jobs and no nesting; local command jobs and local subagents work
with no configuration.

**The config read is the last thing `session_start` does, and nothing registers behind it.** Pi
catches a throw from a handler and carries on, so a tool registered after the read disappears for
the whole session the first time the read fails — one mistyped key, and the model has no tools
and a system prompt that still names them. Reproduced. Tools are registered when the extension
loads; what a tool does without a setting is decided when it is called, and said out loud (C7).
`run_agent` is always offered and refuses when there is no depth left; `isolation` is always a
parameter and refuses when no provider is configured.

The project file is read without a trust check (§12).

### §9.5 No log

There is none. One was added because pi-context-fold has one, and consistency between the two
extensions is not one of the ten principles. It never ran in anger, and one of the two keys it
brought with it — `debug` — had no reader at all: C10 forbids a mechanism for a case that has not
been seen, and C3 forbids a key with no reason to turn it.

The argument for one is real and specific to this extension: a background job's failure is
invisible by the time you notice it, because the notification has scrolled away and the session
may be over. When that costs something, the log comes back with the failure that earned it, and
the shape of the record will come from that failure rather than from a guess (C10).

---

## §10. Layout

| File | Purpose |
|---|---|
| `index.ts` | config, flag, tool registration and descriptions, session events, activity file, nudge |
| `jobs.ts` | registry, `start`, `stop`, `finalise` → status + notify + activity, output files |
| `command-job.ts` | pi's shell backend, environment, output |
| `shown.ts` | the TUI components both readers' halves are drawn with; the same file in pi-context-fold |
| `agent-job.ts` | argv for local and ssh, sandbox create, stdin, stdout pipe, result extraction |

Six files. Tool descriptions and both renderers sit next to the registration they describe, and
the notification is sent inside `finalise`, so §5.3's "one place" is structural rather than a
convention someone can edit away. Every string about a job is built in `jobs.ts`, one function per
message; the tool and parameter descriptions sit with the registration, and the nudge sits with
the classifier that produces it. `docs/MODEL-FACING-TEXT.md` transcribes all three.

---

## §11. Out of scope

Only the ones whose reason is not obvious from the design.

| Not built | Because |
|---|---|
| Steering a running subagent | it is what `--mode json` costs, and stop is enough |
| Answering a child's question | in json mode a child cannot block on one |
| Jobs outliving the pi process | needs a process-liveness consensus protocol |
| An idle watchdog | an overrunning job already reports itself, and the model can read its output |
| Notification batching | add it when the log shows the cost |
| Undelivered-failure recovery | pi catches delivery failures itself and reports them as `extension_error` |
| A fan-out or breadth cap | see §12 |
| Parsing the child's event stream while it runs | nothing watches it; the tail is read once at the end |
| An in-process spawn, shell resolution, or signal escalation of our own | pi exports all three |
| Reading pi's `shellPath` / `shellCommandPrefix` | needs a second SettingsManager that trusts untrusted projects by default. §4 |
| `PI_*` variables in a command job | passing any environment loses pi's `PATH`. §4 |
| A session latch that disables the nudge | pi reports extension errors; a throw is louder and holds no state. §7.4 |
| A child process per nudge classification | 510 ms of startup per turn end |
| A pid in a command's result or in `job_list` | pi's shell backend returns an exit code and nothing else. Reporting a pid means spawning the shell ourselves, or rewriting the model's command to record its own — one loses §4, the other lies about what ran. `job_stop` already stops a job by id |
| A `resumeFrom` parameter on `run_agent` | a second tool with no `cwd` and no `isolation` deletes the two errors it needed. §2 |
| The session's own model as the classifier | it is pinned at max thinking; a cheap model answers in 1.8 s |

---

## §12. Limits

Written down so that when one bites, the real shape is handled rather than the imagined one.

1. **A sandbox is never reclaimed by this extension.** If the model forgets the destroy command,
   sandboxes accumulate.
2. **A finished job exists only in the transcript.** `job_list` shows what is running, so the
   record of a job that ended is its completion message and nothing else. If that message is
   compacted away, the id and the output path are gone with it, and the files on disk are all
   that is left.
3. **A job that hangs runs until something stops it.** Nothing ends a job on a clock. A wedged
   child reports that it has overrun, every five minutes, until the model or you act on it.
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
    settle, and two different things can make that wait unbounded. A child that ignores `SIGTERM`,
    or an `ssh` that hangs on a dead network, never exits. And a subagent settles on `close`, which
    waits for stdout to drain: a descendant that outlives the child holds the inherited pipes open,
    so `close` never fires even though the child is gone. Measured, with the same shape as
    `runAgent`: aborting a `spawn` whose child had started a grandchild left the grandchild running
    and reparented to init, and `close` had still not fired two seconds later. The fix is what pi
    does internally — settle on `exit` plus a bounded drain — because settling on `exit` alone
    would risk losing the subagent's last message, which is read from `output` at settle. A timeout
    here would be a constant with nothing behind it, so both stay unhandled until a real session
    shows the shape.
11. **An isolated sandbox must have this extension available to the child.** The child is started
    with `--jobs-depth`, a flag this extension registers, so a sandbox without it fails at once
    with `Error: Unknown option: --jobs-depth`. That is loud, and it is the sandbox image's job to
    satisfy — installed for the user, or present as `.pi/extensions/` in the sandbox cwd.
12. **A bad title is the whole of your view.** Nothing checks that a title describes the job, and
    the command it names is never shown to you. A model that titles three jobs "run tests" gives
    you a `/jobs` listing you cannot act on.
13. **A stopped job is reported once, to the model.** `job_stop` suppresses the completion
    message, so the only record you see is the tool line and the counter dropping. If the stop
    came from something other than the model, there would be no message at all — today nothing
    else can stop a job.
14. **Every command leaves a directory.** `bash` is the only shell the model has, so every command
    it runs — `ls` included — creates `~/.pi/agent/jobs/<id>/` with an `output` file in it, and
    nothing ever removes one. A working day is thousands of directories holding a few bytes each.
    They are kept because the path in a transcript has to stay readable (§12.2), and deleting them
    is a job for something outside this extension.
15. **A foreground command holds the turn.** The tool call does not return for up to 180 seconds.
    That is what a shell tool does, and it means a session can sit inside one tool call for three
    minutes.
16. **A command that hides its output until the end reports nothing at the handoff.** The last
    lines come from the `output` file, so a command that buffers — many do when their stdout is
    not a terminal — hands off with an empty body and the model sees only the path.
17. **The headless drain holds up later extensions.** `agent_settled` handlers run sequentially
    in registration order, and in `print`/`json` mode ours does not return until awaited jobs
    settle — so every extension after it waits that long for its own `agent_settled`.
18. **The headless drain has no timeout.** A wedged awaited job stalls `pi -p` indefinitely,
    in the child as well as the root. The only outward signal is the five-minute overrun
    message; there is no automatic stop, by §12.3 and C10.
19. **A service aborted at shutdown leaves almost no record.** In headless mode one `stderr`
    line names it; otherwise the job directory on disk is all that is left — no transcript
    entry, no notification.
20. **A subagent runs on the session's model, and the host must serve it.** The child is named
    `--provider`/`--model` for the model the parent is running, which the child resolves against
    its own catalogue and its own authentication — a sandbox without either fails the child at
    startup, loudly: pi prints the resolution error and exits 1, and the job reports `failed`.
    It does not fall back to some other model. A resume inherits the model the session is
    running at resume time, not the one the original job ran on.
21. **A held follow-up is memory only.** A quit, a `/new` or a crash loses it, and Esc does not
    recall it: it is not in pi's queue, so the restore-to-editor path never sees it.


---

## §13. The constants, and what is behind each

C9 says numbers come from the log and from real sessions, not from intuition. Most of these are
intuition, and saying so is the point of this table: a number presented as settled when nothing
measured it is worse than a number admitted to be a guess, because only the second one gets
revisited.

| Constant | Value | Behind it |
|---|---|---|
| `CLASSIFIER_MAX_TOKENS` | 2048 | **Measured.** §7.3 has the table and two falsifications: at 64 the answer truncated mid-sentence, at 512 one model returned empty after 506 reasoning tokens. |
| `FOREGROUND_MAX_SECONDS` | 180 | **Chosen.** It is where a shell command stops feeling like one. Nothing measured it, and a day of real work is what would. |
| `QUIET_MS` | 5 minutes | **Chosen.** The argument in §5.2a justifies a floor, not this floor. |
| The model's cut | `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` | **Not ours.** Pi's own two numbers, imported from it (C5). It is the host, and its cut is the one the model meets in every other session. |
| `SHOWN_LINES` / `SHOWN_BYTES` | 5 / 1000 | **Chosen.** Five is what Pi shows a person of its own output. The byte bound is what keeps one minified line off your screen. |
| `TAIL_WINDOW` | `DEFAULT_MAX_BYTES + 1` | **Derived, exactly.** The one property needed is *wider than the byte limit*, so that the limit and not the read is what cuts. One byte satisfies it. Written against the limit rather than as a number, so it follows if Pi raises the limit. |
| `MAX_NUDGES_PER_TURN` | 5 | **Partly measured.** One was tried and was too few. Nothing distinguishes 5 from 3 or 10. |
| `CLASSIFIER_TIMEOUT_MS` | 60 s | **Chosen.** A classification was measured at 1.8 s; this only has to bound a stalled connection. |
| `TAIL_BYTES` in `agent-job.ts` | 4 MiB | **Chosen.** Enough to hold any final assistant message; a larger one should be a loud failure. |

When one of these is wrong, the log that shows it does not exist yet (§9.5). That is the honest
state, and it is why none of them is a configuration key.
