// A lease lets only one process publish an update. Its unique owner token prevents
// an expired worker from releasing or publishing over a newer worker's lease.
import { randomUUID } from "node:crypto";
import { getSetting, setSetting, type Database } from "../storage/database.js";

export interface RefreshLease {
  jobId: string;
  ownerToken: string;
  expires: number;
}

const leaseKey = "refresh_lease";
const leaseTtlMs = 180_000;

function storedLease(db: Database): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(getSetting(db, leaseKey, "null"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function leaseMatches(
  value: Record<string, unknown> | null,
  lease: RefreshLease,
  now: number,
): boolean {
  return (
    value?.jobId === lease.jobId &&
    value.ownerToken === lease.ownerToken &&
    typeof value.expires === "number" &&
    value.expires > now
  );
}

/** Claims a cross-process lease and returns an invocation-specific fencing token. */
export function claimRefreshLease(
  db: Database,
  jobId: string,
  now = Date.now(),
  ttlMs = leaseTtlMs,
): RefreshLease {
  const lease = {
    jobId,
    ownerToken: randomUUID(),
    expires: now + ttlMs,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = storedLease(db);
    if (current && typeof current.expires === "number" && current.expires > now)
      throw new Error("Another refresh is active");
    setSetting(db, leaseKey, JSON.stringify(lease));
    db.exec("COMMIT");
    return lease;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Renews only the lease still owned by this invocation. */
export function renewRefreshLease(
  db: Database,
  lease: RefreshLease,
  now = Date.now(),
  ttlMs = leaseTtlMs,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!leaseMatches(storedLease(db), lease, now)) {
      db.exec("COMMIT");
      return false;
    }
    lease.expires = now + ttlMs;
    setSetting(db, leaseKey, JSON.stringify(lease));
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function releaseRefreshLease(
  db: Database,
  lease: RefreshLease,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = storedLease(db);
    if (
      current?.jobId !== lease.jobId ||
      current.ownerToken !== lease.ownerToken
    ) {
      db.exec("COMMIT");
      return false;
    }
    setSetting(db, leaseKey, "null");
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function assertLeaseOwner(
  db: Database,
  lease: RefreshLease,
  now = Date.now(),
): void {
  if (!leaseMatches(storedLease(db), lease, now))
    throw new Error("Refresh lease was lost; staged corpus was not activated");
}
