import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">ChenkoAI</p>
        <h1>Agentic Build Console</h1>
        <p>
          A local-first command center for autonomous software building,
          prompt-engineered workflows, memory, tools, and model orchestration.
        </p>
      </section>
      <section className="panel">
        <h2>System Status</h2>
        <dl>
          <div>
            <dt>Desktop</dt>
            <dd>React shell ready</dd>
          </div>
          <div>
            <dt>Native Core</dt>
            <dd>Rust scaffold pending local toolchain</dd>
          </div>
          <div>
            <dt>AI Worker</dt>
            <dd>Python scaffold ready</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

