export const archiveHeld = app => Boolean(app?.archive || app?.archiveRecovery);

export function assertArchiveRecoveryComplete(app) {
  if (archiveHeld(app)) throw Object.assign(new Error('App is archived or awaiting explicit archive recovery approval'), { code: 'APP_ARCHIVE_HELD' });
}
