// Recipient extraction backend — reads the payee name from a cropped strip.
//
// This is the swappable backend boundary (see the M4 spec). The current backend
// is cloud vision via the Claude API; a future fully-local backend (on-device
// OCR, or crop-and-type) can implement the same `extractRecipient(stripPath)`
// contract returning { recipient: string, confidence: 'high'|'medium'|'low' }.
const fs = require('fs');

const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.Anthropic || sdk.default || sdk;

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

let _client;
function client() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    _client = new Anthropic();
  }
  return _client;
}

// True when extraction can actually run (key present).
function isAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function extractRecipient(stripPath) {
  const b64 = fs.readFileSync(stripPath).toString('base64');
  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 200,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const textBlock = (resp.content || []).find((b) => b.type === 'text');
  const parsed = JSON.parse(textBlock.text);
  return {
    recipient: String(parsed.recipient || '').trim(),
    confidence: parsed.confidence || 'low',
  };
}

module.exports = { extractRecipient, isAvailable, MODEL, PROMPT, SCHEMA };
