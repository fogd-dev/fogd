// Call only after the durable reply. Hints never determine operation success.
export async function publishHint(publish, deadlineMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(publish).then(() => 'published', () => 'failed'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timed-out'), deadlineMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
