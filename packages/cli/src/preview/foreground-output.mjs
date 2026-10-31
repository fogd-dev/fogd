// Keep stream error ownership for the entire foreground lifetime, including
// errors that arrive after a successful readiness write callback.
export function previewForegroundOutput(cancel, stream = process.stdout) {
  let failure;
  const fail = () => {
    failure ??= Object.assign(new Error('Preview output unavailable; retain owner controls and resources'), { code: 'PREVIEW_OUTPUT_UNAVAILABLE' });
    cancel();
    return failure;
  };
  stream.on('error', fail); stream.on('close', fail);
  if (stream.destroyed || !stream.writable) fail();
  return {
    get failure() { return failure; },
    write(value) {
      if (failure || stream.destroyed || !stream.writable) return Promise.reject(failure ?? fail());
      return new Promise((resolve, reject) => {
        try { stream.write(JSON.stringify(value) + '\n', error => error ? reject(fail()) : resolve()); }
        catch { reject(fail()); }
      });
    },
    close() { stream.off('error', fail); stream.off('close', fail); },
  };
}
