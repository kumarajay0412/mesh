import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../../stores/app'
import { useSettings } from '../../stores/settings'
import { Button, Modal } from '../ui'

/** The onboarding tour: what each tab does and how the pieces feed the agent.
 *  Auto-opens once on a fresh install (settings.onboardingSeen unset); the
 *  sidebar's Tutorial button reopens it anytime. Pure content — no app state
 *  is touched beyond marking it seen. */

interface Step {
  kicker: string
  title: string
  body: ReactNode
}

const B = ({ children }: { children: ReactNode }) => (
  <li className="flex gap-2.5 text-[13px] leading-relaxed text-muted">
    <span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-gold-400/70" />
    <span>{children}</span>
  </li>
)

const K = ({ children }: { children: ReactNode }) => (
  <code className="rounded-sm bg-ink-900 px-1 py-0.5 font-mono text-[12px] text-gold-400">{children}</code>
)

const STEPS: Step[] = [
  {
    kicker: 'welcome',
    title: 'What Mesh is',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">
          Hand Mesh a ticket or a symptom and it investigates across your repos, your observability, and your own incident
          history — then returns an evidence-linked root cause, down to the culprit commit.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>Everything is local: one SQLite file, local embeddings, tokens in the OS keychain. No hosted service.</B>
          <B>The agent runs on your own Claude login and is read-only by default — every write needs your explicit approval.</B>
          <B>Each investigation makes the next one smarter, and you gate every piece of that learning.</B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'connections tab',
    title: 'Connect your sources',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">Mesh ships knowing nothing. Connections is where your org comes in:</p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>
            <strong className="text-txt">Grafana</strong> — read-scoped token(s). Service discovery reads your Loki labels and drafts the
            service registry automatically.
          </B>
          <B>
            <strong className="text-txt">Linear</strong> — API key. Tickets + comment threads become searchable incident memory.
          </B>
          <B>
            <strong className="text-txt">Slack</strong> — paste a token, then <em>pick</em> your incident/RCA channels from a live list. Each
            channel syncs independently.
          </B>
          <B>
            <strong className="text-txt">Sentry</strong> — optional; gives the agent live issue/event/stack-trace tools inside sessions.
          </B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'memory tab',
    title: 'Memory — incidents you can search by meaning',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">
          Every synced ticket and Slack thread is distilled into structured fields — symptoms, root cause, resolution — and
          indexed three ways: exact error-signature, keywords, and semantic vectors from a local model.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>&ldquo;Staff can&rsquo;t open the dashboard&rdquo; finds &ldquo;site can&rsquo;t be reached&rdquo; — zero shared words.</B>
          <B>
            <K>Refresh</K> in the sidebar runs the sync: first run backfills, every run after is incremental and crash-safe.
          </B>
          <B>The agent gets the top similar incidents injected at the start of every investigation — and can re-search mid-run.</B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'service registry tab',
    title: 'Registry — where each service lives',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">
          One card per service: which repo it maps to, which Grafana instance watches it, its exact log label, and any known
          fixes. This is how the agent runs the <em>right</em> log query on turn one instead of guessing.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>
            <K>Discover from Grafana</K> drafts it from your Loki labels, fuzzy-matched to your local repos.
          </B>
          <B>Anything you edit by hand is marked manual and never overwritten by discovery.</B>
          <B>Candidate services&rsquo; cards are injected into the agent&rsquo;s prompt per investigation.</B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'knowledge map tab',
    title: 'Knowledge map — how services connect',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">
          The registry knows where services <em>are</em>; the map knows who <em>calls whom</em>, over what. It rides in every
          agent prompt, so a frontend symptom can be traced to a service two hops down.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>
            Start with <K>Seed from description</K> — paste a plain-language description or an architecture doc; services and
            connections are extracted into editable rows.
          </B>
          <B>Investigations propose new edges they verified in code — dashed gold until you accept or dismiss them.</B>
          <B>Click any node to attach operational notes; those travel to the agent too.</B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'repos · settings tab',
    title: 'Repos — the code the agent reads',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">
          Point Settings at your repos folder. Mesh keeps local checkouts synced (it can clone your whole GitHub org), and
          investigations run <em>inside</em> that folder — read-only.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>
            The agent uses <K>git log</K> / <K>git blame</K> and ripgrep across every checkout to name the culprit commit and
            line — evidence first, commits last, per its runbook.
          </B>
          <B>
            The <K>repos</K> row on the Memory screen shows the sync; your GitHub org is inferred from your own remotes.
          </B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'investigations tab',
    title: 'Investigations — where it all comes together',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">
          Paste a ticket URL or describe a symptom. The agent assembles context (similar incidents, registry, map, learnings),
          then works step-by-step on a live timeline.
        </p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>Steer it mid-flight by typing; every claim it sources lands in the evidence rail as it happens.</B>
          <B>
            <strong className="text-txt">Any write pops an approval modal</strong> — deny by default, everything audited. Posting the
            report to Linear and opening a fix session are gated the same way.
          </B>
          <B>The report: root-cause story with per-service verdicts, culprit commit, suggested fix, honest unknowns.</B>
        </ul>
      </>
    ),
  },
  {
    kicker: 'the loop',
    title: 'It gets smarter — with your sign-off',
    body: (
      <>
        <p className="text-[13.5px] leading-relaxed text-muted">Three things happen after every report, and you gate all of them:</p>
        <ul className="mt-3 flex flex-col gap-2">
          <B>The investigation itself is written back into memory — the next similar incident starts from this answer.</B>
          <B>Proposed learnings (&ldquo;where the logs live&rdquo;, &ldquo;which repo owns what&rdquo;) wait for your accept/dismiss; only accepted ones enter future prompts.</B>
          <B>Proposed map edges wait on the Knowledge map the same way.</B>
        </ul>
        <p className="mt-3 text-[13px] leading-relaxed text-subtle">
          Reopen this tour anytime — the <span className="text-muted">Tutorial</span> button lives at the bottom of the sidebar.
        </p>
      </>
    ),
  },
]

export function Tour() {
  const { tourOpen, setTour } = useApp()
  const { settings, update } = useSettings()
  const [step, setStep] = useState(0)

  // First run: settings loaded and the tour has never been seen → open once.
  // Depends on the settings OBJECT: `onboardingSeen` is undefined both before
  // and after load, so the field alone never retriggers the effect.
  useEffect(() => {
    if (settings && !settings.onboardingSeen) setTour(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  if (!tourOpen) return null

  const close = () => {
    setTour(false)
    setStep(0)
    if (!settings?.onboardingSeen) void update({ onboardingSeen: true })
  }

  const s = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <Modal open onClose={close} width={620}>
      <div className="border-b border-line px-6 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-gold-600">{s.kicker}</div>
        <div className="mt-0.5 font-display text-[19px] font-semibold tracking-tight text-txt">{s.title}</div>
      </div>

      <div className="min-h-[240px] px-6 py-5">{s.body}</div>

      <div className="flex items-center justify-between border-t border-line px-6 py-4">
        <div className="flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              aria-label={`step ${i + 1}`}
              className="no-drag h-1.5 rounded-full transition-all"
              style={{ width: i === step ? 18 : 6, background: i === step ? 'var(--ada-gold-400)' : 'var(--ada-ink-600)' }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          {!last && (
            <button className="no-drag mr-1 font-mono text-[11px] text-subtle hover:text-muted" onClick={close}>
              skip
            </button>
          )}
          {step > 0 && (
            <Button variant="quiet" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Back
            </Button>
          )}
          {last ? (
            <Button variant="primary" onClick={close}>
              Start using Mesh
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
              Next
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
