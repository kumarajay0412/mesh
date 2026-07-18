import { LinearClient } from '@linear/sdk'
import type { RawTicket } from './types'
import { log } from '../log'

const l = log('sync:linear')

// Page size × nested comment depth is bounded by Linear's query-complexity
// budget; 25×50 sits comfortably under it.
const PAGE = 25

/** Long walks must survive transient gateway errors (Linear rides Cloudflare;
 *  502s happen). Hard rate-limit errors are NOT retried here — the request
 *  budget is hourly, so the run fails fast and the scheduler's next pass
 *  completes the walk once the window resets. */
const TRANSIENT = /\b(502|503|504)\b|bad gateway|econnreset|etimedout|fetch failed|socket hang up/i

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 2_000
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      if (i >= attempts || !TRANSIENT.test(msg)) throw e
      l.warn(`${label}: transient error (attempt ${i}/${attempts}), retrying in ${delay / 1000}s — ${msg.slice(0, 120)}`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 3, 60_000)
    }
  }
}

/** ONE request per page — everything nested. The SDK's lazy relations
 *  (issue.comments(), comment.user, …) cost a request EACH; walking a
 *  workspace that way burns thousands of requests against a 2,500/hr budget.
 *  This raw query fetches 25 issues fully hydrated per request. */
const ISSUES_QUERY = `
query MeshIssues($after: String, $filter: IssueFilter) {
  issues(first: ${PAGE}, after: $after, filter: $filter, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description createdAt updatedAt completedAt priorityLabel
      state { name }
      project { name slugId }
      labels(first: 25) { nodes { name } }
      attachments(first: 20) { nodes { url } }
      comments(first: 50) { nodes { body createdAt user { name } } }
    }
  }
}`

interface GqlIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  priorityLabel: string | null
  state: { name: string } | null
  project: { name: string; slugId: string } | null
  labels: { nodes: { name: string }[] }
  attachments: { nodes: { url: string }[] }
  comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] }
}

interface GqlPage {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: GqlIssue[]
  }
}

function toTicket(n: GqlIssue): RawTicket {
  return {
    source: 'linear',
    ticketId: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    state: n.state?.name,
    // Project ride along as a queryable label: `project:<slugId>` matches the
    // tail of the Linear project URL (…/project/<name>-<slugId>/…).
    labels: [
      ...n.labels.nodes.map((x) => x.name),
      ...(n.project ? [`project:${n.project.slugId}`, `project-name:${n.project.name}`] : []),
    ],
    priority: n.priorityLabel ?? undefined,
    urls: [...n.attachments.nodes.map((a) => a.url), ...extractUrls(n.description ?? '')],
    comments: n.comments.nodes.map((c) => ({
      body: c.body,
      author: c.user?.name,
      createdAt: new Date(c.createdAt).getTime(),
    })),
    createdAt: new Date(n.createdAt).getTime(),
    updatedAt: new Date(n.updatedAt).getTime(),
    completedAt: n.completedAt ? new Date(n.completedAt).getTime() : undefined,
  }
}

/**
 * Incremental Linear pull (Section 7.1): issues with updatedAt > cursor, WITH their
 * comments — the investigation narrative lives in the comments.
 *
 * CURSOR CONTRACT: pages arrive newest-first, so the cursor must NOT be
 * persisted per page — a crash mid-walk would strand the never-fetched older
 * tail behind an already-advanced cursor. The max updatedAt seen is returned;
 * the caller persists it ONLY after the walk completes. Crash ⇒ re-walk,
 * absorbed by idempotent upserts + the skip-unchanged fast path.
 */
export async function fetchLinearSince(
  apiKey: string,
  cursor: string | undefined,
  onPage: (tickets: RawTicket[]) => Promise<void>,
): Promise<string | undefined> {
  const client = new LinearClient({ apiKey })
  const gql = client.client // underlying graphql-request client
  let after: string | null = null
  let pages = 0
  let globalMax = cursor ? new Date(cursor).getTime() : 0

  type Vars = Record<string, unknown> & {
    after: string | null
    filter?: { updatedAt: { gt: string } }
  }

  for (;;) {
    const variables: Vars = {
      after,
      filter: cursor ? { updatedAt: { gt: new Date(cursor).toISOString() } } : undefined,
    }
    const data: GqlPage | undefined = await withRetry(
      'issues page',
      async () => (await gql.rawRequest<GqlPage, Vars>(ISSUES_QUERY, variables)).data,
    )
    if (!data) break

    const tickets = data.issues.nodes.map(toTicket)
    for (const t of tickets) if (t.updatedAt > globalMax) globalMax = t.updatedAt

    if (tickets.length > 0) {
      await onPage(tickets)
      pages++
    }

    if (!data.issues.pageInfo.hasNextPage) break
    after = data.issues.pageInfo.endCursor
  }

  l.info(`fetched ${pages} page(s) since ${cursor ?? 'beginning'}`)
  return globalMax > 0 ? new Date(globalMax).toISOString() : cursor
}

export function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []
}

/** Resolve a human identifier (ENG-2903) → issue UUID via GraphQL search. */
export async function findIssueIdByIdentifier(apiKey: string, identifier: string): Promise<string | null> {
  const client = new LinearClient({ apiKey })
  const m = identifier.match(/^([A-Za-z]+)-(\d+)$/)
  if (!m) return null
  const issues = await client.issues({
    first: 1,
    filter: { team: { key: { eq: m[1].toUpperCase() } }, number: { eq: Number(m[2]) } },
  })
  return issues.nodes[0]?.id ?? null
}

/** The one Linear WRITE Mesh performs — always behind the approval gate (Section 10). */
export async function postLinearComment(apiKey: string, issueId: string, body: string): Promise<void> {
  const client = new LinearClient({ apiKey })
  await client.createComment({ issueId, body })
  l.info(`posted comment on ${issueId} (${body.length} chars)`)
}
