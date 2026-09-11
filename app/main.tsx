import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import MediaReviewApp from "./MediaReviewApp.tsx";
import "./globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root が見つかりません");

createRoot(container).render(
  <StrictMode>
    <MediaReviewApp />
  </StrictMode>,
);
