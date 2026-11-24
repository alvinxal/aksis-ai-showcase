import type { ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { gateIsOpen, useDevice } from './device'
import { useTextSizeScope } from '../app/textsize'
import { DesktopBlocked, InstallGate } from './screens'

/** Onboarding and the invitation page: phones only. */
export function PhoneOnly({ children }: { children: ReactNode }) {
  const device = useDevice()
  if (gateIsOpen(device)) return <>{children}</>
  return device.kind === 'phone' ? <>{children}</> : <DesktopBlocked />
}

/** The app: phones only, and only once it is installed and opened from the home screen. */
export function AppGate() {
  const device = useDevice()
  useTextSizeScope()
  if (gateIsOpen(device)) return <Outlet />
  if (device.kind !== 'phone') return <DesktopBlocked />
  if (!device.standalone) return <InstallGate device={device} />
  return <Outlet />
}
