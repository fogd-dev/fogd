import { startController } from './startup.mjs';
import { archiveControllerStartup } from './durable-startup.mjs';

await startController(undefined, archiveControllerStartup());
