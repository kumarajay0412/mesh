import { describe, expect, it } from 'vitest'
import { classify } from '../registry/k8s-status'

// The card only tells you to re-login for contexts that actually delegate auth
// to a provider CLI. Getting this wrong in either direction is user-visible:
// a false nag on a working cluster, or silence on a genuinely broken one.
describe('k8s context classification', () => {
  it('flags GKE contexts that shell out to the gcloud auth plugin', () => {
    expect(classify('gke-gcloud-auth-plugin', 'gke_proj_asia-south1-a_prod-cluster', 'gke-prod')).toMatchObject({
      provider: 'gcp',
      needsCliLogin: true,
    })
  })

  it('flags AKS contexts that shell out to kubelogin (AAD)', () => {
    expect(classify('kubelogin', 'my-aks', 'aks-aad')).toMatchObject({ provider: 'azure', needsCliLogin: true })
  })

  it('does NOT flag AKS clusterUser contexts — creds are embedded in kubeconfig', () => {
    // Ajay's real aks-dictation: no exec block, so `az login` state is irrelevant.
    const c = classify(undefined, 'adalatAI-prod-jap-dictation-aks', 'aks-dictation')
    expect(c.needsCliLogin).toBe(false)
    expect(c.provider).toBe('azure')
  })

  it('still labels the provider for embedded-cred GKE contexts without nagging', () => {
    const c = classify(undefined, 'gke_proj_region_cluster', 'some-name')
    expect(c).toEqual({ provider: 'gcp', needsCliLogin: false })
  })

  it('falls back to other/no-login for an unrecognised context', () => {
    expect(classify(undefined, 'minikube', 'minikube')).toEqual({ provider: 'other', needsCliLogin: false })
  })

  it('matches the exec command case-insensitively and by path', () => {
    expect(classify('/opt/homebrew/bin/GKE-GCLOUD-AUTH-PLUGIN', '', 'x').needsCliLogin).toBe(true)
    expect(classify('/usr/local/bin/kubelogin', '', 'x').provider).toBe('azure')
  })

  it('prefers the exec plugin over a misleading cluster name', () => {
    // An AKS-named cluster reached via the gcloud plugin is still gcloud-gated.
    expect(classify('gke-gcloud-auth-plugin', 'aks-lookalike', 'aks-lookalike')).toMatchObject({
      provider: 'gcp',
      needsCliLogin: true,
    })
  })

  it('carries the exec binary so its presence can be probed', () => {
    // Without this the card cannot tell "logged in" from "plugin not installed",
    // which renders fully green while every read fails.
    expect(classify('/opt/homebrew/bin/kubelogin', '', 'x').execBin).toBe('/opt/homebrew/bin/kubelogin')
    expect(classify(undefined, '', 'x').execBin).toBeUndefined()
  })

  it('treats the legacy auth-provider: gcp block as gcloud-gated', () => {
    // Pre-exec GKE entries have no exec block but still shell out to gcloud.
    expect(classify(undefined, 'some-cluster', 'legacy-gke', 'gcp')).toMatchObject({
      provider: 'gcp',
      needsCliLogin: true,
    })
  })

  it('treats the legacy auth-provider: azure block as az-gated', () => {
    expect(classify(undefined, 'some-cluster', 'legacy-aks', 'azure')).toMatchObject({
      provider: 'azure',
      needsCliLogin: true,
    })
  })

  it('ignores an unrecognised auth-provider rather than inventing a dependency', () => {
    expect(classify(undefined, 'minikube', 'minikube', 'oidc')).toMatchObject({
      provider: 'other',
      needsCliLogin: false,
    })
  })
})
