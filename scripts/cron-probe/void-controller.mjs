// Private qualification entrypoint; ordinary cron admission remains closed.
import { serveVoidController } from './void-controller-session.mjs';
const [source, slot, output, minutes = '12'] = process.argv.slice(2);
await serveVoidController(source, slot, output, Number(minutes));
