import React, { useEffect, useMemo, useRef, useState } from "react";
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
  steps: {
    id: string;
    index: number;
    title: string;
    status: string;
    details?: string;
  }[];
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

type DataSearchResult = {
  chunk: {
    id: string;
    content: string;
  };
  document: {
    id: string;
    title: string;
    sourceType: string;
    sourceUri?: string;
  };
  dataset: {
    id: string;
    name: string;
  };
  distance: number;
};

type MemoryAnswer = {
  query: string;
  provider: string;
  model: string;
  embeddingProvider: string;
  embeddingModel: string;
  answer: string;
  results: DataSearchResult[];
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

type ModelSettings = {
  provider: string;
  embeddingProvider: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiEmbeddingModel: string;
  localBaseUrl: string;
  localModel: string;
  localEmbeddingModel: string;
  hasOpenAiApiKey: boolean;
  configPath: string;
};

type StorageSettings = {
  storageMode: string;
  dataStore: string;
  agentRunStore: string;
  promptRegistryStore: string;
  toolPermissionStore: string;
  databaseUrl: string;
  hasDatabaseUrl: boolean;
  configPath: string;
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
  const [memoryQuestion, setMemoryQuestion] = useState("What does this workspace contain?");
  const [memoryAnswer, setMemoryAnswer] = useState<MemoryAnswer | undefined>();
  const [modelSettings, setModelSettings] = useState<ModelSettings | undefined>();
  const [storageSettings, setStorageSettings] = useState<StorageSettings | undefined>();
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const modelSettingsDirty = useRef(false);
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
      const [
        health,
        modelPayload,
        settingsPayload,
        storagePayload,
        profilePayload,
        runPayload,
        permissionPayload,
        datasetPayload,
        documentPayload,
      ] = await Promise.all([
        apiGet<{ ok: boolean }>("/health"),
        apiGet<{ provider: string }>("/model/provider"),
        apiGet<ModelSettings>("/settings/model"),
        apiGet<StorageSettings>("/settings/storage"),
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
      if (!modelSettingsDirty.current) {
        setModelSettings(settingsPayload);
      }
      setStorageSettings(storagePayload);
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
      setModelSettings(undefined);
      setStorageSettings(undefined);
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
              <h2>Ask Memory</h2>
            </div>
            <label>
              Question
              <textarea
                value={memoryQuestion}
                onChange={(event) => setMemoryQuestion(event.target.value)}
              />
            </label>
            <button
              disabled={busy || !memoryQuestion.trim()}
              onClick={() =>
                void runAction(async () => {
                  const answer = await apiPost<MemoryAnswer>("/memory/answer", {
                    query: memoryQuestion,
                    limit: 5,
                  });
                  setMemoryAnswer(answer);
                  setMessage(
                    `Memory answer generated from ${answer.results.length} stored chunks.`,
                  );
                  return selectedRunId || undefined;
                })
              }
            >
              Ask Stored Memory
            </button>
            {memoryAnswer ? (
              <section className="memory-answer">
                <div className="memory-answer-text">{renderMemoryAnswer(memoryAnswer.answer)}</div>
                <p className="muted">
                  Model: {memoryAnswer.model} | Embeddings: {memoryAnswer.embeddingModel}
                </p>
                <h3>Sources Used</h3>
                <div className="memory-source-list">
                  {memorySources(memoryAnswer).map((result, index) => (
                    <article className="memory-source" key={result.chunk.id}>
                      <div className="memory-source-header">
                        <strong>
                          [{index + 1}] {memorySourceTitle(result)}
                        </strong>
                        <span>{memorySourceMatch(result.distance)}</span>
                      </div>
                      <p className="memory-source-meta">
                        {result.dataset.name} | {result.document.sourceType}
                      </p>
                      <p>{memorySourceSnippet(result.chunk.content)}</p>
                    </article>
                  ))}
                </div>
              </section>
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
                  <h3>Run Steps</h3>
                  <div className="step-list">
                    {report.steps.map((step) => (
                      <article className="step-card" key={step.id}>
                        <div className="step-card-header">
                          <strong>
                            {step.index + 1}. {step.title}
                          </strong>
                          <span>{step.status}</span>
                        </div>
                        {step.details ? (
                          <StepDetails details={step.details} />
                        ) : (
                          <p className="muted">Waiting to run.</p>
                        )}
                      </article>
                    ))}
                  </div>
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
            <h2>Model Settings</h2>
            {modelSettings ? (
              <div className="settings-form">
                <label>
                  Model provider
                  <select
                    value={modelSettings.provider}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setModelSettings({ ...modelSettings, provider: event.target.value });
                    }}
                  >
                    <option value="mock">Mock</option>
                    <option value="openai-compatible">OpenAI compatible</option>
                    <option value="local-http">Local HTTP</option>
                  </select>
                </label>
                <label>
                  Embedding provider
                  <select
                    value={modelSettings.embeddingProvider}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setModelSettings({
                        ...modelSettings,
                        embeddingProvider: event.target.value,
                      });
                    }}
                  >
                    <option value="mock">Mock</option>
                    <option value="openai-compatible">OpenAI compatible</option>
                    <option value="local-http">Local HTTP</option>
                  </select>
                </label>
                <label>
                  OpenAI API key
                  <input
                    placeholder={modelSettings.hasOpenAiApiKey ? "Saved" : "Not saved"}
                    type="password"
                    value={openaiApiKey}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setOpenaiApiKey(event.target.value);
                    }}
                  />
                </label>
                <label>
                  OpenAI model
                  <input
                    value={modelSettings.openaiModel}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setModelSettings({ ...modelSettings, openaiModel: event.target.value });
                    }}
                  />
                </label>
                <label>
                  Local URL
                  <input
                    value={modelSettings.localBaseUrl}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setModelSettings({ ...modelSettings, localBaseUrl: event.target.value });
                    }}
                  />
                </label>
                <label>
                  Local chat model
                  <input
                    value={modelSettings.localModel}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setModelSettings({ ...modelSettings, localModel: event.target.value });
                    }}
                  />
                </label>
                <label>
                  Local embedding model
                  <input
                    value={modelSettings.localEmbeddingModel}
                    onChange={(event) => {
                      modelSettingsDirty.current = true;
                      setModelSettings({
                        ...modelSettings,
                        localEmbeddingModel: event.target.value,
                      });
                    }}
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      const saved = await apiPost<ModelSettings & { restartRequired: boolean }>(
                        "/settings/model",
                        {
                          ...modelSettings,
                          openaiApiKey,
                        },
                      );
                      modelSettingsDirty.current = false;
                      setModelSettings(saved);
                      setOpenaiApiKey("");
                      setMessage("Model settings saved. Restart the app to use the new provider.");
                      return selectedRunId || undefined;
                    })
                  }
                >
                  Save Settings
                </button>
                <p className="muted">Provider changes apply after restarting ChenkoAI.</p>
              </div>
            ) : (
              <p className="muted">Settings unavailable.</p>
            )}
            <h2>Storage Settings</h2>
            {storageSettings ? (
              <div className="settings-form">
                <label>
                  Storage mode
                  <select
                    value={storageSettings.storageMode}
                    onChange={(event) =>
                      setStorageSettings({
                        ...storageSettings,
                        storageMode: event.target.value,
                      })
                    }
                  >
                    <option value="memory">Memory</option>
                    <option value="postgres">PostgreSQL</option>
                  </select>
                </label>
                <label>
                  Database URL
                  <input
                    value={storageSettings.databaseUrl}
                    onChange={(event) =>
                      setStorageSettings({
                        ...storageSettings,
                        databaseUrl: event.target.value,
                      })
                    }
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      const saved = await apiPost<StorageSettings & { restartRequired: boolean }>(
                        "/settings/storage",
                        storageSettings,
                      );
                      setStorageSettings(saved);
                      setMessage("Storage settings saved. Restart the app to use durable storage.");
                      return selectedRunId || undefined;
                    })
                  }
                >
                  Save Storage
                </button>
                <p className="muted">
                  PostgreSQL mode stores scans, chunks, agent runs, prompts, and approvals
                  permanently after restart.
                </p>
              </div>
            ) : (
              <p className="muted">Storage settings unavailable.</p>
            )}
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
  const action = describePermission(permission);

  return (
    <div className="permission-card">
      <div>
        <p className="permission-eyebrow">Proposed Action</p>
        <strong>{action.title}</strong>
        <p>{action.description}</p>
        {action.details.length > 0 ? (
          <div className="permission-details">
            {action.details.map((detail) => (
              <p key={detail}>{detail}</p>
            ))}
          </div>
        ) : null}
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

function describePermission(permission: PermissionRequest): {
  title: string;
  description: string;
  details: string[];
} {
  const path = typeof permission.input.path === "string" ? permission.input.path : undefined;
  const content = typeof permission.input.content === "string" ? permission.input.content : undefined;

  if (permission.toolName === "workspace.write_text_file") {
    return {
      title: path ? `Write file: ${path}` : "Write workspace file",
      description: "ChenkoAI wants approval before creating or changing a file.",
      details: [
        content ? `Content preview: ${content.slice(0, 180)}${content.length > 180 ? "..." : ""}` : "",
      ].filter(Boolean),
    };
  }

  if (permission.toolName === "workspace.read_text_file") {
    return {
      title: path ? `Read file: ${path}` : "Read workspace file",
      description: "ChenkoAI wants to inspect a workspace file before continuing.",
      details: [],
    };
  }

  if (permission.toolName === "workspace.list_files") {
    return {
      title: "List workspace files",
      description: "ChenkoAI wants to list files in the workspace.",
      details: path ? [`Path: ${path}`] : [],
    };
  }

  return {
    title: permission.toolName,
    description: permission.reason,
    details: [JSON.stringify(permission.input)],
  };
}

function StepDetails({ details }: { details: string }) {
  const parsed = parseStepDetails(details);

  return (
    <div className="step-details">
      {parsed.memory.length > 0 ? (
        <section>
          <h4>Memory Used</h4>
          {parsed.memory.map((line, index) => (
            <p className="step-memory-line" key={`${index}-${line}`}>
              {cleanDisplayText(line)}
            </p>
          ))}
        </section>
      ) : null}
      <section>
        <h4>Agent Output</h4>
        <div>{renderMemoryAnswer(parsed.output)}</div>
      </section>
    </div>
  );
}

function parseStepDetails(details: string): { memory: string[]; output: string } {
  const cleanDetails = removeCodeBlocks(details);
  const [, afterMemory = cleanDetails] = cleanDetails.split("Memory used:");
  const [memoryBlock, outputBlock] = afterMemory.split("Agent output:");

  if (!outputBlock) {
    return {
      memory: [],
      output: cleanDetails,
    };
  }

  return {
    memory: (memoryBlock ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    output: cleanDisplayText(outputBlock),
  };
}

function renderMemoryAnswer(answer: string): React.ReactNode[] {
  return cleanDisplayText(answer)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const heading = line.replace(/^#{1,6}\s*/, "");
      if (line.startsWith("#")) {
        return <h3 key={`${index}-${line}`}>{heading}</h3>;
      }
      if (line.startsWith("- ")) {
        return <p className="memory-answer-bullet" key={`${index}-${line}`}>{line.slice(2)}</p>;
      }

      return <p key={`${index}-${line}`}>{line}</p>;
    });
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

function memorySources(answer: MemoryAnswer): DataSearchResult[] {
  const seen = new Set<string>();
  const sources: DataSearchResult[] = [];

  for (const result of answer.results) {
    const key = (result.document.sourceUri || result.document.title).toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push(result);
  }

  return sources.slice(0, 5);
}

function memorySourceTitle(result: DataSearchResult): string {
  return result.document.sourceUri || result.document.title;
}

function memorySourceMatch(distance: number): string {
  const match = Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
  return `${match}% match`;
}

function memorySourceSnippet(content: string): string {
  const normalized = summarizeSourceContent(content);
  if (normalized.length <= 260) {
    return normalized;
  }

  return `${normalized.slice(0, 257).trimEnd()}...`;
}

function summarizeSourceContent(content: string): string {
  const cleaned = cleanDisplayText(content)
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "Source contains code or configuration details hidden from the answer view.";
  }

  return cleaned;
}

function cleanDisplayText(text: string): string {
  return removeCodeBlocks(text)
    .replace(/`([^`]+)`/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !looksLikeCodeLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").trim();
}

function looksLikeCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return [
    /^[{}[\],]+$/,
    /^"[^"]+"\s*:/,
    /^(const|let|var|function|import|export|type|interface|class)\s/,
    /^<\/?[A-Za-z][^>]*>$/,
    /^[A-Za-z0-9_.-]+\s*=\s*.+$/,
  ].some((pattern) => pattern.test(trimmed));
}

createRoot(document.getElementById("root")!).render(<App />);
