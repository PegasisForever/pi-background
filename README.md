# pi-background

A [pi](https://github.com/badlogic/pi-mono) extension that gives an agent four things: background
shell commands, subagents, a prod when it stops mid-promise, and a file an external supervisor can
read to tell whether the session is busy.

Built for one person on one machine. Linux only, pi 0.85.1, no Windows path handling and no
Node version detection. See the constitution at the top of [DESIGN.md](DESIGN.md) for why it is
allowed to be that narrow.

## What it does

**Background commands.** `run_command` starts a shell command and returns immediately. The agent
ends its turn; when the command finishes, a message wakes the agent and tells it the exit code and
where the output is. A command started with `expectedSeconds: null` is a *service* — a dev server, a
watcher — that nothing is waiting on. It still reports when it stops, so a crashed dev server is not
silent.

**Nothing is killed by the clock.** `expectedSeconds` is an estimate, not a deadline. When a job
passes it the job keeps running and the agent is told: *still running after 12m, longer than the
120s you expected. It has not been stopped. Leave it running, or stop it with job_stop.* It repeats
at each multiple of the estimate, never more often than once every five minutes. An agent is bad at
guessing how long work takes, and a low guess should cost a message, not the work.

**Subagents.** `run_agent` starts a whole `pi` process on a task, locally or inside a sandbox
reached over SSH, and reports the same way. There is one kind of subagent: no roles, no presets, no
tool allowlist guessed by the parent. The task is the whole instruction. `resume_agent` continues a
finished one with its context intact.

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

Two optional files, shallow-merged, project over user:

```
~/.pi/agent/pi-background.json      everywhere
<project>/.pi/pi-background.json    this project only
```

```jsonc
{
  // How deep a chain of subagents may go. Absent means 1.
  "maxDepth": 1,

  // Classifier for the nudge. Absent means the nudge is off. Both keys or neither.
  "nudgeModel": "openai-codex/gpt-5.6-luna",
  "nudgeThinking": "low",

  // Sandbox provider. Absent means run_agent has no isolation parameter at all.
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
verbatim to the `run_agent` description, so telling the agent how to clean up is your job and costs
one string.

An unknown key, a wrong type or a bad thinking level is a startup error, not a shrug.

## Tools the agent gets

| Tool | What it does |
|---|---|
| `run_command` | start a shell command; `expectedSeconds: null` for a service |
| `run_agent` | start a subagent, locally or in a sandbox |
| `resume_agent` | continue a finished subagent with a follow-up task |
| `job_list` | what is still running |
| `job_stop` | stop one by id |

`run_agent` is not registered when the session has no depth left, and `isolation` is not registered
when no sandbox provider is configured. A parameter that would only ever be refused is not offered.

## What you get

A count under the input box while anything is running:

```
2 commands, 1 subagent
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
| [DESIGN.md](DESIGN.md) | the design, and the constitution it answers to |
| [MODEL-FACING-TEXT.md](MODEL-FACING-TEXT.md) | every string, transcribed: what the model reads, what you read |
| [FEATURES.md](FEATURES.md) | the menu this was picked from, frozen as a record |

`MODEL-FACING-TEXT.md` exists so the boundary between the two readers can be audited without
reading the code. If a string changes and that file does not, one of them is wrong.

## Limits

Written down in full in §12 of DESIGN.md. The ones worth knowing before you start:

- A sandbox is never reclaimed by this extension. If the agent forgets the destroy command, they
  accumulate.
- Depth bounds the height of the subagent tree, not its size. Nothing counts how many there are.
- A command that backgrounds its own children with `&` survives a stop.
- A project config is read without a trust check, and it can name the command that creates a
  sandbox.
- Jobs die when pi dies. There is no daemon.
- A job that hangs runs until something stops it. It reports that it has overrun, every five
  minutes, and the decision stays with the agent.
