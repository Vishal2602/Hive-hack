// Routes. Screens live in src/screens and are the only files screen builders replace.
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastStack, ToastStackProvider } from '@/components/arc/toast-stack/toast-stack';
import { AppShell } from '@/shell/AppShell';
import { JoinRoute } from '@/shell/JoinRoute';
import { MockProvider } from '@/shell/store';
import Activity from '@/screens/Activity';
import AgreementDetail from '@/screens/AgreementDetail';
import Agreements from '@/screens/Agreements';
import Connect from '@/screens/Connect';
import Members from '@/screens/Members';
import Overview from '@/screens/Overview';
import SignIn from '@/screens/SignIn';

export default function App() {
  return (
    <MockProvider>
      <ToastStackProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/signin" element={<SignIn />} />
            <Route path="/join" element={<JoinRoute />} />
            <Route element={<AppShell />}>
              <Route index element={<Overview />} />
              <Route path="connect" element={<Connect />} />
              <Route path="agreements" element={<Agreements />} />
              <Route path="agreements/:id" element={<AgreementDetail />} />
              <Route path="activity" element={<Activity />} />
              <Route path="members" element={<Members />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <ToastStack />
      </ToastStackProvider>
    </MockProvider>
  );
}
