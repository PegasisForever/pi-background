import { spawn, execSync } from "node:child_process";
const pids = (n) => { try { return execSync(`pgrep -f "sleep 98766[${n}]" || true`).toString().trim().split("\n").filter(Boolean); } catch { return []; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ac = new AbortController();
const child = spawn("bash", ["-c", "bash -c 'sleep 987661; echo x'"], { stdio: ["pipe","pipe","pipe"], signal: ac.signal });
child.on("error", () => {});
let closed = false;
child.on("close", () => { closed = true; });
await wait(900);
console.log("before abort:", pids(1).length, "process(es)");
ac.abort();
await wait(2000);
console.log("2s after abort:", pids(1).length, "process(es) survive; 'close' fired:", closed);
console.log("survivors:", execSync(`ps -o pid,ppid,args -p ${pids(1).join(",") || "1"} || true`).toString().trim());
for (const p of pids(1)) { try { process.kill(Number(p), "SIGKILL"); } catch {} }
process.exit(0);
