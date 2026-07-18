// Slack text hygiene for ingestion (Section 7.1). Raw Slack messages carry
// API markup (<@U…|name>, <!subteam^…>, <http://…|label>) and the channel
// carries bot noise (Slackbot reminders, join/leave). Clean at the source so
// distillation, titles, FTS and embeddings all see human text.
// Pure module: no Electron, no DB — unit-tested directly.

/** Slack API markup → plain human text. Mirrored by scripts/clean-slack-memory.mjs. */
export function stripSlackMarkup(text: string): string {
  return (
    text
      // user mentions: <@U123|ajay> → @ajay · <@U123> → @user
      .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
      .replace(/<@[A-Z0-9]+>/g, '@user')
      // user-group mentions: <!subteam^S123|@eng> → @eng · <!subteam^S123> → @team
      .replace(/<!subteam\^[A-Z0-9]+\|@?([^>]+)>/g, '@$1')
      .replace(/<!subteam\^[A-Z0-9]+>/g, '@team')
      // broadcast keywords: <!here> / <!channel> / <!everyone>
      .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
      // channel refs: <#C123|reporting> → #reporting
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/<#[A-Z0-9]+>/g, '#channel')
      // links: <https://x.y|label> → label · <https://x.y> → https://x.y
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      // mailto: <mailto:a@b.c|a@b.c> → a@b.c
      .replace(/<mailto:([^|>]+)(\|[^>]*)?>/g, '$1')
      // collapse runs of spaces/tabs the substitutions leave behind (keep newlines)
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  )
}

/** Channel noise that must not become an incident: Slackbot reminders,
 *  join/leave announcements, and empty messages with no thread. */
export function isNoiseMessage(text: string, replyCount = 0): boolean {
  const t = text.trim()
  if (t === '' && replyCount === 0) return true
  if (/^Reminder:/i.test(t)) return true
  if (/^<?@?[^\s>]*>?\s*has (joined|left) the channel$/i.test(t)) return true
  return false
}
