import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyRow, allyRow, bridgeRow, bridgeHint, allOk } from '../extension/lib/readiness.js';

test('keyRow: missing key is bad with a Settings fix', () => {
  const r = keyRow({ anthropicApiKey: '' });
  assert.equal(r.state, 'bad');
  assert.match(r.text, /not set/i);
  assert.deepEqual(r.fix, { label: 'Settings', action: 'settings' });
});

test('keyRow: null settings counts as missing', () => {
  assert.equal(keyRow(null).state, 'bad');
});

test('keyRow: present key is ok with no fix', () => {
  const r = keyRow({ anthropicApiKey: 'sk-ant-x' });
  assert.equal(r.state, 'ok');
  assert.equal(r.fix, null);
});

test('allyRow: null count is checking', () => {
  assert.equal(allyRow(null, 'Ally Bank').state, 'checking');
});

test('allyRow: zero tabs is bad with an Open fix naming the bank', () => {
  const r = allyRow(0, 'Ally Bank');
  assert.equal(r.state, 'bad');
  assert.match(r.text, /transaction page/i);
  assert.deepEqual(r.fix, { label: 'Open Ally Bank', action: 'open-bank' });
});

test('allyRow: one or more tabs is ok', () => {
  assert.equal(allyRow(2, 'Ally Bank').state, 'ok');
  assert.equal(allyRow(2, 'Ally Bank').fix, null);
});

test('bridgeRow: null result is checking', () => {
  assert.equal(bridgeRow(null).state, 'checking');
});

test('bridgeRow: ok result shows tool count', () => {
  const r = bridgeRow({ ok: true, mode: 'local', tools: 61 });
  assert.equal(r.state, 'ok');
  assert.match(r.text, /61 tools/);
  assert.equal(r.fix, null);
});

test('bridgeRow: failure uses bridgeHint and offers Settings', () => {
  const r = bridgeRow({ ok: false, mode: 'local', error: 'Local MCP server unreachable at http://127.0.0.1:8642/mcp — start it (Failed to fetch)' });
  assert.equal(r.state, 'bad');
  assert.match(r.text, /not running/i);
  assert.deepEqual(r.fix, { label: 'Settings', action: 'settings' });
});

test('bridgeRow: official mode not connected says so', () => {
  const r = bridgeRow({ ok: false, mode: 'official', error: 'not connected' });
  assert.equal(r.state, 'bad');
  assert.match(r.text, /not connected/i);
  assert.deepEqual(r.fix, { label: 'Connect', action: 'settings' });
});

test('bridgeHint: maps known failures to cause and fix', () => {
  assert.match(bridgeHint('Local MCP server unreachable at x'), /not running.*install-autostart\.sh/i);
  assert.match(bridgeHint('MCP initialize HTTP 400 Invalid Origin'), /extension.s ID.*README/i);
  assert.match(bridgeHint('MCP tools/list HTTP 401 Unauthorized'), /Monarch session expired.*login_setup\.py/i);
  assert.match(bridgeHint('timed out after 4s'), /timed out/i);
});

test('bridgeHint: unknown error is passed through, trimmed to 90 chars', () => {
  const long = 'x'.repeat(200);
  assert.equal(bridgeHint(long).length, 90);
  assert.equal(bridgeHint(''), 'Unknown error');
});

test('allOk: true only when every row is ok', () => {
  assert.equal(allOk([{ state: 'ok' }, { state: 'ok' }]), true);
  assert.equal(allOk([{ state: 'ok' }, { state: 'checking' }]), false);
  assert.equal(allOk([{ state: 'ok' }, { state: 'bad' }]), false);
  assert.equal(allOk([]), false);
});
