// Native checklist probes also create live topic/connection objects. Identify only
// the fresh board object when choosing its owner for a fault or eviction drill.
export function newChecklistRooms(states, known) {
  return states.flatMap(({host,state}) => state.residents
    .filter(id => id.startsWith('ChecklistWs:') && !known.has(id))
    .map(id => ({host,id})));
}
