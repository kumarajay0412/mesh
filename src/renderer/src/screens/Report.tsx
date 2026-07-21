import { useEffect } from 'react'
import { useApp } from '../stores/app'
import { useInvestigations } from '../stores/investigations'
import { getApi } from '../lib/api'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { HypothesisCard } from '../components/report/HypothesisCard'
import { RootCauseCard } from '../components/report/RootCauseCard'
import { CulpritCard } from '../components/report/CulpritCard'
import { SuspectList } from '../components/report/SuspectList'
import { EvidenceChain } from '../components/report/EvidenceChain'
import { IncidentTimeline } from '../components/report/IncidentTimeline'
import { SuggestedFix } from '../components/report/SuggestedFix'
import { UnexploredBranches } from '../components/report/UnexploredBranches'
import { LearningsCard } from '../components/report/LearningsCard'
import { FeedbackBox } from '../components/report/FeedbackBox'
import { ReportActions } from '../components/report/ReportActions'
import { Button, EmptyState } from '../components/ui'

export function Report() {
  const { activeInvestigationId: id, go } = useApp()
  const { list, load, comment } = useInvestigations()

  useEffect(() => {
    void load()
  }, [load])

  const inv = list.find((i) => i.id === id)
  const report = inv?.report

  return (
    <div className="mx-auto max-w-[980px] px-8 py-7">
      <ScreenHeader
        eyebrow={`Root-cause report · ${id ?? ''}`}
        title={inv?.title ?? 'Report'}
        right={
          report && (
            <ReportActions
              onPostToLinear={() => id && void getApi().then((a) => a.postReportToLinear(id))}
              onOpenFixSession={() => id && void getApi().then((a) => a.openFixSession(id))}
              onDownload={async () => {
                if (!id) return null
                const r = await (await getApi()).exportReportHtml(id)
                return r.path
              }}
            />
          )
        }
      />

      {!report ? (
        <div className="mt-6">
          <EmptyState
            title="No report yet"
            note="The report lands here when the investigation reaches its final stage."
            action={<Button variant="ghost" onClick={() => go('investigation', id ?? undefined)}>Open the live view</Button>}
          />
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          <HypothesisCard report={report} />
          {report.rootCauseDetail && <RootCauseCard detail={report.rootCauseDetail} />}
          {report.culprit && <CulpritCard culprit={report.culprit} />}
          <SuspectList suspects={report.suspects} />
          <IncidentTimeline timeline={report.timeline} />
          <EvidenceChain evidence={report.evidence} />
          <SuggestedFix text={report.suggestedFix} />
          <UnexploredBranches items={report.unexplored} />
          {id && <LearningsCard investigationId={id} />}
          {id && (
            <FeedbackBox
              onSend={(text) => {
                void comment(id, text)
                go('investigation', id) // watch the agent respond live
              }}
            />
          )}
          <div className="mt-1 flex items-center justify-between border-t border-line pt-4">
            <Button variant="quiet" onClick={() => go('investigations')}>← All investigations</Button>
            <span className="font-mono text-[10px] text-subtle">every claim above carries its source</span>
          </div>
        </div>
      )}
    </div>
  )
}
