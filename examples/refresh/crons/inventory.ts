import { defineScheduled } from 'void';
import { scheduledRefresh } from '../lib/refresh.mjs';
export const cron = '* * * * *';
export default defineScheduled((event, env) => scheduledRefresh('inventory', event, env));
