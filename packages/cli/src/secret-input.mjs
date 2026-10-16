export async function readSecretInput(input = process.stdin) {
  if (input.isTTY) throw new Error('Supply a JSON object through standard input');
  input.setEncoding('utf8');
  let text = '';
  for await (const chunk of input) {
    text += chunk;
    if (Buffer.byteLength(text) > 65536) throw new Error('Secret input too large');
  }
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid secret JSON'); }
}
