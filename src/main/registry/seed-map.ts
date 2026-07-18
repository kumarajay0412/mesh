// One-time system-map seed, from the org's architecture docs + the user's
// description (Jul 2026): the dictation pipeline (Dictation Inference doc's
// graph), the document path (party → cryptic → dashboard-service), core
// backend, deployment and observability. Everything is editable in the app;
// investigations propose deltas over time.
import type { Database } from 'better-sqlite3'
import { mapRepo } from '../db/repos/map'

export function seedMapIfEmpty(db: Database): void {
  const map = mapRepo(db)
  if (!map.isEmpty()) return

  const N = (id: string, label: string, kind: Parameters<typeof map.upsertNode>[0]['kind'], repo?: string, grafana?: string, notes?: string) =>
    map.upsertNode({ id, label, kind, repo, grafana, notes })

  // frontend + edge
  N('adalat-showcase', 'Showcase (frontend)', 'frontend', 'adalat-showcase', 'prod', 'THE frontend — editor, dictation UI, case views')
  N('adalat-party', 'PartyKit (docs realtime)', 'edge', 'adalat-party', 'prod', 'serves everything document-related (realtime collab)')
  // backend
  N('cryptic', 'Cryptic', 'backend', 'cryptic', 'prod', 'bridge: party → dashboard-service')
  N('dashboard-service', 'Dashboard Service', 'backend', 'dashboard-service', 'prod', 'the core backend — nodes, documents, permissions, media status')
  N('caseflow-service', 'Caseflow Service', 'backend', 'caseflow-service', 'prod')
  N('speech-orchestrator', 'Speech Orchestrator', 'backend', 'speech-orchestrator', 'azure', 'middleware/front door to ML; SINGLE REPLICA (known bottleneck)')
  N('data-autonomy', 'Data Autonomy', 'backend', 'data-autonomy', 'azure', 'receives duplicate audio from the client')
  // ml services (dictation pipeline)
  N('cmd-vad', 'CMD VAD', 'ml', 'cmd-vad', 'azure', 'voice activity detection — segments audio')
  N('cmd-batch-asr', 'CMD Batch ASR', 'ml', 'cmd-batch-asr', 'azure', 'in-house models; THE GPU bottleneck; batch 15/30s')
  N('itn-service', 'ITN Service', 'ml', 'itn-service', 'azure', 'inverse text normalization')
  N('document-translate', 'Document Translate', 'ml', 'document-translate', 'azure')
  N('legal-lens', 'Legal Lens', 'ml', 'legal-lens', 'azure')
  N('azure-google-stt', 'Azure / Google STT', 'external', undefined, undefined, 'live dictation; Google for Malayalam')
  // data + infra
  N('postgres', 'Postgres', 'datastore', undefined, undefined, 'owned by dashboard-service')
  N('adalat-charts', 'Adalat Charts (Helm)', 'infra', 'adalat-charts', undefined, 'deploys EVERYTHING — memory limits, replicas, config live here')

  const E = map.addEdge.bind(map)
  // document path
  E('adalat-showcase', 'adalat-party', 'docs realtime (Yjs)', 'ws')
  E('adalat-party', 'cryptic', 'doc persistence', 'http')
  E('cryptic', 'dashboard-service', 'doc CRUD', 'http')
  E('adalat-showcase', 'dashboard-service', 'GraphQL: updateNode, shareNodes…', 'graphql')
  E('dashboard-service', 'caseflow-service', 'case flows', 'http')
  E('dashboard-service', 'postgres', 'owns schema', 'db')
  // dictation pipeline (Dictation Inference doc)
  E('adalat-showcase', 'speech-orchestrator', 'ws: all dictation modes', 'ws')
  E('adalat-showcase', 'data-autonomy', 'duplicate audio', 'http')
  E('speech-orchestrator', 'cmd-vad', 'audio segments', 'http')
  E('speech-orchestrator', 'cmd-batch-asr', 'batch/smart ASR', 'queue')
  E('speech-orchestrator', 'azure-google-stt', 'live modes', 'ws')
  E('speech-orchestrator', 'itn-service', 'normalize transcripts', 'http')
  E('speech-orchestrator', 'document-translate', 'translation', 'http')
  E('speech-orchestrator', 'legal-lens', 'legal NLP', 'http')
  E('speech-orchestrator', 'dashboard-service', 'media status events', 'http')
  // deploys
  for (const svc of ['dashboard-service', 'caseflow-service', 'speech-orchestrator', 'cmd-vad', 'cmd-batch-asr', 'itn-service', 'adalat-party', 'cryptic'])
    E('adalat-charts', svc, undefined, 'deploys')
}
