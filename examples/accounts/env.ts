import { defineEnv } from 'void/env';
import { z } from 'zod';
export const env = defineEnv({ BETTER_AUTH_SECRET: z.string().min(32) });
