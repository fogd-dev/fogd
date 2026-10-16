import { defineHandler } from 'void';
import { db, desc } from 'void/db';
import { messages } from '@schema';

export const GET = defineHandler(async () => db.select().from(messages).orderBy(desc(messages.id)));
