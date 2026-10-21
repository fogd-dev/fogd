// PID1 owns no controller state or fleet. The driver runs and kills the separate
// immutable checkpoint controller while keeping this host process alive.
const timer = setInterval(() => {}, 3600000);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  clearInterval(timer); process.exit(0);
});
console.log('sealed qualification host ready');
