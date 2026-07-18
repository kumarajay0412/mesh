import { describe, expect, it } from 'vitest'
import { isNoiseMessage, stripSlackMarkup } from '../sync/slack-clean'

describe('stripSlackMarkup', () => {
  it('converts user and group mentions to plain handles', () => {
    expect(stripSlackMarkup('Hi <@U09FVRAS6BB|aditi>, ping <@U08SVQ046G6>')).toBe('Hi @aditi, ping @user')
    expect(stripSlackMarkup('<!subteam^S0968254SG7> heads up')).toBe('@team heads up')
    expect(stripSlackMarkup('<!subteam^S096|@oncall> look')).toBe('@oncall look')
    expect(stripSlackMarkup('<!here> deploy done')).toBe('@here deploy done')
  })

  it('unwraps links, channels and mailto', () => {
    expect(stripSlackMarkup('see <https://dash.adalat.ai/doc/1|the doc>')).toBe('see the doc')
    expect(stripSlackMarkup('open <http://dashboard.adalat.ai/edit/958>')).toBe('open http://dashboard.adalat.ai/edit/958')
    expect(stripSlackMarkup('in <#C0123ABCDEF|reporting>')).toBe('in #reporting')
    expect(stripSlackMarkup('mail <mailto:a@b.c|a@b.c>')).toBe('mail a@b.c')
  })

  it('collapses leftover spaces but keeps newlines', () => {
    expect(stripSlackMarkup('a  <@U1|x>   b\nline two')).toBe('a @x b\nline two')
  })

  it('leaves plain text untouched', () => {
    const plain = 'Counter Affidavit getting transcribed twice for user x'
    expect(stripSlackMarkup(plain)).toBe(plain)
  })
})

describe('isNoiseMessage', () => {
  it('drops Slackbot reminders and join/leave', () => {
    expect(isNoiseMessage('Reminder: Hi @aditi, please go through the Zoho tickets')).toBe(true)
    expect(isNoiseMessage('<@U123> has joined the channel')).toBe(true)
    expect(isNoiseMessage('@sam has left the channel')).toBe(true)
  })

  it('drops empty standalone messages but keeps empty thread heads', () => {
    expect(isNoiseMessage('', 0)).toBe(true)
    expect(isNoiseMessage('', 3)).toBe(false)
  })

  it('keeps real reports', () => {
    expect(isNoiseMessage('Users getting site cant be reached on BSNL', 5)).toBe(false)
  })
})
