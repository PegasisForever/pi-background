# pi-background

A [pi](https://github.com/badlogic/pi-mono) extension that gives an agent four things: a shell tool
that moves a slow command into the background instead of killing it, subagents, a prod when it
stops mid-promise, and a file an external supervisor can read to tell whether the session is busy.

Built for one person on one machine, and published as is: no support, and no promise that
anything stays the same. Linux only, pi 0.85.1, no Windows path handling and no Node version
detection. See the constitution at the top of [docs/DESIGN.md](docs/DESIGN.md) for why it is
allowed to be that narrow.

## What it does

**One shell tool, two speeds.** `bash` replaces pi's built-in one. Every call carries a title and
`expectedSeconds`, the agent's own estimate. Under three minutes the command runs in front of the
agent and returns its output and exit code, like any shell tool. Three minutes or more — and any
`expectedSeconds: null`, which means a *service* such as a dev server — starts in the background at
once, and a message wakes the agent when it ends. A service reports when it stops too, so a crashed
dev server is not silent.

**Nothing is killed by the clock.** The estimate is an estimate, not a deadline. A command that
passes it is not stopped: the agent is handed the output so far and the job id, and the command
carries on in the background. *Still running after 12m, longer than the 120s you expected. It has
not been stopped. Leave it running, or stop it with job_stop.* That repeats at each multiple of the
estimate, never more often than once every five minutes. An agent is bad at guessing how long work
takes, and a low guess should cost a message, not the work.

**And the estimate can be wrong in kind, not just in size.** A dev server started with a number
instead of `null` is not a slow command; it is a service, and it will report an overrun for as long
as it runs. `job_service` says so after the fact: the command keeps running untouched, its expected
duration becomes none, and the reports stop. The overrun message names the tool, because that is the
moment the mistake becomes visible.

**A backgrounded job is never waited for.** Every result that hands back a job id ends with the same
sentence: *Do not poll it, sleep, or run a command to watch it: end your turn, and the notification
will start a new one.* A job id is an invitation to sit and watch, and a turn spent watching learns
nothing the notification will not deliver.

**A follow-up can wait for the jobs.** Alt+Enter queues a message for after the turn; the
extension takes it over, and releases it when no awaited background job is running — so a job
you start after queueing still gets waited for. A service is never waited on. Esc does not
recall a held message, and a quit loses it.

**Escape stops the waiting, not the command.** Interrupt a command that is running in front of the
agent and it moves to the background, as an overrun does. `job_stop` is the only thing that ends a
job early.

**The whole output is always on disk.** Every command writes to `~/.pi/agent/jobs/<id>/output`.
The agent is shown the output itself, cut where pi cuts its own — the last 2000 lines or 50KB,
whichever comes first. Only when that cut lost something is the file named: *This is the last 9.8KB
of 23.3KB. The whole output is at …*. A result that names no file is the whole output, so the agent
never spends a read finding out it already had everything. You get the last five lines in the
terminal, on every result and every completion message, which is the same split pi makes.

**Subagents.** `run_agent` starts a whole `pi` process on a task, locally or inside a sandbox
reached over SSH, and reports the same way. It runs on the same model the session is already
running, thinking level included. There is one kind of subagent: no roles, no presets, no
tool allowlist guessed by the parent. The task is the whole instruction. `resume_agent`
continues a finished one with its context intact.

**The nudge.** When the agent ends a turn having said it would do something it did not do, a cheap
classifier model notices and sends it one line: *You said you would run the test suite, but did
not. Continue.* At most five per turn.

**An activity signal.** `~/.pi/agent/state/<pid>.json` says `active` or `idle`, with enough
information for a reader to tell a live session from a file left by a killed one. It exists so a
supervisor does not need a second model to guess whether a session is working.

## Install

Straight from GitHub:

```
pi install git:github.com/PegasisForever/pi-background
```

Or from a clone, which is what you want if you are editing it:

```
git clone https://github.com/PegasisForever/pi-background
pi install ./pi-background
```

Add `-l` to either to install into the current project instead of your user settings. To pull a
newer version later:

```
pi update git:github.com/PegasisForever/pi-background
```

Nothing else is required. Local commands and local subagents work with no configuration at all.

## Configure

Under `"pi-background"` in Pi's own `settings.json` — the same file `pi-powerline-footer` uses, so
there is one file to edit, not one per extension. Two of them, shallow-merged, project over user:

```
~/.pi/agent/settings.json      everywhere
<project>/.pi/settings.json    this project only
```

```jsonc
// settings.json
"pi-background": {
  // How deep a chain of subagents may go. Absent means 1.
  "maxDepth": 1,

  // Classifier for the nudge. Absent means the nudge is off; present means both fields.
  "nudge": { "model": "openai-codex/gpt-5.6-luna", "effort": "low" },

  // Sandbox provider. Absent means isolation: "isolated" is refused when it is used.
  "isolated": {
    "create": "my-sandbox-create",
    "instructions": "Work happens in /home/me/work. The sandbox stays up after the job ends; run `my-sandbox-destroy <sandbox id>` when you are done with it."
  }
}
```

`isolated.create` is any command that creates a sandbox and prints one JSON line:

```json
{"id":"sb-31","ssh":"ssh -o StrictHostKeyChecking=accept-new me@10.0.0.31","cwd":"/home/me/work"}
```

The extension does not know what a sandbox is, and never destroys one. `instructions` is appended
verbatim to the **result of a `run_agent` call that actually made a sandbox** — not to the tool
description, which every turn would pay for whether a sandbox was used or not. Telling the agent how
to clean up is your job and costs one string, on the calls that need it.

An unknown key, a wrong type or a bad thinking level stops the extension loading, with a message
naming the key. It is not a shrug, and it is not a session that quietly runs on defaults.

## Tools the agent gets

| Tool | What it does |
|---|---|
| `bash` | run a shell command; under 3 minutes it waits, longer it backgrounds; `expectedSeconds: null` for a service |
| `run_agent` | start a subagent, locally or in a sandbox |
| `resume_agent` | continue a finished subagent with a follow-up task |
| `job_list` | what is still running in the background |
| `job_service` | this command was never going to finish; stop expecting it to |
| `job_stop` | stop one by id |

All six exist in every session. `run_agent` refuses when the session has no subagent depth left,
and `isolation: "isolated"` refuses when no sandbox provider is configured — each says so in one
sentence. Which tools exist never depends on the config file, because a config file can fail to
load and a session with no tools is worse than a tool that explains itself.

## What you get

A command's last lines, then one line of status:

```
bash list etc
ImageMagick-7
UPower
X11
adduser.conf

Finished in 0s.
Exit code: 0
```

The model gets the output itself, then the exit code, as sentences — and the path only when
something was cut.

A count in pi's footer while anything is running in the background:

```
2 commands, 1 subagent
```

A command you are waiting for is never counted, in the footer or in `/jobs` or in `job_list`.
Otherwise every `ls` would put `1 command` in the footer for the length of an `ls`. A command
appears the moment it outlives the wait and moves to the background, which is the moment it is
worth telling you about.

It is written with `setStatus`, under the key `pi-background`. If you use
[pi-powerline-footer](https://www.npmjs.com/package/pi-powerline-footer), you can give it a
segment of its own instead of leaving it in the overflow row:

```jsonc
"powerline": {
  "customItems": [
    { "id": "jobs", "statusKey": "pi-background", "position": "right",
      "hideWhenMissing": true, "excludeFromExtensionStatuses": true }
  ]
}
```

And `/jobs`, which is yours alone and never reaches the model:

```
job id                                type     title                elapsed  expected
01a09a13-04cf-73d2-88ce-082fbf7c871f  command  long sleeper             15s      none
01a09a13-04d2-73d2-88ce-0831f03dcabb  command  build the docs site      15s      600s
```

Every tool and every notification writes two texts: one for the model, one for you. They are not
the same text. pi carries the second in a tool result's `details`, which never reaches the
provider, so your half costs no tokens.

## Documents

| File | What it is |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | the design, and the constitution it answers to |
| [docs/MODEL-FACING-TEXT.md](docs/MODEL-FACING-TEXT.md) | every string, transcribed: what the model reads, what you read |
| [docs/FEATURES.md](docs/FEATURES.md) | the menu this was picked from, frozen as a record |

`docs/MODEL-FACING-TEXT.md` exists so the boundary between the two readers can be audited without
reading the code. If a string changes and that file does not, one of them is wrong.

## Limits

Written down in full in §12 of docs/DESIGN.md. The ones worth knowing before you start:

- A sandbox is never reclaimed by this extension. If the agent forgets the destroy command, they
  accumulate.
- Depth bounds the height of the subagent tree, not its size. Nothing counts how many there are.
- A command that backgrounds its own children with `&` survives a stop.
- A project config is read without a trust check, and it can name the command that creates a
  sandbox.
- A subagent runs on the session's model. A sandbox without that provider's authentication, or
  without that model in its catalogue, fails the job loudly instead of switching models.
- Jobs die when pi dies. There is no daemon.
- A job that hangs runs until something stops it. It reports that it has overrun, every five
  minutes, and the decision stays with the agent.
- Every command leaves a directory under `~/.pi/agent/jobs/`, `ls` included, and nothing removes
  them.
- A command that buffers its output hands off with nothing to show but the path.
- **Nothing is written down when a job misbehaves.** There is no log file, so a background
  failure you notice an hour later has left no record beyond its output file.

## Licence

MIT.
