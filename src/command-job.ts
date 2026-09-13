import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { type Job, type Outcome, write } from "./jobs.ts";

export function runCommand(job: Job, command: string, cwd: string): Promise<Outcome> {
	return createLocalBashOperations()
		.exec(command, cwd, { onData: (chunk) => write(job, chunk), signal: job.stop.signal })
		.then(({ exitCode }) =>
			exitCode === 0 ? { status: "done" as const, exitCode } : { status: "failed" as const, exitCode },
		);
}
