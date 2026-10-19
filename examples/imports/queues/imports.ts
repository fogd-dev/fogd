import { defineQueue } from 'void';
import { processJob, failed } from '../lib/process.mjs';
export const maxBatchSize = 1;
export const maxBatchTimeout = 1;
export const maxRetries = 1;
export const retryDelay = 1;
export default defineQueue<{ id: string }>(async (batch, env) => {
  for (const message of batch.messages) {
    try { await processJob(env.DB, env.STORAGE, message); }
    catch (error) {
      await failed(env.DB, message.body.id, message.attempts > maxRetries);
      throw error;
    }
  }
});
