import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexTranscripts, pendingCodexQuestion, readLastStatus } from '../src/sources.ts'

const line = (payload: object) => JSON.stringify({ type: 'response_item', payload })
const userMessage = line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] })
const askCall = line({
  type: 'function_call',
  name: 'request_user_input_async',
  arguments: JSON.stringify({ questions: [{ title: 'Which color?', options: ['Red', 'Green', 'Blue'] }] }),
  call_id: 'call_1'
})
const noise = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })
const answer = line({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<send_user_message_question_reply call_id="call_1">Red</send_user_message_question_reply>' }]
})

test('a question call after the last user message is pending, string options included', () => {
  assert.deepEqual(pendingCodexQuestion([userMessage, askCall, noise]), {
    title: 'Which color?',
    multiSelect: false,
    options: [
      { index: 1, label: 'Red' },
      { index: 2, label: 'Green' },
      { index: 3, label: 'Blue' }
    ]
  })
})

test('a user message after the question answers it', () => {
  assert.equal(pendingCodexQuestion([userMessage, askCall, answer, noise]), null)
  assert.equal(pendingCodexQuestion([userMessage, noise]), null)
})

test('finds a Codex rollout by session id when the hook entry has no transcript path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dc-codex-'))
  try {
    const dir = join(root, '2026', '09', '27')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'rollout-2026-09-27T18-59-53-abc.jsonl'), [userMessage, askCall, ''].join('\n'))
    const question = await new CodexTranscripts(root).pendingQuestion({ paneKey: 'p', providerSession: { id: 'abc' } })
    assert.equal(question?.title, 'Which color?')
    assert.equal(await new CodexTranscripts(root).pendingQuestion({ paneKey: 'p', providerSession: { id: 'nope' } }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing hook file reads as no entries', async () => {
  assert.equal((await readLastStatus('/nonexistent/last-status.json')).size, 0)
})
