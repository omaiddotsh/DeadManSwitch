// A separate process that takes a watcher state-file lock, for the lock races in test/watcher.test.ts.
//
//   node --import tsx test/lockContender.ts <stateFile> '<options JSON>'
//
// Prints one JSON line, {"pid", "held", "error"?}, as soon as lockStateFile returns or throws; a holder then
// keeps the lock (and its heartbeat) for `holdMs` and exits without releasing it, like a killed watcher.
// Options:
//   go          wait until this file exists before contending (a start barrier for several contenders)
//   ready       create this file when about to wait for `go`
//   pause       {signal, resume}: after judging the lock stale and before taking it over, create `signal`
//               and wait for `resume` (stages "descheduled mid-takeover")
//   crashOnUnlinkOf   SIGKILL this process when it is about to unlink this path (a crash mid-takeover)
//   noLink      link() fails with EPERM, as on SMB/CIFS and some FUSE filesystems
//   pidNs, bootId, host, heartbeatMs   this process's identity / heartbeat, as another container or machine

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lockStateFile, type LockEnv } from "../src/watcher.js";

interface Options {
  go?: string;
  ready?: string;
  pause?: { signal: string; resume: string };
  crashOnUnlinkOf?: string;
  noLink?: boolean;
  pidNs?: string;
  bootId?: string;
  host?: string;
  heartbeatMs?: number;
  holdMs?: number;
}

const [stateFile, json] = process.argv.slice(2);
const o = JSON.parse(json ?? "{}") as Options;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (path: string) => {
  while (!fs.existsSync(path)) sleep(5);
};

const realUnlink = fs.unlinkSync;
const realLink = fs.linkSync;
Object.assign(fs, {
  unlinkSync: (p: fs.PathLike) => {
    if (o.crashOnUnlinkOf !== undefined && String(p) === o.crashOnUnlinkOf) process.kill(process.pid, "SIGKILL");
    return realUnlink(p);
  },
  linkSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (o.noLink) throw Object.assign(new Error(`EPERM: operation not permitted, link '${String(from)}' -> '${String(to)}'`), { code: "EPERM" });
    return realLink(from, to);
  },
});
syncBuiltinESMExports();

const env: Partial<LockEnv> = {
  ...(o.pidNs !== undefined ? { pidNs: () => o.pidNs } : {}),
  ...(o.bootId !== undefined ? { bootId: () => o.bootId } : {}),
  ...(o.host !== undefined ? { host: () => o.host! } : {}),
  ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
  ...(o.pause
    ? {
        beforeTakeover: () => {
          fs.writeFileSync(o.pause!.signal, "");
          waitFor(o.pause!.resume);
        },
      }
    : {}),
};

if (o.ready) fs.writeFileSync(o.ready, "");
if (o.go) waitFor(o.go);
let held = false;
try {
  lockStateFile(stateFile, env);
  held = true;
  console.log(JSON.stringify({ pid: process.pid, held }));
} catch (err) {
  console.log(JSON.stringify({ pid: process.pid, held, error: (err as Error).message }));
}
if (held) setTimeout(() => process.exit(0), o.holdMs ?? 0);
