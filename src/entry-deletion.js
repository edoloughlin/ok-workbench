'use strict';
const fsDefault = require('node:fs/promises');

// recordDir and recovery.json already exist. Never remove the record before
// staged content has either been restored or successfully cleaned up.
async function stageDeletion({ target, parentIndex, recordDir, staged, temporary, original, updated, mode, revalidate, log, fs = fsDefault }) {
  let moved = false;
  try {
    await revalidate();
    await fs.rename(target, staged); moved = true;
    if (updated !== original) {
      await fs.writeFile(temporary, updated, { flag: 'wx', mode });
      if ((await fs.readFile(parentIndex, 'utf8')) !== original) throw Object.assign(new Error('Parent index changed during deletion'), { code: 'ENTRY_CONFLICT', status: 409 });
      await fs.rename(temporary, parentIndex);
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (moved) {
      try {
        const occupied = await fs.lstat(target).then(() => true, problem => problem.code === 'ENOENT' ? false : Promise.reject(problem));
        if (occupied) throw new Error('Original path is occupied');
        await fs.rename(staged, target);
      } catch (rollback) {
        log('deletion recovery required', { recordDir, error: rollback.message });
        throw Object.assign(new Error('Deletion requires manual recovery; consult server logs'), { code: 'RECOVERY_REQUIRED', status: 409 });
      }
    }
    await fs.rm(recordDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  try { await fs.rm(staged, { recursive: true, force: true }); await fs.rm(recordDir, { recursive: true, force: true }); }
  catch (error) { log('deletion committed; recovery cleanup required', { recordDir, error: error.message }); }
}
module.exports = { stageDeletion };
