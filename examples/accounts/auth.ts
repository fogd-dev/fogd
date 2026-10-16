import { defineAuth } from 'void/auth';
import { password } from './src/password.ts';

export default defineAuth({ emailAndPassword: { enabled: true, password } });
