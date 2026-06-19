import { getWebsiteByBaseUrl } from '../repositories/website.repository.js';
import { getRunningRun, setNextSyncAt } from '../repositories/sync.repository.js';
import { runSync, isSyncRunningInProcess } from './sync.service.js';
import { config } from '../config/env.js';
import { logger } from '../shared/logger/logger.js';

// Optional automatic re-sync (default OFF). Uses a recurring lightweight check
// instead of one long timer: a 30-day setTimeout would overflow the ~24.8-day
// (2^31 ms) limit, so we re-check every few hours and run when next_sync_at is due.

const BASE_URL = 'https://easepetvet.com/';
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // re-check 4x/day

let timer = null;

function computeNextSyncAt() {
  const { intervalDays, runHour, runMinute } = config.admin.sync;
  const d = new Date(Date.now() + (intervalDays > 0 ? intervalDays : 30) * DAY_MS);
  d.setHours(Number.isFinite(runHour) ? runHour : 2, Number.isFinite(runMinute) ? runMinute : 0, 0, 0);
  return d;
}

async function checkAndRun() {
  try {
    const website = await getWebsiteByBaseUrl(BASE_URL);
    if (!website) return;

    if (!website.next_sync_at) {
      await setNextSyncAt(website.id, computeNextSyncAt());
      return;
    }

    const due = new Date(website.next_sync_at).getTime() <= Date.now();
    if (!due) return;
    if (isSyncRunningInProcess()) return;
    if (await getRunningRun(website.id)) return;

    logger.info({ nextSyncAt: website.next_sync_at }, 'Scheduled sync due; starting');
    await runSync('scheduled'); // updates next_sync_at on completion
  } catch (err) {
    logger.warn({ err: err.message }, 'Scheduled sync check failed');
  }
}

function arm() {
  timer = setTimeout(async () => {
    await checkAndRun();
    arm();
  }, CHECK_EVERY_MS);
  // Do not keep the event loop alive solely for this timer.
  if (timer && typeof timer.unref === 'function') timer.unref();
}

// Starts the scheduler if auto-sync is enabled. Safe to call once at startup.
export function startSyncScheduler() {
  if (!config.admin.sync.autoEnabled) {
    logger.info('Automatic website sync is disabled (ADMIN_SYNC_AUTO_ENABLED=false)');
    return;
  }
  if (timer) return;
  logger.info(
    { intervalDays: config.admin.sync.intervalDays, runHour: config.admin.sync.runHour, runMinute: config.admin.sync.runMinute },
    'Automatic website sync enabled',
  );
  // First check shortly after startup, then on the recurring cadence.
  checkAndRun().finally(arm);
}

export function stopSyncScheduler() {
  if (timer) { clearTimeout(timer); timer = null; }
}
