import { defineHandler } from 'void';
import { page } from '../lib/page.mjs';
export const GET = defineHandler(c => c.html(page));
