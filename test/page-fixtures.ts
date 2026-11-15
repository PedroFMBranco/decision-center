// A FeedSnapshot covering every state the page draws. `scripts/preview.ts`
// serves it so the page can be checked without live agents.
import { API_VERSION, type FeedItem, type FeedSnapshot } from '../src/contract.ts'

const MIN = 60_000

function item(overrides: Partial<FeedItem> & Pick<FeedItem, 'id' | 'kind'>, now: number): FeedItem {
  return {
    agent: 'claude',
    state: overrides.kind === 'finished' ? 'done' : overrides.kind === 'closed' ? 'closed' : 'waiting',
    project: 'app',
    cwd: `/code/${overrides.project ?? 'app'}`,
    terminal: overrides.kind === 'closed' ? null : { kind: 'tmux', pane: '%1' },
    title: 'Untitled session',
    prompt: null,
    lastMessage: null,
    question: null,
    permission: null,
    proposals: [],
    canSuggest: false,
    since: now,
    updatedAt: now,
    unread: false,
    ...overrides
  }
}

function longMessage(): string {
  let text = 'The slow first load is fixed and the change is in review.\n\n## What changed\n\n'
  text += '- **The cache was never read on first load.** Cached reads now start immediately.\n- **A cold start fetched every image twice.** The image cache is keyed by version.\n\n'
  text += '```\nfirst-load p50  412 ms → 188 ms\nfirst-load p95  1.9 s  → 640 ms\n```\n\n'
  for (let run = 1; run <= 6; run++) {
    text += `Run ${run}: the cache answered after ${140 + run * 9} ms and served ${1200 + run * 37} items before the network answered.\n\n`
  }
  return text + 'Next: wait for the review, then run the load test again.'
}

export function fixtureItems(now = Date.now()): FeedItem[] {
  return [
    item({
      id: 'q-single', kind: 'question', project: 'web-app', title: 'search planning', unread: true, since: now - 2 * MIN,
      lastMessage: '**The filters work is merged into `release-2` at `d3ee4bd`.** CI passes.\n\nSearch needs a base branch before I start.',
      question: {
        title: 'Which branch should search build on?', multiSelect: false,
        options: [
          { index: 1, label: 'release-2', description: 'Includes the filters work. Recommended.' },
          { index: 2, label: 'main', description: 'Clean, but the filters work must be rebased in later.' },
          { index: 3, label: 'New branch from d3ee4bd' }
        ]
      }
    }, now),
    item({
      id: 'q-codex', kind: 'question', agent: 'codex', state: 'done', project: 'billing-api', title: 'gates', unread: true, since: now - 5 * MIN,
      lastMessage: 'The four follow-ups are on `invoice-followups`. Before I mark it ready, pick the gates to run.',
      question: {
        title: 'Which gate should run before I mark it ready?', multiSelect: false,
        options: [
          { index: 1, label: 'Lint + types', description: 'About 40 s' },
          { index: 2, label: 'Unit tests', description: 'About 3 min' }
        ]
      }
    }, now),
    item({
      id: 'q-multi', kind: 'question', project: 'infra', title: 'release gates', since: now - 7 * MIN,
      lastMessage: 'Pick the checks to run before the release.',
      question: {
        title: 'Which checks should run?', multiSelect: true,
        options: [
          { index: 1, label: 'Lint + types' },
          { index: 2, label: 'Unit tests' },
          { index: 3, label: 'E2E on the live stack', description: 'About 14 min' }
        ]
      }
    }, now),
    item({
      id: 'q-parts', kind: 'question', project: 'storefront', title: 'rollout', since: now - 8 * MIN,
      lastMessage: 'Two decisions before the rollout.',
      question: {
        title: 'Which group goes first?', header: 'Group', multiSelect: false,
        options: [{ index: 1, label: 'Internal' }, { index: 2, label: 'Pilot' }],
        more: [
          { title: 'Which checks gate it?', header: 'Checks', multiSelect: true, options: [{ index: 1, label: 'Smoke' }, { index: 2, label: 'Load test' }, { index: 3, label: 'Manual QA' }] },
          { title: 'When?', header: 'When', multiSelect: false, options: [{ index: 1, label: 'Today' }, { index: 2, label: 'Monday' }] }
        ]
      }
    }, now),
    item({
      id: 'q-text', kind: 'question', agent: 'codex', state: 'done', project: 'legacy', title: 'naming', since: now - 9 * MIN,
      lastMessage: 'What should the new job be called?',
      question: { title: 'What should the new job be called?', multiSelect: false, options: [] }
    }, now),
    item({
      id: 'perm', kind: 'permission', project: 'infra', title: 'cleanup', unread: true, since: now - 4 * MIN,
      lastMessage: 'The test stack is stopped. Removing its data volume frees about 23 GB.',
      permission: { toolName: 'Bash', summary: 'docker volume rm teststack_data teststack_pg' }
    }, now),
    item({
      id: 'done-props', kind: 'finished', project: 'legacy', title: 'file conversion', unread: true, since: now - 6 * MIN,
      lastMessage: 'Uploads are now converted only by the conversion service.\n\n**What changed**\n- No local `convert` call left in the upload path.\n- `ConvertJob` retries twice.\n\nNext: run the same comparison on the staging bucket, or open the PR for review.',
      proposals: ['Run the same comparison on the staging bucket', 'Open the PR for review']
    }, now),
    item({
      id: 'done-replies', kind: 'finished', project: 'web-app', title: 'failing tests', since: now - 12 * MIN,
      lastMessage: 'The upgrade changed 14 packages. Three tests fail, all in the date helpers.',
      proposals: ['Run the tests and show me the first failure', 'Diff the lockfile and list the version bumps', 'Pin the upgraded package back and confirm tests pass']
    }, now),
    item({
      id: 'done-suggest', kind: 'finished', agent: 'codex', project: 'billing-api', title: 'API contracts', since: now - 41 * MIN,
      lastMessage: 'The contracts are finished on branch `api-contracts`, and `scripts/ci.sh` passes with every gate.',
      canSuggest: true
    }, now),
    item({
      id: 'done-reject', kind: 'finished', project: 'ops', title: 'half-typed composer', since: now - 50 * MIN,
      lastMessage: 'Done. Replies to this item fail in the preview, to show the error state.'
    }, now),
    item({
      id: 'done-outside', kind: 'finished', agent: 'codex', project: 'notes', title: 'outside tmux', since: now - 70 * MIN, terminal: null,
      lastMessage: 'This session runs in a terminal outside tmux, so the page shows it but cannot reply.'
    }, now),
    item({ id: 'done-long', kind: 'finished', project: 'web-app', title: 'slow first load', since: now - 130 * MIN, lastMessage: longMessage() }, now),
    item({
      id: 'closed', kind: 'closed', project: 'ops', title: 'disk cleanup', since: now - 95 * MIN,
      lastMessage: 'The local test stack is gone and about 23 GB is freed.\n\n| Removed | Freed |\n|---|---|\n| test volumes | 19.8 GB |\n| dangling images | 2.1 GB |'
    }, now)
  ]
}

export function fixtureSnapshot(items: FeedItem[], now = Date.now()): FeedSnapshot {
  return { version: API_VERSION, items, unreadCount: items.filter((i) => i.unread).length, generatedAt: now }
}
