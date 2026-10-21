export default {
  kind: 'replacement', initial: 'old', minutes: 20,
  releases: { old: { gate: null, next: 'new' }, new: { gate: 'after-migration', next: 'final' }, final: { gate: 'before-publication', next: null } },
};
