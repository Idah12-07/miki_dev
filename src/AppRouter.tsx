import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";

import { MikiLayout } from "./components/miki/MikiLayout";
import Index from "./pages/Index";
import HistoryPage from "./pages/HistoryPage";
import SettingsPage from "./pages/SettingsPage";
import RecoveryPage from "./pages/RecoveryPage";
import { NIP19Page } from "./pages/NIP19Page";
import NotFound from "./pages/NotFound";


export function AppRouter() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        {/* MIKI screens share one layout (header, nav, providers). */}
        <Route element={<MikiLayout />}>
          <Route path="/" element={<Index />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/recovery" element={<RecoveryPage />} />
        </Route>
        {/* NIP-19 route for npub1, note1, naddr1, nevent1, nprofile1 */}
        <Route path="/:nip19" element={<NIP19Page />} />
        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
export default AppRouter;
