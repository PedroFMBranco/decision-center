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
  let text = 'The warm-gate fix for I-0018 is built and in review as R-0026.\n\n## What changed\n\n'
  text += '- **SYNTH-150k never engaged.** OPFS reads now start immediately.\n- **Cold start double-fetched tiles.** The tile cache is keyed by layer version.\n\n'
  text += '```\nwarm-gate p50  412 ms → 188 ms\nwarm-gate p95  1.9 s  → 640 ms\n```\n\n'
  for (let run = 1; run <= 6; run++) {
    text += `Run ${run}: the gate engaged after ${140 + run * 9} ms and served ${1200 + run * 37} features from OPFS before the network answered.\n\n`
  }
  return text + 'Next: wait for the R-0026 verdict, then re-run live session 2.'
}

export function fixtureItems(now = Date.now()): FeedItem[] {
  return [
    item({
      id: 'q-single', kind: 'question', project: 'v3-app', title: 'T7 planning', unread: true, since: now - 2 * MIN,
      lastMessage: '**M3 T6 (Cursor capture) is merged into `m3` at `d3ee4bd`.** CI passes.\n\nT7 needs a base branch before I start.',
      question: {
        title: 'Which branch should T7 build on?', multiSelect: false,
        options: [
          { index: 1, label: 'm3', description: 'Includes T6. Recommended.' },
          { index: 2, label: 'main', description: 'Clean, but T6 must be rebased in later.' },
          { index: 3, label: 'New branch from d3ee4bd' }
        ]
      }
    }, now),
    item({
      id: 'q-codex', kind: 'question', agent: 'codex', state: 'done', project: 'billing-api', title: 'gates', unread: true, since: now - 5 * MIN,
      lastMessage: 'The four follow-ups are on `m2-tf-followups`. Before I mark it ready, pick the gates to run.',
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
      id: 'q-parts', kind: 'question', project: 'v2-fe', title: 'rollout', since: now - 8 * MIN,
      lastMessage: 'Two decisions before the rollout.',
      question: {
        title: 'Which tenant goes first?', header: 'Tenant', multiSelect: false,
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
      permission: { toolName: 'Bash', summary: 'docker volume rm floci_data floci_pg' }
    }, now),
    item({
      id: 'done-props', kind: 'finished', project: 'legacy', title: 'W7 GDAL lambda', unread: true, since: now - 6 * MIN,
      lastMessage: 'Legacy now converts files only through the GDAL Lambda.\n\n**What changed**\n- No local `ogr2ogr` left in the upload path.\n- `ConvertJob` retries twice.\n\nNext: run the same comparison on the staging bucket, or open the PR for review.',
      proposals: ['Run the same comparison on the staging bucket', 'Open the PR for review']
    }, now),
    item({
      id: 'done-suggest', kind: 'finished', agent: 'codex', project: 'billing-api', title: 'T0 contracts', since: now - 41 * MIN,
      lastMessage: 'T0 is finished on branch `m2-t0-contracts`, and `scripts/ci.sh` passes with every gate.',
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
    item({ id: 'done-long', kind: 'finished', project: 'v3-app', title: 'I-0018 warm gate', since: now - 130 * MIN, lastMessage: longMessage() }, now),
    item({
      id: 'closed', kind: 'closed', project: 'ops', title: 'disk cleanup', since: now - 95 * MIN,
      lastMessage: 'The local test stack is gone and about 23 GB is freed.\n\n| Removed | Freed |\n|---|---|\n| floci volumes | 19.8 GB |\n| dangling images | 2.1 GB |'
    }, now)
  ]
}

export function fixtureSnapshot(items: FeedItem[], now = Date.now()): FeedSnapshot {
  return { version: API_VERSION, items, unreadCount: items.filter((i) => i.unread).length, generatedAt: now }
}
