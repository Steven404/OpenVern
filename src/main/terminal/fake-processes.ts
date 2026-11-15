// A controllable process table for the terminal tests: processes that live in a terminal's session, die on the
// signals they don't ignore, and are looked up like ./processes.ts does, without any real process. `linux` keeps a
// process's session id after the leader exits; `darwin` takes the controlling terminal away (session null), as macOS
// does.

import type { KillSignal, ProcessEntry, ProcessTable, SignalProcess } from './processes';

export interface FakeProcess {
  pid: number;
  start: string;
  session: string | null;
  /** Survives SIGHUP (`trap '' HUP`, nohup). SIGKILL always kills. */
  ignoresHup?: boolean;
}

export interface FakeProcessTable {
  readonly table: ProcessTable;
  readonly signal: SignalProcess;
  /** Live processes by pid. */
  readonly processes: Map<number, FakeProcess>;
  /** Every signal sent to a non-shell process, in order. */
  readonly signals: Array<{ pid: number; signal: KillSignal }>;
  /** How many times the table was read. */
  readonly lookups: number;
  /** Makes `list` and `listSync` throw (no `ps`, unreadable /proc). */
  failing: boolean;
  add(process: FakeProcess): void;
  /** The session leader exits: on darwin, the processes left in its session lose their terminal. */
  leaderExited(leaderPid: number): void;
  /** The session key of a leader's session on this platform. */
  keyOf(leaderPid: number): string;
}

export function createFakeProcessTable(platform: 'linux' | 'darwin'): FakeProcessTable {
  const processes = new Map<number, FakeProcess>();
  const signals: Array<{ pid: number; signal: KillSignal }> = [];
  let lookups = 0;
  const keyOf = (leaderPid: number) => (platform === 'linux' ? `sid:${leaderPid}` : `tty:16/${leaderPid}`);
  const list = (): ProcessEntry[] => {
    lookups += 1;
    if (fake.failing) throw new Error('ps: not found');
    return [...processes.values()].map(({ pid, start, session }) => ({ pid, start, session }));
  };
  const fake: FakeProcessTable = {
    table: {
      keyOutlivesLeader: platform === 'linux',
      leaderKey: (pid) => (platform === 'linux' ? keyOf(pid) : null),
      list: async () => list(),
      listSync: list,
    },
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      const target = processes.get(pid);
      if (target && (signal === 'SIGKILL' || !target.ignoresHup)) processes.delete(pid);
    },
    processes,
    signals,
    get lookups() {
      return lookups;
    },
    failing: false,
    add(process) {
      processes.set(process.pid, process);
    },
    leaderExited(leaderPid) {
      const key = processes.get(leaderPid)?.session ?? keyOf(leaderPid);
      processes.delete(leaderPid);
      if (platform === 'darwin') {
        for (const process of processes.values()) if (process.session === key) process.session = null;
      }
    },
    keyOf,
  };
  return fake;
}
