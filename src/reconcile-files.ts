import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { hasMergedChanges, LIVE_PATH_LIMIT, liveMergeThreshold } from './delta';

export interface MembershipCandidate {
  path: string;
  present: boolean;
}
export interface MembershipFence {
  index: string;
  stamp: string;
  revision: number;
}
export type RepairOutcome = 'applied' | 'newer' | 'changed' | 'inaccessible' | 'tree' | 'capacity';
export interface RepairRecord extends MembershipCandidate {
  outcome: RepairOutcome;
  revision?: number;
}

/** A positive observation can only be applied while its path still exists.
 * A negative observation needs ENOENT or ENOTDIR, independently of scan warnings.
 * Caller pins the base publication lock and supplies exact membership differences.
 */
export function membershipRepairWriter(db: Database, fence: MembershipFence, media: boolean) {
  const state = db.query('SELECT stamp,revision FROM scopes WHERE name=?');
  const previous = db.query('SELECT revision,tree FROM changes WHERE scope=? AND path=?');
  let merged: ReturnType<Database['query']>, barriers: ReturnType<Database['query']>;
  const write = db.query('INSERT INTO changes (scope,path,present,tree,revision) VALUES (?,?,?,0,?) ON CONFLICT(scope,path) DO UPDATE SET present=excluded.present,tree=0,revision=excluded.revision');
  let barrierWrite: ReturnType<Database['query']>;
  const queue = db.query('INSERT INTO jobs(scope,path) VALUES (?,?) ON CONFLICT(scope,path) DO UPDATE SET failures=0,retryAt=0');
  const advance = db.query('UPDATE scopes SET revision=?,lastChange=? WHERE name=?');
  // A single reserved slot per difference would underestimate capacity after
  // another writer's commit. Recount before capacity can be reached.
  let lastRevision = -1, slots = 0;
  return (batch: MembershipCandidate[]): RepairRecord[] => {
    if (batch.length > 256) throw new Error('Membership repair batch exceeds 256 paths');
    db.exec('BEGIN IMMEDIATE');
    try {
      const scope = state.get(fence.index);
      if (scope?.stamp !== fence.stamp || scope.revision < fence.revision) throw new Error('Journal generation changed');
      if (!merged && hasMergedChanges(db)) {
        merged = db.query('SELECT revision,tree FROM merged_changes WHERE scope=? AND path=?');
        barriers = db.query('SELECT revision FROM tree_barriers WHERE scope=? AND path=?');
        barrierWrite = db.query('INSERT INTO tree_barriers(scope,path,revision) VALUES (?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=max(revision,excluded.revision)');
      }
      function journal(p: string) {
        const recent = previous.get(fence.index,p);
        const folded = merged?.get(fence.index,p);
        const barrier = barriers?.get(fence.index,p)?.revision ?? -1;
        const revision = Math.max(recent?.revision ?? -1, folded?.revision ?? -1, barrier);
        const tree = Math.max(recent?.tree ? recent.revision : -1, folded?.tree ? folded.revision : -1, barrier);
        return {recent,revision,tree};
      }
      if (lastRevision !== scope.revision || slots < batch.length) {
        slots = LIVE_PATH_LIMIT - db.query('SELECT COUNT(*) AS n FROM changes WHERE scope=?').get(fence.index).n;
      }
      const ancestorCache = new Map<string,boolean>();
      function newerTree(p: string): boolean {
        if (p === '/') return false;
        const parent = path.dirname(p);
        if (!ancestorCache.has(parent)) {
          const ancestor = journal(parent);
          ancestorCache.set(parent, ancestor.tree > fence.revision || newerTree(parent));
        }
        return ancestorCache.get(parent)!;
      }
      const records: RepairRecord[] = [];
      let applied = false;
      for (const candidate of batch) {
        const p = candidate.path;
        if (!p.startsWith('/') || p === '/' || path.resolve(p) !== p || p.includes('\0')) throw new Error('Invalid membership candidate path');
        const old = journal(p);
        let outcome: RepairOutcome;
        if (old.revision > fence.revision || newerTree(p)) outcome = 'newer';
        else if (old.recent?.tree && !barrierWrite) outcome = 'tree'; // Replaying a tree tombstone would hide later children.
        else if (!old.recent && slots <= 0) outcome = 'capacity';
        else {
          let observed: boolean | undefined;
          try {fs.lstatSync(p); observed = true;}
          catch (e) {
            if (['ENOENT','ENOTDIR'].includes(e.code)) observed = false;
            else if (!['EACCES','EPERM','ELOOP','ESTALE','EIO'].includes(e.code)) throw e;
          }
          if (observed === undefined) outcome = 'inaccessible';
          else if (observed !== candidate.present) outcome = 'changed';
          else {
            // Retain the old subtree cutoff without giving it the new exact-path revision.
            if (old.recent?.tree) barrierWrite.run(fence.index,p,old.recent.revision);
            write.run(fence.index,p,Number(observed),scope.revision+1);
            if (!old.recent) slots--;
            if (media && /\.(mp3|wav|aac|flac|m4a|ogg|opus|aiff?|caf|wma|mp4|m4v|mov|mkv|png|jpe?g|webp)$/i.test(p)) queue.run(fence.index,p);
            outcome = 'applied';
            applied = true;
          }
        }
        records.push({...candidate,outcome,...(outcome === 'applied' ? {revision:scope.revision+1} : {})});
      }
      if (applied) advance.run(scope.revision+1,new Date().toISOString(),fence.index);
      if (merged && applied && LIVE_PATH_LIMIT-slots >= liveMergeThreshold()) {
        db.query('INSERT OR IGNORE INTO merge_queue(scope,watermark) VALUES (?,?)').run(fence.index,scope.revision+1);
      }
      db.exec('COMMIT');
      lastRevision = scope.revision + Number(applied);
      return records;
    } catch (error) {
      db.exec('ROLLBACK');
      lastRevision = -1;
      throw error;
    }
  };
}
