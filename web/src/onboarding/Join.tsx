import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ApiError, onboardingApi } from '../api'
import { DesktopBlocked } from '../gate/screens'
import { InvalidInvitation, LoadFailed, Loading, OnboardingFrame } from './screens'

// StrictMode runs effects twice in development; an invitation must only be spent once.
const attempted = new Set<string>()

/** Opening /join/<token> only shows this page; the invitation is spent here, by the page, with a POST. */
export function Join() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [state, setState] = useState<'working' | 'invalid' | 'phone' | 'failed'>('working')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const key = `${token}:${attempt}`
    if (!token || attempted.has(key)) return
    attempted.add(key)
    setState('working')
    onboardingApi
      .join(token)
      .then(() => navigate('/onboarding', { replace: true }))
      .catch((caught: unknown) => {
        const status = caught instanceof ApiError ? caught.status : 0
        setState(status === 410 ? 'invalid' : status === 403 ? 'phone' : 'failed')
      })
  }, [token, attempt, navigate])

  if (state === 'phone') return <DesktopBlocked />
  return (
    <OnboardingFrame>
      {state === 'working' && <Loading />}
      {state === 'invalid' && <InvalidInvitation />}
      {state === 'failed' && <LoadFailed onRetry={() => setAttempt((count) => count + 1)} />}
    </OnboardingFrame>
  )
}
