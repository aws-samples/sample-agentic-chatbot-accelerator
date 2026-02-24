/* Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
----------------------------------------------------------------------

*/
import { BrowserRouter, Route, Routes } from "react-router-dom";
import GlobalHeader from "./components/global-header";
import Playground from "./pages/chatbot/playground";
import NotFound from "./pages/not-found";
import "./styles/app.scss";

import AgentCoreManagerPage from "./pages/admin/agent-core-manager";
import AgentCoreWizardPage from "./pages/admin/agent-core-wizard-page";
import DocumentManagerPage from "./pages/admin/documents";
import EvaluationsManagerPage from "./pages/admin/evaluations-manager";
import EvaluationsWizardPage from "./pages/admin/evaluations-wizard-page";
import KnowledgeBaseManagerPage from "./pages/admin/kb-manager";
import SessionPage from "./pages/chatbot/sessions";

function App() {
    // const appContext = useContext(AppContext);
    const Router = BrowserRouter;

    return (
        <div style={{ height: "100%" }}>
            <Router>
                <GlobalHeader />
                <div style={{ height: "56px", backgroundColor: "#000716" }}>&nbsp;</div>
                <div>
                    <Routes>
                        <Route index path="/" element={<Playground />} />
                        <Route path="/:sessionId" element={<Playground />} />
                        <Route path="/sessions" element={<SessionPage />} />
                        <Route path="/documents" element={<DocumentManagerPage />} />
                        <Route path="/knowledgebase" element={<KnowledgeBaseManagerPage />} />
                        <Route path="/agent-core" element={<AgentCoreManagerPage />} />
                        <Route path="/agent-core/create" element={<AgentCoreWizardPage />} />
                        <Route path="/evaluations" element={<EvaluationsManagerPage />} />
                        <Route path="/evaluations/create" element={<EvaluationsWizardPage />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </div>
            </Router>
        </div>
    );
}

export default App;
