// Recipient extraction via the Anthropic Messages API, called from the service
// worker (CORS bypassed via host_permissions + the direct-browser-access header).
// Ports the M4 prompt + schema.
import { b64FromBlob } from '../lib/util.js';

const MODEL = 'claude-opus-4-8';
const PROMPT =
  "This image is the 'Pay to the order of' line cropped from a paper check. " +
  'Return the payee name exactly as written, with normal capitalization. ' +
  "If you cannot read it, return an empty recipient and confidence 'low'.";
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recipient: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['recipient', 'confidence'],
};

export async function extractRecipient(stripBlob, apiKey) {
  const data = await b64FromBlob(stripBlob);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'high' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`anthropic ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const textBlock = (json.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('no text block in response');
  const parsed = JSON.parse(textBlock.text);
  return { recipient: String(parsed.recipient || '').trim(), confidence: parsed.confidence || 'low' };
}
