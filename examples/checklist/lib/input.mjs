export const validId = value => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
export function parseOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.itemId)) return null;
  if (value.kind === 'add' && Object.keys(value).sort().join() === 'itemId,kind,text' &&
      typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 160) {
    return { kind: 'add', itemId: value.itemId, text: value.text };
  }
  if (value.kind === 'set' && Object.keys(value).sort().join() === 'checked,itemId,kind' && typeof value.checked === 'boolean') {
    return { kind: 'set', itemId: value.itemId, checked: value.checked };
  }
  return null;
}

