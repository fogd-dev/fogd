import { createHash } from 'node:crypto';

// Stable findings require a fresh explicit acknowledgment when observations change.
export const recoveryReview = receipt => createHash('sha256').update(JSON.stringify({ first: receipt.firstObservation || null, observed: receipt.observation || null, diagnoses: receipt.diagnoses || [], checkError: receipt.checkError || null })).digest('hex');
