import { useEffect, useState } from 'react'
import { useSettings } from '../stores/settings'
import { getApi } from '../lib/api'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { Button, Card, Pill, Toggle } from '../components/ui'

export function Settings() {
  const { settings, load, update } = useSettings()
  const [repos, setRepos] = useState<string[] | null>(null)

  useEffect(() => {
    void load()
    void getApi().then((a) => a.scanRepos().then((r) => setRepos(r.repos)))
  }, [load])

  const pickFolder = async () => {
    const api = await getApi()
    const res = await api.pickRepoRoot()
    if (res.path) {
      setRepos(res.repos)
      await load() // repoRoot changed in settings
    }
  }

  if (!settings) return null

  return (
    <div className="mx-auto max-w-[720px] px-8 py-7">
      <ScreenHeader eyebrow="Preferences" title="Settings" />

      <div className="mt-6 flex flex-col gap-3">
        <Group label="Appearance">
          <Row title="Theme" desc="Dark is the native mood; light is the paper reading variant">
            <div className="flex gap-1.5">
              {(['dark', 'light'] as const).map((t) => (
                <button key={t} className="no-drag" onClick={() => void update({ theme: t })}>
                  <Pill tone={(settings.theme ?? 'dark') === t ? 'gold' : 'neutral'}>{t}</Pill>
                </button>
              ))}
            </div>
          </Row>
        </Group>

        <Group label="Agent">
          <Row title="Provider" desc="Which agent runs investigations">
            <div className="flex gap-1.5">
              {(['claude', 'codex'] as const).map((p) => (
                <button key={p} className="no-drag" onClick={() => void update({ provider: p, model: undefined })}>
                  <Pill tone={settings.provider === p ? 'gold' : 'neutral'}>{p === 'claude' ? 'Claude Code' : 'Codex'}</Pill>
                </button>
              ))}
            </div>
          </Row>
          <Row title="Model" desc={settings.provider === 'claude' ? 'Claude Code model aliases; default = your CLI default' : 'Codex model id; default = your CLI default'}>
            {settings.provider === 'claude' ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {[undefined, 'opus', 'sonnet', 'haiku'].map((m) => (
                  <button key={m ?? 'default'} className="no-drag" onClick={() => void update({ model: m })}>
                    <Pill tone={(settings.model ?? undefined) === m ? 'gold' : 'neutral'}>{m ?? 'default'}</Pill>
                  </button>
                ))}
              </div>
            ) : (
              <input
                className="no-drag w-[180px] rounded-sm border border-line bg-[color:var(--ada-field-bg)] px-2.5 py-1.5 text-right font-mono text-[12px] text-txt placeholder:text-subtle outline-none focus:border-gold-600"
                placeholder="default"
                defaultValue={settings.model ?? ''}
                onBlur={(e) => void update({ model: e.target.value.trim() || undefined })}
              />
            )}
          </Row>
          <Row title="Effort" desc="Reasoning depth per turn — higher digs deeper, costs more">
            <div className="flex flex-wrap justify-end gap-1.5">
              {([undefined, 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((ef) => (
                <button key={ef ?? 'default'} className="no-drag" onClick={() => void update({ effort: ef })}>
                  <Pill tone={(settings.effort ?? undefined) === ef ? 'gold' : 'neutral'}>{ef ?? 'default'}</Pill>
                </button>
              ))}
            </div>
          </Row>
          <Row title="Auth" desc="Personal use rides your own Claude Code / Codex login — no key to manage">
            <Pill tone="ok">subscription</Pill>
          </Row>
          {settings.provider === 'codex' && (
            <Row title="Codex capabilities" desc="exec mode has no approval callback — Codex runs strictly read-only">
              <Pill tone="warn">read-only · no fix sessions</Pill>
            </Row>
          )}
        </Group>

        <Group label="Permissions">
          <Row title="Mode" desc="Mirrors Claude Code. Approve = every write gated (default) · Auto = classifier decides · Plan = read-only planning · Bypass = no checks">
            <div className="flex flex-wrap justify-end gap-1.5">
              {(
                [
                  ['default', 'Approve'],
                  ['acceptEdits', 'Accept edits'],
                  ['auto', 'Auto'],
                  ['plan', 'Plan'],
                  ['bypassPermissions', 'Bypass'],
                ] as const
              ).map(([mode, label]) => (
                <button key={mode} className="no-drag" onClick={() => void update({ permissionMode: mode })}>
                  <Pill tone={settings.permissionMode === mode ? (mode === 'bypassPermissions' ? 'danger' : 'gold') : 'neutral'}>{label}</Pill>
                </button>
              ))}
            </div>
          </Row>
          {(settings.permissionMode === 'auto' || settings.permissionMode === 'bypassPermissions') && (
            <Row title="Heads up" desc="Writes will run without asking you — reads were always automatic. Switch back to Approve to restore the per-action gate.">
              <Pill tone="warn">approvals off</Pill>
            </Row>
          )}
        </Group>

        <Group label="Sync">
          <Row title="Auto-sync while the app is open" desc="Catch-up on launch covers time the app was closed">
            <Toggle on={settings.autoSync} onChange={(v) => void update({ autoSync: v })} />
          </Row>
          <Row title="Interval" desc="Minutes between incremental syncs">
            <div className="flex gap-1.5">
              {[15, 30, 60].map((m) => (
                <button key={m} className="no-drag" onClick={() => void update({ syncIntervalMin: m })}>
                  <Pill tone={settings.syncIntervalMin === m ? 'gold' : 'neutral'}>{m}m</Pill>
                </button>
              ))}
            </div>
          </Row>
        </Group>

        <Group label="Build">
          <Row title="Version" desc="Compare against release/ to know if you're on the latest build">
            <span className="font-mono text-[12px] text-subtle">0.1.0 · built {typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'}</span>
          </Row>
        </Group>

        <Group label="Workspace">
          <Row title="Repo folder" desc={settings.repoRoot}>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[12px] text-subtle">
                {repos === null ? 'scanning…' : `${repos.length} git repos`}
              </span>
              <Button variant="ghost" onClick={() => void pickFolder()}>
                Choose folder…
              </Button>
            </div>
          </Row>
          {settings.githubOrg && (
            <Row title="GitHub org" desc="Inferred from your clones' remotes — repo sync clones missing + fetches all">
              <Pill tone="gold">{settings.githubOrg}</Pill>
            </Row>
          )}
        </Group>
      </div>
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="border-b border-line px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-subtle">{label}</div>
      {children}
    </Card>
  )
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line">
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-txt">{title}</div>
        <div className="text-[12px] text-subtle">{desc}</div>
      </div>
      <div className="flex-1" />
      {children}
    </div>
  )
}
