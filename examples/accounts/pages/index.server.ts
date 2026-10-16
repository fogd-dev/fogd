import { defineHandler, type InferProps } from 'void';
import { getUser } from 'void/auth';
export const loader = defineHandler(() => { const user = getUser(); return { user: user ? { email: user.email } : null }; });
export type Props = InferProps<typeof loader>;
