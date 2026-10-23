import { startController } from './startup.mjs';
import { durableControllerStartup } from './durable-startup.mjs';

await startController(undefined, durableControllerStartup());
