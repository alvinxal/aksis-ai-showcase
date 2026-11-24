import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ApiError, onboardingApi, type OnboardingState } from '../api'
import { QR_PAIRING } from '../features'
import { useDevice } from '../gate/device'
import { InstallGuide } from '../gate/screens'
import { FIXTURES } from './fixtures'
import { CodeScreen, Done, Groups, InvalidInvitation, LoadFailed, Loading, OnboardingFrame, PlanWaiting, Profile, QrScreen, SessionMissing, WhatsAppIntro, type WhatsAppNotice } from './screens'

const POLL_MS = 3000
const GROUPS_RETRY_MS = 5000
const STEP_NUMBER = { profile: 1, whatsapp: 2, pairing: 2, plan: 2, groups: 3, done: 4 } as const


type Load = { kind: 'loading' } | { kind: 'unauthorized' } | { kind: 'failed' } | { kind: 'ready'; state: OnboardingState }

/**
 * `vite dev` only: /onboarding?mock=groups shows a screen from fixtures.ts without a backend (also
 * mock=invalid and mock=session). The mock is read from the current URL, and the screen is mounted
 * afresh whenever it changes, because the preview page links between screens without a reload.
 */
export function Onboarding() {
  const { search } = useLocation()
  const mock = import.meta.env.DEV ? new URLSearchParams(search).get('mock') : null
  return <OnboardingScreen key={mock ?? 'live'} mock={mock} />
}

function OnboardingScreen({ mock }: { mock: string | null }) {
  const device = useDevice()
  const [load, setLoad] = useState<Load>(mock && FIXTURES[mock] ? { kind: 'ready', state: FIXTURES[mock] } : { kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<WhatsAppNotice | null>(null)
  const [phoneForm, setPhoneForm] = useState(false)
  const [retries, setRetries] = useState(0)

  const refresh = useCallback(async () => {
    if (mock) return
    try {
      setLoad({ kind: 'ready', state: await onboardingApi.state() })
    } catch (caught) {
      setLoad(caught instanceof ApiError && caught.status === 401 ? { kind: 'unauthorized' } : { kind: 'failed' })
    }
  }, [mock])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // While WhatsApp is pairing, or while an admin chooses the plan, the page follows by itself: new QR, code, connected, groups.
  const step = load.kind === 'ready' ? load.state.step : null
  useEffect(() => {
    if (step !== 'pairing' && step !== 'plan') return
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [step, refresh])

  // The group list can fail right after pairing; keep trying by itself until WhatsApp has it.
  const listFailed = load.kind === 'ready' && load.state.step === 'groups' && load.state.groups?.loadFailed === true
  useEffect(() => {
    if (!listFailed) return
    const timer = window.setInterval(() => void refresh(), GROUPS_RETRY_MS)
    return () => window.clearInterval(timer)
  }, [listFailed, refresh])

  /** Runs a write, then reloads the state; `onError` maps an API error to a message. */
  const act = async (run: () => Promise<unknown>, onError: (caught: ApiError) => void) => {
    if (mock) return
    setBusy(true)
    try {
      await run()
      await refresh()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setLoad({ kind: 'unauthorized' })
      else onError(caught instanceof ApiError ? caught : new ApiError(0, 'network'))
    } finally {
      setBusy(false)
    }
  }

  if (mock === 'invalid') return <OnboardingFrame><InvalidInvitation /></OnboardingFrame>
  if (mock === 'session') return <OnboardingFrame><SessionMissing /></OnboardingFrame>
  if (load.kind === 'loading') return <OnboardingFrame><Loading /></OnboardingFrame>
  if (load.kind === 'unauthorized') return <OnboardingFrame><SessionMissing /></OnboardingFrame>
  if (load.kind === 'failed') return <OnboardingFrame><LoadFailed onRetry={() => void refresh()} /></OnboardingFrame>

  const { state } = load
  // The preview can still show the QR screen (?mock=qr) while it is hidden for customers.
  const qrOffered = QR_PAIRING || mock === 'qr'
  // Without the QR option, a session that only has a QR (page reopened, or no code requested yet)
  // goes back to the phone form: a code is the only way to link.
  const needsCode = state.step === 'pairing' && !qrOffered && state.pairing?.connection === 'qr_ready' && !state.pairing.pairingCode
  const frame = (content: React.ReactNode) => <OnboardingFrame step={STEP_NUMBER[state.step]}>{content}</OnboardingFrame>

  if (state.step === 'profile') {
    return frame(
      <Profile
        defaultStudio={state.tenantName}
        busy={busy}
        error={error}
        onSubmit={(studio, name) => {
          setError(null)
          void act(() => onboardingApi.saveProfile(studio, name), () => setError('Data belum tersimpan. Isi nama studio dan nama Anda, lalu coba lagi.'))
        }}
      />,
    )
  }

  if (state.step === 'whatsapp' || (state.step === 'pairing' && (phoneForm || needsCode))) {
    return frame(
      <WhatsAppIntro
        notice={notice}
        busy={busy}
        {...(qrOffered
          ? {
              onQr: () => {
                setNotice(null)
                setPhoneForm(false)
                void act(() => onboardingApi.startQr(), (caught) => setNotice(caught.code === 'full' ? 'full' : 'failed'))
              },
            }
          : {})}
        onPhone={(phone) => {
          setNotice(null)
          void act(
            async () => {
              await onboardingApi.requestCode(phone)
              setPhoneForm(false)
            },
            (caught) => setNotice(caught.code === 'invalid_phone' ? 'phone' : caught.code === 'full' ? 'full' : 'failed'),
          )
        }}
      />,
    )
  }

  if (state.step === 'pairing' && state.pairing) {
    return frame(state.pairing.pairingCode ? <CodeScreen code={state.pairing.pairingCode} onNewCode={() => setPhoneForm(true)} /> : <QrScreen pairing={state.pairing} onUseCode={() => setPhoneForm(true)} />)
  }

  if (state.step === 'plan') return frame(<PlanWaiting />)

  if (state.step === 'groups' && state.groups) {
    return frame(
      <Groups
        // A fresh list (after "Muat ulang") starts from the server's selection again.
        key={state.groups.items.map((group) => group.jid).join('|')}
        groups={state.groups}
        busy={busy}
        error={error}
        retried={retries > 0}
        onRefresh={() => {
          setRetries((count) => count + 1)
          void act(async () => undefined, () => undefined)
        }}
        onSave={(jids) => {
          setError(null)
          void act(() => onboardingApi.saveGroups(jids), (caught) => setError(caught.message && caught.code === 'groups_rejected' ? caught.message : 'Pilihan belum tersimpan. Coba lagi.'))
        }}
      />,
    )
  }

  return frame(<Done tenantName={state.tenantName} contactName={state.contactName} install={<InstallGuide device={device} />} />)
}
