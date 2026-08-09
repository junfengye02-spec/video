import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./shared/styles/tokens.css";
import "./shared/styles/reset.css";
import "./shared/styles/typography.css";
import "./shared/styles/motion.css";
import "./shared/styles/utilities.css";
import "./styles/tokens.css";
import "./styles.css";
import "./styles/shell.css";
import "./styles/pages.css";
import "./styles/responsive.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
