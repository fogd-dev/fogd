export default {
  kind: 'failures', initial: 'fast', minutes: 35,
  releases: { fast: { gate: null, next: 'sparse' }, sparse: { gate: null, next: 'final' }, final: { artifact: 'fast', gate: null, next: null } },
};
