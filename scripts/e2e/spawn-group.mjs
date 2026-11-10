// Starts a command in its own session and process group (PGID = PID). Used by lib.sh's start_bg where `setsid` is
// missing (macOS). Node's detached:true calls setsid() in the child, so the child is a session and group leader.
//
// Usage: node scripts/e2e/spawn-group.mjs <log-file> <cmd> [args…]
//   stdout: the child's PID (= its PGID), and nothing else, so the caller can capture it exactly.
//   stderr: start-up errors. Exit status 1 when the command can't be started, 2 on bad usage.
//   The child inherits this process's environment (OPENVERN_* etc.), its stdout and stderr go to <log-file>, and
//   it keeps running after this helper exits (unref'd, detached, stdin ignored).

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

const [logFile, cmd, ...args] = process.argv.slice(2);
if (!logFile || !cmd) {
  console.error('usage: spawn-group.mjs <log-file> <cmd> [args…]');
  process.exitCode = 2;
} else {
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] });
  // spawn() has already dup'ed the descriptor into the child, so the parent can drop its copy.
  closeSync(fd);

  child.once('error', (err) => {
    console.error(`spawn-group: cannot start ${cmd}: ${err.message}`);
    process.exitCode = 1;
  });
  child.once('spawn', () => {
    child.unref();
    process.stdout.write(`${child.pid}\n`);
  });
}
