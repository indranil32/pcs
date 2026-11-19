import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const VesselCalls = lazy(() => import('./pages/VesselCalls'));
const VesselCallDetail = lazy(() => import('./pages/VesselCallDetail'));
const BerthPlan = lazy(() => import('./pages/BerthPlan'));
const Clearance = lazy(() => import('./pages/Clearance'));
const Cargo = lazy(() => import('./pages/Cargo'));
const DeliveryOrders = lazy(() => import('./pages/DeliveryOrders'));
const Trucks = lazy(() => import('./pages/Trucks'));
const Gate = lazy(() => import('./pages/Gate'));
const Barges = lazy(() => import('./pages/Barges'));
const Rail = lazy(() => import('./pages/Rail'));
const Services = lazy(() => import('./pages/Services'));
const Finance = lazy(() => import('./pages/Finance'));
const Tariffs = lazy(() => import('./pages/Tariffs'));
const Edi = lazy(() => import('./pages/Edi'));
const PortMap = lazy(() => import('./pages/PortMap'));
const Admin = lazy(() => import('./pages/Admin'));
const Inland = lazy(() => import('./pages/Inland'));
const Facility = lazy(() => import('./pages/Facility'));
const Permit = lazy(() => import('./pages/Permit'));
const Verify = lazy(() => import('./pages/Verify'));

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 } } });

const Spinner = () => <div className="flex h-full items-center justify-center text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>;

function Protected() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace />;
  return (
    <Layout>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/vessel-calls" element={<VesselCalls />} />
          <Route path="/vessel-calls/:id" element={<VesselCallDetail />} />
          <Route path="/berth-plan" element={<BerthPlan />} />
          <Route path="/clearance" element={<Clearance />} />
          <Route path="/cargo" element={<Cargo />} />
          <Route path="/delivery-orders" element={<DeliveryOrders />} />
          <Route path="/trucks" element={<Trucks />} />
          <Route path="/gate" element={<Gate />} />
          <Route path="/barges" element={<Barges />} />
          <Route path="/rail" element={<Rail />} />
          <Route path="/inland" element={<Inland />} />
          <Route path="/inland/:id" element={<Facility />} />
          <Route path="/services" element={<Services />} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/finance/invoices/:id" element={<Finance />} />
          <Route path="/tariffs" element={<Tariffs />} />
          <Route path="/edi" element={<Edi />} />
          <Route path="/map" element={<PortMap />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/:tab" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/verify/permit/:no" element={<Suspense fallback={<Spinner />}><Verify /></Suspense>} />
              <Route path="/vessel-calls/:id/permit" element={<Suspense fallback={<Spinner />}><Permit /></Suspense>} />
              <Route path="/*" element={<Protected />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
