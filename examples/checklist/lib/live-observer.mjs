import { connectLiveStream } from 'void/live/client';
import { ChecklistObserver } from './observer.mjs';

export function observeChecklist(room, read, changed, { eventSource = globalThis.EventSource, fetch: send = globalThis.fetch, retryDelay = 1000 } = {}) {
  const observer = new ChecklistObserver(read, changed, room);
  const client = connectLiveStream('/live', {
    retryDelay,
    eventSource: class extends eventSource {
      constructor(url, options) {
        super(url, options); this.addEventListener('error', () => observer.disconnected());
      }
    },
    onError: error => { if (error instanceof Error && observer.registered) void observer.refresh(); },
    fetch: async (input, init) => {
      const epoch = observer.epoch;
      try {
        const response = await send(input, init);
        // Native Void uses this supported hook for initial and repeat registration.
        void observer.control(response, epoch).catch(() => { if (epoch === observer.epoch) observer.failed(); });
        return response;
      } catch (error) { if (epoch === observer.epoch) observer.failed(); throw error; }
    },
  });
  void client.subscribe({ id: 'board', topic: room, onEvent: event => observer.hint(event) }).catch(() => observer.failed());
  return { observer, close() { observer.close(); client.close(); } };
}
