import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReplyFailure } from '../src/contract.ts'
import { FailureLog } from '../src/failures.ts'

function failure(n: number, text = 'hi'): ReplyFailure {
  return {
    id: `f${n}`, at: n, itemId: 'tab:leaf', agent: 'claude', kind: 'finished', where: 'w / t',
    reply: { type: 'text', text }, code: 'terminal_rejected', message: 'no', keysSent: [], screen: null, draft: null
  }
}

function memoryLog(stored: unknown = undefined) {
  const saves: ReplyFailure[][] = []
  const log = new FailureLog({
    load: async () => stored,
    save: async (list) => void saves.push(list),
    log: () => undefined
  })
  return { log, saves }
}

test('keeps the newest 50 failures, newest first, and saves each change', async () => {
  const { log, saves } = memoryLog([failure(0)])
  for (let n = 1; n <= 55; n++) {
    await log.add(failure(n))
  }
  const list = await log.list()
  assert.equal(list.length, 50)
  assert.deepEqual([list[0]!.id, list.at(-1)!.id], ['f55', 'f6'])
  assert.equal(saves.length, 55)
})

test('trims a long typed reply, and clear empties the stored list', async () => {
  const { log, saves } = memoryLog()
  await log.add(failure(1, 'x'.repeat(5000)))
  const [first] = await log.list()
  assert.equal(first!.reply.type === 'text' && first!.reply.text.length, 2001)
  await log.clear()
  assert.deepEqual([await log.list(), saves.at(-1)], [[], []])
})

test('an unreadable or missing stored list starts empty', async () => {
  const broken = new FailureLog({ load: async () => { throw new Error('gone') }, save: async () => undefined, log: () => undefined })
  assert.deepEqual(await broken.list(), [])
  assert.deepEqual(await memoryLog('not a list').log.list(), [])
})
