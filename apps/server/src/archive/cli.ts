/**
 * Research archive CLI (manual; run on the machine that hosts the local archive database).
 *
 *   npm run archive:research -- --dry-run            eligible rows + estimated reclaim (no writes)
 *   npm run archive:research -- --report             storage + archive status (no writes)
 *   npm run archive:research -- --archive            copy every table to the local archive, verified
 *   npm run archive:research -- --verify             check eligible rows are archived identically
 *   npm run archive:research -- --prune --confirm-delete
 *                                                    copy → verify → delete eligible research rows
 * Options: --batch-size=N --tables=a,b --full --compact-hot-hours=N --max-batches=N --json
 *
 * Env: ARCHIVE_SOURCE_DATABASE_URL (production, TLS) and ARCHIVE_DATABASE_URL (localhost only).
 */
import { env } from '../config/env.js';
import { COMPACT_RESEARCH_FLOOR_HOURS } from '../db/retention.js';
import {
  ArchiveSafetyError,
  MIN_COMPACT_HOT_HOURS,
  WRITE_MODES,
  assertDistinct,
  connectArchive,
  connectSource,
  ensureArchiveDatabase,
  prepareArchiveSchema,
  runArchive,
  type ArchiveMode,
  type ArchiveResult,
} from './research-archive.js';

const MB = 1024 * 1024;
const mb = (b: number | null | undefined) => (b == null ? 'n/a' : `${(b / MB).toFixed(1)} MB`);

function parseArgs(argv: string[]) {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const modes = (['dry-run', 'report', 'archive', 'verify', 'prune'] as ArchiveMode[]).filter((m) => flag(m));
  if (modes.length > 1) throw new ArchiveSafetyError(`Choose one mode, got: ${modes.join(', ')}`);
  const hot = value('compact-hot-hours');
  return {
    mode: modes[0] ?? ('dry-run' as ArchiveMode),
    confirmDelete: flag('confirm-delete'),
    batchSize: value('batch-size') ? Number(value('batch-size')) : env.ARCHIVE_BATCH_SIZE,
    tables: value('tables')?.split(',').filter(Boolean),
    full: flag('full'),
    json: flag('json'),
    compactHotHours: hot ? Number(hot) : COMPACT_RESEARCH_FLOOR_HOURS,
    maxBatches: value('max-batches') ? Number(value('max-batches')) : undefined,
  };
}

function printReport(r: ArchiveResult): void {
  const b = r.storageBefore;
  const a = r.storageAfter;
  console.log(`\n=== Research archive: ${r.mode} — ${r.status} (verification ${r.verification}) ===`);
  if (r.error) console.log(`ERROR: ${r.error}`);
  console.log(`Railway DB size:        ${mb(b?.databaseBytes)} -> ${mb(a?.databaseBytes)}`);
  console.log(`Railway used (DB+WAL):  ${mb(b?.usedBytes)} -> ${mb(a?.usedBytes)}  state ${r.storageState}`);
  console.log(`Estimated volume:       ${mb(b?.estimatedVolumeBytes)} -> ${mb(a?.estimatedVolumeBytes)} of ${env.STORAGE_LIMIT_MB} MB`);
  console.log(`Local archive size:     ${mb(r.archiveBytes)}`);
  console.log(`Rows selected/exported/verified/deleted: ${r.rowsSelected} / ${r.rowsExported} / ${r.rowsVerified} / ${r.rowsDeleted}`);
  console.log(`Estimated space ${r.mode === 'prune' ? 'reclaimed (reusable)' : 'reclaimable'}: ${mb(r.estimatedReclaimBytes)}`);
  console.log(`Archival recommended (storage >= WARNING): ${r.archivalRecommended ? 'yes' : 'no'}`);
  const rows = Object.entries(r.tables).sort(([x], [y]) => x.localeCompare(y));
  if (rows.length) {
    console.log('\ntable                              class            source   select   export   verify   delete  reclaim  note');
    for (const [name, t] of rows) {
      console.log(
        `${name.padEnd(34)} ${t.dataClass.padEnd(15)} ${String(t.sourceRows ?? '').padStart(7)} ${String(t.selected).padStart(8)} ${String(t.exported).padStart(8)} ${String(t.verified).padStart(8)} ${String(t.deleted + t.childrenDeleted).padStart(8)} ${mb(t.estimatedReclaimBytes).padStart(9)}  ${t.skipped ?? ''}${t.mismatches ? ` MISMATCHES=${t.mismatches}` : ''}`,
      );
    }
  }
  if (r.mode === 'prune') {
    console.log('\nDeleted rows free space inside table files (reused by new writes); the volume figure does not shrink without VACUUM FULL.');
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.batchSize) || args.batchSize < 10) throw new ArchiveSafetyError('--batch-size must be >= 10');
  if (!Number.isFinite(args.compactHotHours) || args.compactHotHours < MIN_COMPACT_HOT_HOURS) {
    throw new ArchiveSafetyError(`--compact-hot-hours must be >= ${MIN_COMPACT_HOT_HOURS}`);
  }
  const sourceUrl = env.ARCHIVE_SOURCE_DATABASE_URL;
  const archiveUrl = env.ARCHIVE_DATABASE_URL;
  if (!sourceUrl) throw new ArchiveSafetyError('ARCHIVE_SOURCE_DATABASE_URL is not set');
  if (!archiveUrl && args.mode !== 'report') throw new ArchiveSafetyError('ARCHIVE_DATABASE_URL is not set');
  if (archiveUrl) assertDistinct(sourceUrl, archiveUrl);

  const source = connectSource(sourceUrl, { readOnly: !WRITE_MODES.includes(args.mode) });
  let archive = null;
  try {
    if (archiveUrl) {
      archive = connectArchive(archiveUrl);
      if (args.mode !== 'report') {
        await ensureArchiveDatabase(archiveUrl);
        await prepareArchiveSchema(archive);
      }
    }
    const result = await runArchive(
      { source, archive },
      {
        mode: args.mode,
        batchSize: args.batchSize,
        confirmDelete: args.confirmDelete,
        tables: args.tables,
        full: args.full,
        compactHotHours: args.compactHotHours,
        maxBatches: args.maxBatches,
        log: args.json ? undefined : (m) => console.log(m),
      },
    );
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
    return result.status === 'SUCCEEDED' ? 0 : 1;
  } finally {
    await source.end().catch(() => undefined);
    if (archive) await archive.end().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`archive:research failed: ${(err as Error).message}`);
    process.exit(1);
  });
