import fs from 'node:fs';
import {Database} from 'bun:sqlite';
import {baseStamp,hasMergedChanges,livePath,liveMergeThreshold,LIVE_MERGE_BATCH,LIVE_PATH_LIMIT} from './delta';

/** On-demand inspection. Regular search and update polling never count these rows. */
export function journalStatus(index:string) {
  const config={index,threshold:liveMergeThreshold(),hardLimit:LIVE_PATH_LIMIT,batchSize:LIVE_MERGE_BATCH};
  if(!fs.existsSync(livePath()))return {...config,initialized:false};
  const db=new Database(livePath(),{readonly:true});
  try {
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    const scope=db.query('SELECT revision,problem,lastChange FROM scopes WHERE name=?').get(index);
    if(!scope)return {...config,initialized:false};
    const enabled=hasMergedChanges(db);
    const recent=db.query('SELECT count(*) AS n FROM changes WHERE scope=?').get(index).n;
    const merged=enabled?db.query('SELECT count(*) AS n FROM merged_changes WHERE scope=?').get(index).n:0;
    const watermark=enabled?db.query('SELECT watermark FROM merge_queue WHERE scope=?').get(index)?.watermark:null;
    return {...config,initialized:true,schemaSupportsAutomaticMerge:enabled,recent,merged,queuedThrough:watermark??null,...scope};
  } finally { db.close(); }
}

/** Queue a single watermark; the normal watcher owns execution and retries. */
export function requestJournalMerge(index:string) {
  const stamp=baseStamp(index);
  const db=new Database(livePath(),{create:false});
  try {
    db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
    const scope=db.query('SELECT stamp,revision FROM scopes WHERE name=?').get(index);
    if(!scope || scope.stamp!==stamp || !hasMergedChanges(db))throw new Error('Start the current live watcher for this index before requesting a merge');
    const pending=db.query('SELECT 1 FROM changes WHERE scope=? LIMIT 1').get(index);
    if(pending)db.query('INSERT OR IGNORE INTO merge_queue(scope,watermark) VALUES (?,?)').run(index,scope.revision);
    db.exec('COMMIT');
  } finally { db.close(); }
  return journalStatus(index);
}
