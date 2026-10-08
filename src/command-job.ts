import { createLocalBashOperations, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Job, type Outcome, write } from "./jobs.ts";

export function runCommand(job: Job, command: string, cwd: string, ctx: ExtensionContext): Promise<Outcome> {
	return createLocalBashOperations()
		.exec(`${sessionExports(ctx)}\n${command}`, cwd, {
			onData: (chunk) => write(job, chunk),
			signal: job.stop.signal,
		})
		.then(({ exitCode }) =>
			exitCode === 0 ? { status: "done" as const, exitCode } : { status: "failed" as const, exitCode },
		);
}

/**
 * The PI_* variables pi's own bash tool sets, as shell lines run before the command (§4). The
 * unset clears values inherited from a parent pi, as pi's tool does.
 */
function sessionExports(ctx: ExtensionContext): string {
	const values: Record<string, string | undefined> = {
		PI_SESSION_ID: ctx.sessionManager.getSessionId(),
		PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
		PI_PROVIDER: ctx.model?.provider,
		PI_MODEL: ctx.model?.id,
		PI_REASONING_LEVEL: ctx.thinkingLevel,
	};
	const exports = Object.entries(values)
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.map(([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`);
	return [`unset ${Object.keys(values).join(" ")}`, ...exports].join("\n");
}
