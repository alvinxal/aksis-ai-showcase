import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { SAMPLE_DATA } from './app/data'
import { ContactsScreen } from './app/contacts'
import { DashboardLayout } from './dashboard/Layout'
import { DashboardLogin } from './dashboard/Login'
import { Admins, AuditLog, Costs, CustomerDetail, Customers, Health, More, Overview, Requests } from './dashboard/pages'
import { DisplayScreen } from './app/display'
import { GroupsScreen } from './app/groups'
import { CodeStep, PhoneStep, SessionGate } from './app/Login'
import { ProjectDetailScreen, ProjectsTab } from './app/project'
import { AppShell, ChatList, ChatThread, SettingsTab } from './app/screens'
import { AgendaScreen, BillingScreen, ConnectionScreen, ReportScreen, SearchScreen } from './app/workspace'
import { AppGate, PhoneOnly } from './gate/Gate'
import { Landing } from './Landing'
import { Privacy, Terms } from './legal/Legal'
import { RequestAccess } from './lead/RequestAccess'
import { Join } from './onboarding/Join'
import { Onboarding } from './onboarding/Onboarding'
import { OnboardingFrame } from './onboarding/screens'
import { Preview } from './Preview'

/**
 * Production serves the landing page, the onboarding and, once installed, the app behind a sign-in with a
 * WhatsApp code. The project and chat screens read the /v1 API (sample data in `vite dev` unless
 * VITE_REAL_API=1, see app/data.ts).
 */
const PREVIEW_SCREENS = import.meta.env.DEV

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/akses" element={<RequestAccess />} />
      <Route path="/dashboard/masuk" element={<DashboardLogin />} />
      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<Overview />} />
        <Route path="pelanggan" element={<Customers />} />
        <Route path="pelanggan/:id" element={<CustomerDetail />} />
        <Route path="lainnya" element={<More />} />
        <Route path="biaya" element={<Costs />} />
        <Route path="permintaan" element={<Requests />} />
        <Route path="kesehatan" element={<Health />} />
        <Route path="admin" element={<Admins />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/onboarding/*" element={<PhoneOnly><Onboarding /></PhoneOnly>} />
      <Route path="/join/:token" element={<PhoneOnly><Join /></PhoneOnly>} />

      {PREVIEW_SCREENS && <Route path="/preview" element={<Preview />} />}
      {PREVIEW_SCREENS && (
        <>
          <Route path="/preview/masuk" element={<OnboardingFrame><PhoneStep notice={null} busy={false} onSubmit={() => undefined} /></OnboardingFrame>} />
          <Route path="/preview/masuk-kode" element={<OnboardingFrame><CodeStep notice="code" busy={false} onSubmit={() => undefined} onResend={() => undefined} onBack={() => undefined} /></OnboardingFrame>} />
        </>
      )}

      <Route element={<AppGate />}>
        <Route element={SAMPLE_DATA ? <Outlet /> : <SessionGate />}>
          <Route path="/app" element={<AppShell />}>
            <Route index element={<ChatList />} />
            <Route path="proyek" element={<ProjectsTab />} />
            <Route path="pengaturan" element={<SettingsTab />} />
          </Route>
          <Route path="/app/chat/:id" element={<ChatThread />} />
          <Route path="/app/proyek/:id" element={<ProjectDetailScreen />} />
          <Route path="/app/pengaturan/kontak" element={<ContactsScreen />} />
          <Route path="/app/pengaturan/grup" element={<GroupsScreen />} />
          <Route path="/app/pengaturan/tampilan" element={<DisplayScreen />} />
          <Route path="/app/pengaturan/whatsapp" element={<ConnectionScreen />} />
          <Route path="/app/pengaturan/paket" element={<BillingScreen />} />
          <Route path="/app/agenda" element={<AgendaScreen />} />
          <Route path="/app/cari" element={<SearchScreen />} />
          <Route path="/app/laporan" element={<ReportScreen />} />
          <Route path="/app/*" element={<Navigate to="/app" replace />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
