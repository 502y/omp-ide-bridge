/**
 * Lockfile discovery for the OMP IDE bridge (client side).
 *
 * IDEs publish `~/.omp/ide/<port>.lock` (mode 0600). We scan, drop stale
 * entries (dead pid), and pick the best candidate for a given cwd.
 */

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathContains, type LockFile } from "./protocol";

export interface IdeCandidate {
	port: number;
	lockPath: string;
	lock: LockFile;
	mtimeMs: number;
}

const LOCK_DIR = join(homedir(), ".omp", "ide");

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = exists but not ours; anything else (ESRCH/EINVAL) = dead.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Scan the lock dir. Stale locks (unparseable or dead pid) are removed. */
export function scanCandidates(dir: string = LOCK_DIR): IdeCandidate[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: IdeCandidate[] = [];
	for (const name of names) {
		const m = /^(\d+)\.lock$/.exec(name);
		if (!m) continue;
		const port = Number(m[1]);
		const lockPath = join(dir, name);
		let lock: LockFile;
		try {
			lock = JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
		} catch {
			safeRemove(lockPath);
			continue;
		}
		if (lock.transport !== "ws" || !lock.authToken || !pidAlive(lock.pid)) {
			safeRemove(lockPath);
			continue;
		}
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(lockPath).mtimeMs;
		} catch {
			/* keep 0 */
		}
		out.push({ port, lockPath, lock, mtimeMs });
	}
	return out;
}

function safeRemove(p: string): void {
	try {
		rmSync(p, { force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Pick a candidate for `cwd`:
 * 1. explicit port (OMP_IDE_PORT),
 * 2. locks whose workspaceFolders contain cwd, most recent first.
 * Returns null when nothing matches.
 */
export function pickCandidate(
	cwd: string,
	explicitPort?: number,
	dir: string = LOCK_DIR,
): IdeCandidate | null {
	const candidates = scanCandidates(dir);
	if (explicitPort !== undefined) {
		const hit = candidates.find((c) => c.port === explicitPort);
		if (hit) return hit;
	}
	const matching = candidates
		.filter((c) =>
			c.lock.workspaceFolders.some((f) => pathContains(f, cwd)),
		)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return matching[0] ?? null;
}
