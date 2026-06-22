import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const apiBaseUrl = "http://127.0.0.1:8787";

type RunListItem = {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type PermissionRequest = {
  id: string;
  toolName: string;
  status: string;
  reason: string;
  createdAt: string;
  input: Record<string, unknown>;
};

type RunReport = {
  runId: string;
  status: string;
  goal: string;
  progress: {
    totalSteps: number;
    pendingSteps: number;
    runningSteps: number;
    completedSteps: number;
    failedSteps: number;
    percentComplete: number;
  };
  activity: {
    toolExecutions: number;
    permissionRequests: number;
    pendingPermissions: PermissionRequest[];
  };
  nextAction: string;
  generatedAt: string;
};

type DataDataset = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type DataDocument = {
  id: string;
  title: string;
  sourceType: string;
  sourceUri?: string;
  chunkCount: number;
};

type SystemProfile = {
  workspaceRoot: string;
  datasetName: string;
};

type SystemScanResult = {
  datasetName: string;
  workspaceRoot: string;
  scannedFiles: number;
  ingestedDocuments: number;
  skippedFiles: number;
  embeddedChunks: number;
  truncated: boolean;
};

type ApiState = "checking" | "online" | "offline";

function App() {
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [modelProvider, setModelProvider] = useState("unknown");
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [datasets, setDatasets] = useState<DataDataset[]>([]);
  const [documents, setDocuments] = useState<DataDocument[]>([]);
  const [systemProfile, setSystemProfile] = useState<SystemProfile | undefined>();
  const [scanResult, setScanResult] = useState<SystemScanResult | undefined>();
  const [selectedRunId, setSelectedRunId] = useState("");
  const [report, setReport] = useState<RunReport | undefined>();
  const [goal, setGoal] = useState("Build the next ChenkoAI capability");
  const [context, setContext] = useState("Use memory, planning, safe tools, and reports.");
  const [maxSteps, setMaxSteps] = useState(4);
  const [autoRunOnCreate, setAutoRunOnCreate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId),
    [runs, selectedRunId],
  );

  async function refresh(nextRunId = selectedRunId): Promise<void> {
    try {
      const [health, modelPayload, profilePayload, runPayload, permissionPayload, datasetPayload, documentPayload] =
        await Promise.all([
        apiGet<{ ok: boolean }>("/health"),
        apiGet<{ provider: string }>("/model/provider"),
        apiGet<SystemProfile>("/system/profile"),
        apiGet<{ runs: RunListItem[] }>("/agent/runs"),
        apiGet<{ permissions: PermissionRequest[] }>("/tools/permissions"),
        apiGet<{ datasets: DataDataset[] }>("/data/datasets"),
        apiGet<{ documents: DataDocument[] }>("/data/documents"),
      ]);

      if (!health.ok) {
        throw new Error("API health check failed");
      }

      setApiState("online");
      setModelProvider(modelPayload.provider);
      setSystemProfile(profilePayload);
      setRuns(runPayload.runs);
      setPermissions(permissionPayload.permissions);
      setDatasets(datasetPayload.datasets);
      setDocuments(documentPayload.documents);

      const runId = nextRunId || runPayload.runs[0]?.id || "";
      setSelectedRunId(runId);
      setReport(runId ? await apiGet<RunReport>(`/agent/runs/${runId}/report`) : undefined);
    } catch {
      setApiState("offline");
      setModelProvider("unknown");
      setSystemProfile(undefined);
      setReport(undefined);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 7000);
    return () => window.clearInterval(timer);
  }, []);

  async function runAction(action: () => Promise<string | undefined>): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const nextRunId = await action();
      await refresh(nextRunId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ChenkoAI</p>
          <h1>Agent Control Center</h1>
        </div>
        <div className="status-row">
          <div className="status-pill">model: {modelProvider}</div>
          <div className={`status-pill ${apiState}`}>{apiState}</div>
        </div>
      </header>

      {apiState === "offline" ? (
        <section className="empty-state">
          <h2>API is offline</h2>
          <p>Start the ChenkoAI API on port 8787, then refresh this console.</p>
          <button onClick={() => void refresh()}>Retry</button>
        </section>
      ) : (
        <section className="dashboard">
          <section className="workspace">
            <div className="section-heading">
              <h2>System Memory</h2>
              <button disabled={busy} onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
            <p className="muted">{systemProfile?.workspaceRoot ?? "Workspace unavailable."}</p>
            <button
              disabled={busy || apiState !== "online"}
              onClick={() =>
                void runAction(async () => {
                  const result = await apiPost<SystemScanResult>("/system/scan", {
                    maxFiles: 120,
                    maxFileBytes: 160000,
                  });
                  setScanResult(result);
                  setMessage(
                    `System scan ingested ${result.ingestedDocuments} documents and embedded ${result.embeddedChunks} chunks.`,
                  );
                  return selectedRunId || undefined;
                })
              }
            >
              Scan Workspace
            </button>
            <div className="memory-summary">
              <Metric label="Datasets" value={String(datasets.length)} />
              <Metric label="Documents" value={String(documents.length)} />
            </div>
            {scanResult ? (
              <p className="muted">
                Last scan: {scanResult.scannedFiles} files checked, {scanResult.skippedFiles} skipped.
              </p>
            ) : null}

            <div className="section-heading compact-heading">
              <h2>Create Run</h2>
            </div>
            <label>
              Goal
              <textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
            </label>
            <label>
              Context
              <textarea value={context} onChange={(event) => setContext(event.target.value)} />
            </label>
            <label>
              Max steps
              <input
                min={1}
                max={12}
                type="number"
                value={maxSteps}
                onChange={(event) => setMaxSteps(Number(event.target.value))}
              />
            </label>
            <label className="checkbox-row">
              <input
                checked={autoRunOnCreate}
                type="checkbox"
                onChange={(event) => setAutoRunOnCreate(event.target.checked)}
              />
              Start agent automatically
            </label>
            <button
              disabled={busy || !goal.trim()}
              onClick={() =>
                void runAction(async () => {
                  const created = await apiPost<{ run: { id: string } }>("/agent/runs", {
                    goal,
                    context,
                    maxSteps,
                  });
                  if (autoRunOnCreate) {
                    await apiPost(`/agent/runs/${created.run.id}/auto`, {
                      planFirst: true,
                      maxCycles: Math.max(maxSteps + 4, 8),
                    });
                    setMessage("Run created and agent started.");
                  } else {
                    setMessage("Run created. Use Auto Run to start the agent.");
                  }
                  return created.run.id;
                })
              }
            >
              {autoRunOnCreate ? "Create & Start" : "Create Run"}
            </button>

            <div className="run-list">
              <h2>Runs</h2>
              {runs.length === 0 ? (
                <p className="muted">No runs yet.</p>
              ) : (
                runs.map((run) => (
                  <button
                    className={run.id === selectedRunId ? "run-item selected" : "run-item"}
                    key={run.id}
                    onClick={() => void refresh(run.id)}
                  >
                    <span>{run.goal}</span>
                    <strong>{run.status}</strong>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="main-panel">
            <div className="section-heading">
              <div>
                <h2>Run Report</h2>
                <p>{selectedRun?.goal ?? "Select or create a run."}</p>
              </div>
              <div className="button-row">
                <button
                  disabled={busy || !selectedRunId}
                  onClick={() =>
                    void runAction(async () => {
                      await apiPost(`/agent/runs/${selectedRunId}/plan`, {});
                      setMessage("Plan generated.");
                      return selectedRunId;
                    })
                  }
                >
                  Plan
                </button>
                <button
                  disabled={busy || !selectedRunId}
                  onClick={() =>
                    void runAction(async () => {
                      await apiPost(`/agent/runs/${selectedRunId}/auto`, {
                        planFirst: true,
                        maxCycles: 8,
                      });
                      setMessage("Auto loop finished.");
                      return selectedRunId;
                    })
                  }
                >
                  Auto Run
                </button>
              </div>
            </div>

            {message ? <p className="notice">{message}</p> : null}

            {report ? (
              <>
                <div className="metric-grid">
                  <Metric label="Status" value={report.status} />
                  <Metric label="Progress" value={`${report.progress.percentComplete}%`} />
                  <Metric label="Steps" value={`${report.progress.completedSteps}/${report.progress.totalSteps}`} />
                  <Metric label="Tools" value={String(report.activity.toolExecutions)} />
                </div>
                <div className="progress-track">
                  <div style={{ width: `${report.progress.percentComplete}%` }} />
                </div>
                <section className="plain-section">
                  <h3>Next Action</h3>
                  <p>{report.nextAction}</p>
                </section>
                <section className="plain-section">
                  <h3>Pending Permissions</h3>
                  {report.activity.pendingPermissions.length === 0 ? (
                    <p className="muted">No pending approvals.</p>
                  ) : (
                    report.activity.pendingPermissions.map((permission) => (
                      <PermissionCard
                        disabled={busy}
                        key={permission.id}
                        permission={permission}
                        onDecision={(approved) =>
                          runAction(async () => {
                            await apiPost(`/tools/permissions/${permission.id}/decision`, {
                              approved,
                              decidedBy: "desktop-control-center",
                            });
                            if (approved) {
                              await apiPost(`/agent/runs/${selectedRunId}/tools/execute`, {
                                name: permission.toolName,
                                approvalId: permission.id,
                                input: permission.input,
                              });
                              setMessage("Permission approved and tool executed.");
                            } else {
                              setMessage("Permission denied.");
                            }
                            return selectedRunId;
                          })
                        }
                      />
                    ))
                  )}
                </section>
              </>
            ) : (
              <p className="muted">No report loaded.</p>
            )}
          </section>

          <aside className="side-panel">
            <h2>Knowledge Base</h2>
            {documents.length === 0 ? (
              <p className="muted">No scanned documents yet.</p>
            ) : (
              documents.slice(0, 6).map((document) => (
                <div className="permission-row" key={document.id}>
                  <strong>{document.title}</strong>
                  <span>{document.chunkCount} chunks</span>
                </div>
              ))
            )}
            <h2>Permission Queue</h2>
            {permissions.length === 0 ? (
              <p className="muted">No permission history.</p>
            ) : (
              permissions.slice(0, 8).map((permission) => (
                <div className="permission-row" key={permission.id}>
                  <strong>{permission.toolName}</strong>
                  <span>{permission.status}</span>
                </div>
              ))
            )}
          </aside>
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PermissionCard({
  disabled,
  onDecision,
  permission,
}: {
  disabled: boolean;
  onDecision: (approved: boolean) => Promise<void>;
  permission: PermissionRequest;
}) {
  return (
    <div className="permission-card">
      <div>
        <strong>{permission.toolName}</strong>
        <p>{permission.reason}</p>
        <pre>{JSON.stringify(permission.input, undefined, 2)}</pre>
      </div>
      <div className="button-row">
        <button disabled={disabled} onClick={() => void onDecision(true)}>
          Approve
        </button>
        <button className="secondary" disabled={disabled} onClick={() => void onDecision(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  return readResponse<T>(response);
}

async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

createRoot(document.getElementById("root")!).render(<App />);
