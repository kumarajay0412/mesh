import type { SourceId } from '@shared/types'

/** How to mint a token for each source.
 *
 *  The steps matter more than the deep link — provider settings pages get
 *  reorganised, so each guide names the menu path as well as the URL. Scopes
 *  are listed explicitly because "it didn't work" is nearly always a missing
 *  scope rather than a bad token, and because Mesh only ever asks for read
 *  access: nothing here grants Mesh the ability to write to your tools. */
export interface TokenGuide {
  /** where the token is created, in the provider's own words */
  where: string
  /** the button/link that opens it; omit when the URL is instance-specific */
  url?: string
  /** label for the open button */
  urlLabel?: string
  steps: string[]
  /** exact permission names to tick — the usual failure point */
  scopes?: string[]
  /** what the finished token looks like, so a wrong paste is obvious */
  looksLike?: string
  /** anything that will bite them */
  caveat?: string
}

export const TOKEN_GUIDES: Record<SourceId, TokenGuide> = {
  grafana: {
    where: 'Grafana → Administration → Users and access → Service accounts',
    urlLabel: 'Open service accounts',
    steps: [
      'Open your Grafana and go to Administration → Users and access → Service accounts.',
      'Add service account — name it "mesh", role Viewer.',
      'Add service account token, then copy it immediately (Grafana shows it once).',
    ],
    scopes: ['Viewer'],
    looksLike: 'glsa_…',
    caveat: 'Viewer is enough — Mesh only reads dashboards, Loki and Prometheus. Each Grafana you run needs its own token; add them one at a time.',
  },
  linear: {
    where: 'Linear → Settings → Security & access → Personal API keys',
    url: 'https://linear.app/settings/api',
    urlLabel: 'Open Linear API settings',
    steps: [
      'Go to Settings → Security & access → Personal API keys.',
      'New API key — label it "Mesh".',
      'Copy the key now; Linear will not show it again.',
    ],
    looksLike: 'lin_api_…',
    caveat: 'The key inherits your own access, so Mesh sees exactly the teams you do — nothing more.',
  },
  slack: {
    where: 'Slack → Your Apps → OAuth & Permissions',
    url: 'https://api.slack.com/apps',
    urlLabel: 'Open Slack apps',
    steps: [
      'Create New App → From scratch, pick your workspace.',
      'OAuth & Permissions → Bot Token Scopes → add the scopes below.',
      'Install to Workspace, then copy the Bot User OAuth Token.',
      'Invite the bot to each channel you want synced: /invite @your-app',
    ],
    scopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read'],
    looksLike: 'xoxb-…',
    caveat:
      'The groups:* scopes are only needed for private channels. A bot token cannot read a channel it has not been invited to — that is the usual reason a channel is missing from the picker. A user token (xoxp-…) with the same scopes also works and skips the invite step, but carries your own access rather than the app\u2019s. The all-public-channels corpus effectively requires one \u2014 a bot can only read channels it was invited to.',
  },
  notion: {
    where: 'Notion → Settings → Connections → Develop or manage integrations',
    url: 'https://www.notion.so/my-integrations',
    urlLabel: 'Open Notion integrations',
    steps: [
      'New integration — name it "Mesh", pick your workspace, type Internal.',
      'Capabilities: Read content is enough — Mesh never writes to Notion.',
      'Copy the Internal Integration Secret.',
      'Share pages with it: open a top-level page → ••• → Connections → add "Mesh". Sub-pages inherit access.',
    ],
    scopes: ['Read content'],
    looksLike: 'ntn_… or secret_…',
    caveat:
      'The integration sees ONLY pages explicitly shared with it (children included). If a sync finds nothing, the token is fine — the pages just haven\u2019t been shared. Sharing your top-level workspace pages once covers everything beneath them.',
  },
  sentry: {
    where: 'Sentry → Settings → Account → API → User Auth Tokens',
    url: 'https://sentry.io/settings/account/api/auth-tokens/',
    urlLabel: 'Open Sentry auth tokens',
    steps: [
      'Go to Settings → Account → API → User Auth Tokens.',
      'Create New Token, name it "Mesh".',
      'Tick the scopes below and create, then copy the token.',
    ],
    scopes: ['org:read', 'project:read', 'event:read'],
    looksLike: 'sntryu_…',
    caveat: 'Self-hosted Sentry uses your own host rather than sentry.io — the menu path is the same.',
  },
}
