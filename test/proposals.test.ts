import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProposals, parseSuggestion, Suggester, suggestInput } from '../src/proposals.ts'

test('a Next: line in the last paragraph is the proposal', () => {
  assert.deepEqual(parseProposals('Done.\n\n1. Fixed it\n2. Tested it\n\nNext: send the table to the mobile team.'), [
    'send the table to the mobile team.'
  ])
  assert.deepEqual(parseProposals('Merged.\n**Next:** run `npm test` and paste the failure.'), [
    'run `npm test` and paste the failure.'
  ])
  assert.deepEqual(parseProposals('Next steps: open the PR'), ['open the PR'])
  assert.deepEqual(parseProposals('The build passed. Next: open the PR'), ['open the PR'])
  assert.deepEqual(parseProposals('The context: next is unclear.'), [])
})

test('a Next: line that quotes replies proposes the quoted replies', () => {
  assert.deepEqual(
    parseProposals(`Next: reply "fix repos" and I'll switch Proxmox to the free no-subscription repo (about 5 minutes).`),
    ['fix repos']
  )
  assert.deepEqual(parseProposals('Next: reply "read NTFS dates" (about 1 minute) or "skip, wipe".'), [
    'read NTFS dates',
    'skip, wipe'
  ])
  assert.deepEqual(parseProposals('Next: say “ship it”, or “wait”.'), ['ship it', 'wait'])
  assert.deepEqual(parseProposals('Next: rename "foo.ts" to "bar.ts".'), ['rename "foo.ts" to "bar.ts".'])
})

test('a Next: line earlier in the message does not count', () => {
  assert.deepEqual(parseProposals('Next: build it.\n\nI built it and it works.'), [])
})

test('a closing numbered list gives its first 3 item heads', () => {
  const message = [
    'Two ways forward:',
    '',
    '1. **Retry** the import with the new limit',
    '   - takes about 30 min',
    '2. Drop the GDB import',
    '',
    '3. Ask the data team',
    '4. Do nothing'
  ].join('\n')
  assert.deepEqual(parseProposals(message), ['Retry the import with the new limit', 'Drop the GDB import', 'Ask the data team'])
})

test('a numbered list still ends the message when one question follows it', () => {
  assert.deepEqual(parseProposals('Options:\n1. Red\n2. Blue\n\nWhich one?'), ['Red', 'Blue'])
})

test('a numbered list followed by prose, or not starting at 1, gives nothing', () => {
  assert.deepEqual(parseProposals('Steps:\n1. Build\n2. Run\n\nThe two decisions from before are still open.'), [])
  assert.deepEqual(parseProposals('Then:\n3. Build\n4. Run'), [])
  assert.deepEqual(parseProposals('```\n1. not a list\n```'), [])
  assert.deepEqual(parseProposals(null), [])
})

test('reads the reply list out of a fenced model answer', () => {
  assert.deepEqual(parseSuggestion('```json\n["Ship it", "**Add** tests", 3, "", "a", "b"]\n```'), ['Ship it', 'Add tests', 'a'])
  assert.throws(() => parseSuggestion('I cannot help with that.'), /did not return a list/)
})

test('the model input carries the prompt and the tail of the message', () => {
  const input = suggestInput({ prompt: 'fix login', lastMessage: `${'x'.repeat(9000)}END` })
  assert.match(input, /^The user's last prompt:\nfix login\n\nThe agent's last message:\nx+END$/)
  assert.ok(input.length < 9100)
})

test('asks once per key and retries after a failure', async () => {
  const inputs: string[] = []
  let fail = true
  const suggester = new Suggester(async (input) => {
    inputs.push(input)
    if (fail) {
      fail = false
      throw new Error('offline')
    }
    return '["Ship it"]'
  })
  const item = { prompt: null, lastMessage: 'Fixed.' }
  await assert.rejects(suggester.suggest('a@1', item), /offline/)
  assert.deepEqual(await suggester.suggest('a@1', item), ['Ship it'])
  assert.deepEqual(await suggester.suggest('a@1', item), ['Ship it'])
  await suggester.suggest('a@2', item)
  assert.equal(inputs.length, 3)
})
