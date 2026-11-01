// SPDX-License-Identifier: AGPL-3.0-only

import { createClient } from "@nortfox/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element.");
}

const client = createClient({ baseUrl: "" });

createRoot(root).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
