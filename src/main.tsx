import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DemoApp } from "./demo/demo-app.tsx";
import "./graph/graph.css";
import "./demo/demo.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
