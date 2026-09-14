import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic agent dir: src/jobs.ts and src/index.ts resolve it at module load, so this must run
// before any test file imports the extension (node --import order guarantees it). HOME is set
// too, in case the host package is ever rebranded and the env var name changes with it.
process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(join(tmpdir(), "pi-background-test-"));
process.env.HOME = mkdtempSync(join(tmpdir(), "pi-background-home-"));
