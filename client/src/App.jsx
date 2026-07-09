import React, { useState, useEffect, useRef } from "react";
import mammoth from "mammoth";
import {
  Plus, FileText, Mail, ClipboardList, Upload, Sparkles, Check, X,
  Loader2, ChevronRight, LogOut, Trash2, Download, Copy, RefreshCw,
  ArrowLeft, School, User, AlertCircle, BookOpen
} from "lucide-react";

const BASE = "/bodhiplanner";

const BLOOM_LEVELS = [
  { key: "remember", label: "Remember", verbs: "define, list, recall" },
  { key: "understand", label: "Understand", verbs: "explain, summarize" },
  { key: "apply", label: "Apply", verbs: "solve, demonstrate" },
  { key: "analyze", label: "Analyze", verbs: "compare, differentiate" },
  { key: "evaluate", label: "Evaluate", verbs: "justify, critique" },
  { key: "create", label: "Create", verbs: "design, compose" },
];

const BOARD_OPTIONS = {
  k12: ["CBSE", "ICSE", "State Board — Telangana", "State Board — Andhra Pradesh", "State Board — other", "IB (PYP/MYP/DP)", "Other"],
  he: ["UGC/AICTE-aligned university course", "Autonomous college curriculum", "Other"],
};

const WORKSHEET_TYPES = [
  { key: "practice", label: "Practice worksheet" },
  { key: "quiz", label: "Quiz with answer key" },
  { key: "activity", label: "Activity / group task" },
  { key: "rubric", label: "Grading rubric" },
];

// ─── API helper (calls our backend, NOT Claude directly) ─────────────────────

async function callClaude(system, userText, maxTokens = 1000) {
  const res = await fetch(`${BASE}/api/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ system, userText, maxTokens }),
  });
  if (res.status === 401) {
    window.location.href = `${BASE}/auth/login`;
    throw new Error("Session expired. Redirecting to login...");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Request failed (" + res.status + ")");
  }
  const data = await res.json();
  if (!data.text) throw new Error("No response text returned");
  return data.text;
}

function parseJSONLoose(text) {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (e2) { return null; } }
    return null;
  }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function download(filename, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

// ─── Local storage helpers ────────────────────────────────────────────────────

function saveLocal(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e){} }
function loadLocal(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch(e){ return null; } }

const emptyForm = () => ({
  level: "k12", board: "CBSE", boardOther: "", grade: "", subject: "",
  topic: "", standard: "", bloomLevels: [], objectives: "", criteria: "", referenceText: "",
});

function lessonPlanTitle(form) {
  return (form.topic || "Untitled topic") + " — " + (form.subject || "Subject") + " (" + (form.grade || "Grade") + ")";
}

function boardLabel(form) {
  return form.board === "Other" ? (form.boardOther || "Other") : form.board;
}

const PLAN_SCHEMA = `{
  "title": "string",
  "objectives": ["string"],
  "prerequisites": "string",
  "materials": ["string"],
  "structure": [{"phase": "string", "minutes": number, "description": "string"}],
  "differentiation": "string",
  "assessment": ["string"],
  "homework": "string",
  "standardAlignment": "string"
}`;

function buildPlanPrompt(form) {
  const levelLabel = form.level === "k12" ? "K-12" : "Higher education";
  const board = boardLabel(form);
  const blooms = form.bloomLevels.map((k) => {
    const b = BLOOM_LEVELS.find((x) => x.key === k);
    return b.label + " (" + b.verbs + ")";
  }).join(", ") || "not specified";
  let sys = "You are an expert curriculum designer for " + levelLabel + " education in India, aligned to " + board + ". ";
  sys += "Generate a complete, classroom-ready lesson plan. Be concise — short phrases and sentences, at most 5 items per list, so the whole response stays under 700 words. ";
  sys += "Respond with ONLY valid JSON matching this schema, no markdown fences, no preamble:\n" + PLAN_SCHEMA;
  let user = "Grade/Year: " + form.grade + "\nSubject: " + form.subject + "\nTopic: " + form.topic + "\n";
  user += "Curriculum standard: " + (form.standard || "not specified") + "\n";
  user += "Target Bloom's Taxonomy level(s): " + blooms + "\n";
  user += "Learning objective(s) from teacher: " + (form.objectives || "please propose suitable objectives") + "\n";
  user += "Additional criteria: " + (form.criteria || "none") + "\n";
  if (form.referenceText) {
    user += "\nReference material provided by the teacher:\n" + form.referenceText.slice(0, 4000);
  }
  return { sys, user };
}

function planToMarkdown(plan) {
  const c = plan.content || {};
  const lines = [];
  lines.push("# " + (c.title || lessonPlanTitle(plan.form)));
  lines.push("", "**Board:** " + boardLabel(plan.form) + "  ");
  lines.push("**Grade/Year:** " + plan.form.grade + "  ");
  lines.push("**Subject / Topic:** " + plan.form.subject + " — " + plan.form.topic + "  ");
  lines.push("**Standard:** " + (plan.form.standard || "—") + "  ");
  lines.push("**Bloom's level(s):** " + plan.form.bloomLevels.map((k) => BLOOM_LEVELS.find((b) => b.key === k)?.label).join(", "));
  lines.push("");
  if (c.objectives) { lines.push("## Learning objectives"); c.objectives.forEach((o) => lines.push("- " + o)); lines.push(""); }
  if (c.prerequisites) { lines.push("## Prerequisite knowledge", c.prerequisites, ""); }
  if (c.materials) { lines.push("## Materials"); c.materials.forEach((m) => lines.push("- " + m)); lines.push(""); }
  if (c.structure) { lines.push("## Lesson structure"); c.structure.forEach((s) => lines.push("- **" + s.phase + "** (" + s.minutes + " min): " + s.description)); lines.push(""); }
  if (c.differentiation) { lines.push("## Differentiation", c.differentiation, ""); }
  if (c.assessment) { lines.push("## Formative assessment"); c.assessment.forEach((a) => lines.push("- " + a)); lines.push(""); }
  if (c.homework) { lines.push("## Homework / extension", c.homework, ""); }
  if (c.standardAlignment) { lines.push("## Standard alignment", c.standardAlignment, ""); }
  return lines.join("\n");
}

// ─── Main App Component ───────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState("loading");
  const [user, setUser] = useState(null);
  const [plans, setPlans] = useState([]);
  const [currentPlanId, setCurrentPlanId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState("");
  const [fileNote, setFileNote] = useState("");
  const fileInputRef = useRef(null);

  // Check auth on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/auth/me`, { credentials: "same-origin" });
        const data = await res.json();
        if (data.user) {
          setUser(data.user);
          setPlans(loadLocal("lesson-plans") || []);
          setView("dashboard");
        } else {
          setView("login");
        }
      } catch (e) {
        setView("login");
      }
    })();
  }, []);

  const currentPlan = plans.find((p) => p.id === currentPlanId) || null;

  function updatePlan(id, updater) {
    setPlans((prev) => {
      const next = prev.map((p) => (p.id === id ? updater(p) : p));
      saveLocal("lesson-plans", next);
      return next;
    });
  }

  async function handleLogout() {
    await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "same-origin" });
    setUser(null);
    setView("login");
  }

  function toggleBloom(key) {
    setForm((f) => {
      const has = f.bloomLevels.includes(key);
      return { ...f, bloomLevels: has ? f.bloomLevels.filter((k) => k !== key) : [...f.bloomLevels, key] };
    });
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setFileNote("");
    const ext = file.name.split(".").pop().toLowerCase();
    try {
      if (ext === "txt" || ext === "md") {
        const text = await file.text();
        setForm((f) => ({ ...f, referenceText: text.slice(0, 6000) }));
        setFileNote("Loaded " + file.name + " (" + Math.min(text.length, 6000) + " chars).");
      } else if (ext === "docx") {
        const buf = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: buf });
        setForm((f) => ({ ...f, referenceText: result.value.slice(0, 6000) }));
        setFileNote("Extracted text from " + file.name + ".");
      } else {
        setFileNote("Supports .txt, .md, .docx. For other formats, paste text below.");
      }
    } catch (err) {
      setFileNote("Couldn't read that file — try pasting the text instead.");
    }
  }

  async function suggestObjectives() {
    if (!form.topic || form.bloomLevels.length === 0) {
      setError("Add a topic and at least one Bloom's level first."); return;
    }
    setLoading("objectives"); setError("");
    try {
      const blooms = form.bloomLevels.map((k) => BLOOM_LEVELS.find((b) => b.key === k).label).join(", ");
      const text = await callClaude(
        "You write concise learning objectives for lesson plans. Reply with 2-3 objectives as plain lines, no numbering, each starting with a measurable action verb.",
        "Grade: " + form.grade + ". Subject: " + form.subject + ". Topic: " + form.topic + ". Bloom's level(s): " + blooms, 300
      );
      setForm((f) => ({ ...f, objectives: text.trim() }));
    } catch (err) { setError(err.message); }
    finally { setLoading(null); }
  }

  async function generatePlan() {
    if (!form.subject || !form.topic || !form.grade) {
      setError("Fill in grade, subject, and topic before generating."); return;
    }
    setLoading("plan"); setError("");
    try {
      const { sys, user: userText } = buildPlanPrompt(form);
      const raw = await callClaude(sys, userText, 1000);
      const parsed = parseJSONLoose(raw);
      const id = uid();
      const newPlan = { id, form: { ...form }, content: parsed, rawFallback: parsed ? null : raw, worksheets: [], emails: [], createdAt: Date.now() };
      const next = [newPlan, ...plans];
      setPlans(next); saveLocal("lesson-plans", next);
      setCurrentPlanId(id); setView("plan");
    } catch (err) { setError(err.message); }
    finally { setLoading(null); }
  }

  async function regenerateSection(field) {
    if (!currentPlan) return;
    setLoading("section-" + field); setError("");
    try {
      const { sys } = buildPlanPrompt(currentPlan.form);
      const focusedSys = sys + "\nOnly revise the \"" + field + "\" field. Return the full JSON schema, change only \"" + field + "\".";
      const userText = "Current plan JSON:\n" + JSON.stringify(currentPlan.content) + "\n\nRevise only \"" + field + "\".";
      const raw = await callClaude(focusedSys, userText, 1000);
      const parsed = parseJSONLoose(raw);
      if (parsed && parsed[field] !== undefined) {
        updatePlan(currentPlan.id, (p) => ({ ...p, content: { ...p.content, [field]: parsed[field] } }));
      } else { setError("Couldn't parse the regenerated section — try again."); }
    } catch (err) { setError(err.message); }
    finally { setLoading(null); }
  }

  function editField(field, value) {
    if (!currentPlan) return;
    updatePlan(currentPlan.id, (p) => ({ ...p, content: { ...p.content, [field]: value } }));
  }

  async function generateWorksheet(type, count, variant) {
    if (!currentPlan) return;
    setLoading("worksheet"); setError("");
    try {
      const sys = "You create classroom worksheets aligned to a lesson plan's objectives and Bloom's level. Be concise. Respond with ONLY valid JSON: " +
        '{"title":"string","instructions":"string","items":[{"prompt":"string","options":["string"]}],"answerKey":["string"]}' +
        ". Omit options for non-MCQ. Include answerKey only for quiz type.";
      const u = "Lesson plan:\n" + JSON.stringify(currentPlan.content) + "\n\nType: " + type + "\nItems: " + count + (variant ? "\nDifficulty: " + variant : "");
      const raw = await callClaude(sys, u, 1000);
      const parsed = parseJSONLoose(raw);
      const ws = { id: uid(), type, variant: variant || "standard", content: parsed, rawFallback: parsed ? null : raw, createdAt: Date.now() };
      updatePlan(currentPlan.id, (p) => ({ ...p, worksheets: [ws, ...p.worksheets] }));
    } catch (err) { setError(err.message); }
    finally { setLoading(null); }
  }

  async function generateEmail({ studentName, bullets, tone, language }) {
    if (!currentPlan) return;
    setLoading("email"); setError("");
    try {
      const sys = "You draft short, warm emails from teacher to parent about student progress. " +
        (language === "Telugu" ? "Write in Telugu script. " : "Write in English. ") +
        "Tone: " + tone + '. Respond with ONLY valid JSON: {"subject":"string","body":"string"}.';
      const u = "Student: " + (studentName || "the student") + "\nContext: " + currentPlan.form.subject + " — " + currentPlan.form.topic +
        "\nNotes:\n" + bullets.filter(Boolean).map((b) => "- " + b).join("\n");
      const raw = await callClaude(sys, u, 800);
      const parsed = parseJSONLoose(raw);
      const em = { id: uid(), studentName, language, tone, content: parsed, rawFallback: parsed ? null : raw, createdAt: Date.now() };
      updatePlan(currentPlan.id, (p) => ({ ...p, emails: [em, ...p.emails] }));
    } catch (err) { setError(err.message); }
    finally { setLoading(null); }
  }

  function deletePlan(id) {
    const next = plans.filter((p) => p.id !== id);
    setPlans(next); saveLocal("lesson-plans", next);
    if (currentPlanId === id) { setCurrentPlanId(null); setView("dashboard"); }
  }

  function startNewPlan() { setForm(emptyForm()); setFileNote(""); setError(""); setView("new"); }

  // ─── Loading state ──────────────────────────────────────────────────────────
  if (view === "loading") {
    return <div className="app"><div className="login-wrap"><Loader2 className="spin" size={32} /></div></div>;
  }

  // ─── Login view (redirects to Moodle OAuth) ────────────────────────────────
  if (view === "login") {
    return (
      <div className="app">
        <div className="login-wrap">
          <div className="login-card">
            <div className="login-brand">Bodhi Planner</div>
            <div className="login-tag">Lesson plans, worksheets, and parent updates — built around Bloom's Taxonomy.</div>
            <a href={`${BASE}/auth/login`} className="btn btn-primary" style={{ width: "100%", justifyContent: "center", textDecoration: "none" }}>
              Sign in with Google <ChevronRight size={16} />
            </a>
            <div className="oauth-note">
              Sign in with your Google account to access Bodhi Planner. Your lesson plans are saved locally in your browser.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Authenticated layout ──────────────────────────────────────────────────
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">Bodhi Planner</div>
          <div className="brand-tag">Bloom's-aligned lesson design</div>
        </div>
        <button className={"tab" + (view === "dashboard" ? " active" : "")} onClick={() => setView("dashboard")}>
          <BookOpen size={16} /> Dashboard
        </button>
        <button className={"tab" + (view === "new" ? " active" : "")} onClick={startNewPlan}>
          <Plus size={16} /> New lesson plan
        </button>
        <button className={"tab" + (view === "plan" ? " active" : "")} disabled={!currentPlan} onClick={() => currentPlan && setView("plan")}>
          <FileText size={16} /> Lesson plan
        </button>
        <button className={"tab" + (view === "worksheets" ? " active" : "")} disabled={!currentPlan} onClick={() => currentPlan && setView("worksheets")}>
          <ClipboardList size={16} /> Worksheets
        </button>
        <button className={"tab" + (view === "email" ? " active" : "")} disabled={!currentPlan} onClick={() => currentPlan && setView("email")}>
          <Mail size={16} /> Parent email
        </button>
        <div className="sidebar-foot">
          <div className="user-row"><User size={14} /> {user?.name}</div>
          <button className="signout" onClick={handleLogout}><LogOut size={12} /> Sign out</button>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="error-banner"><AlertCircle size={15} /> {error}
            <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={() => setError("")}><X size={14} /></button>
          </div>
        )}
        {view === "dashboard" && <DashboardView plans={plans} onOpen={(id) => { setCurrentPlanId(id); setView("plan"); }} onDelete={deletePlan} onNew={startNewPlan} />}
        {view === "new" && <NewPlanView form={form} setForm={setForm} toggleBloom={toggleBloom} onFile={handleFile} fileNote={fileNote} fileInputRef={fileInputRef} onSuggest={suggestObjectives} loadingObjectives={loading === "objectives"} onGenerate={generatePlan} loadingPlan={loading === "plan"} />}
        {view === "plan" && currentPlan && <PlanView plan={currentPlan} onEditField={editField} onRegenerate={regenerateSection} loading={loading} onGoWorksheets={() => setView("worksheets")} onGoEmail={() => setView("email")} />}
        {view === "worksheets" && currentPlan && <WorksheetsView plan={currentPlan} onGenerate={generateWorksheet} loading={loading === "worksheet"} />}
        {view === "email" && currentPlan && <EmailView plan={currentPlan} onGenerate={generateEmail} loading={loading === "email"} />}
      </main>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function DashboardView({ plans, onOpen, onDelete, onNew }) {
  return (
    <div>
      <div className="plan-header">
        <h1 style={{ fontSize: 26 }}>Your lesson plans</h1>
        <button className="btn btn-primary" onClick={onNew}><Plus size={16} /> New lesson plan</button>
      </div>
      {plans.length === 0 ? (
        <div className="empty-state"><p>No lesson plans yet. Start one and it'll show up here.</p></div>
      ) : plans.map((p) => (
        <div className="plan-list-item" key={p.id}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.content?.title || lessonPlanTitle(p.form)}</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{boardLabel(p.form)} · {p.form.grade} · {p.worksheets.length} worksheet{p.worksheets.length !== 1 ? "s" : ""}</div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn btn-secondary" onClick={() => onOpen(p.id)}>Open</button>
            <button className="btn-danger" onClick={() => onDelete(p.id)}><Trash2 size={15} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── New Plan Form ────────────────────────────────────────────────────────────

function NewPlanView({ form, setForm, toggleBloom, onFile, fileNote, fileInputRef, onSuggest, loadingObjectives, onGenerate, loadingPlan }) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const boards = BOARD_OPTIONS[form.level];
  return (
    <div>
      <h1 style={{ fontSize: 26, marginBottom: 20 }}>New lesson plan</h1>
      <div className="card">
        <div className="field"><label>Education level</label>
          <div className="segmented">
            <button className={form.level === "k12" ? "active" : ""} onClick={() => setForm((f) => ({ ...f, level: "k12", board: BOARD_OPTIONS.k12[0] }))}>K-12</button>
            <button className={form.level === "he" ? "active" : ""} onClick={() => setForm((f) => ({ ...f, level: "he", board: BOARD_OPTIONS.he[0] }))}>Higher Ed</button>
          </div>
        </div>
        <div className="row">
          <div className="field"><label>Board / Framework</label>
            <select value={form.board} onChange={set("board")}>{boards.map((b) => <option key={b}>{b}</option>)}</select>
          </div>
          <div className="field"><label>Grade / Year</label>
            <input type="text" value={form.grade} onChange={set("grade")} placeholder="e.g. Class 9" />
          </div>
        </div>
        <div className="row">
          <div className="field"><label>Subject</label><input type="text" value={form.subject} onChange={set("subject")} placeholder="e.g. Mathematics" /></div>
          <div className="field"><label>Topic</label><input type="text" value={form.topic} onChange={set("topic")} placeholder="e.g. Quadratic Equations" /></div>
        </div>
        <div className="field"><label>Curriculum standard (optional)</label><input type="text" value={form.standard} onChange={set("standard")} placeholder="e.g. NCERT Ch 4" /></div>
      </div>

      <div className="card">
        <div className="field"><label>Bloom's Taxonomy levels</label>
          <div className="bloom-steps">
            {BLOOM_LEVELS.map((b, i) => {
              const active = form.bloomLevels.includes(b.key);
              return (
                <button key={b.key} className="bloom-step" onClick={() => toggleBloom(b.key)}>
                  <div className="block" style={{ height: 30 + i * 12, background: active ? "var(--marigold-light)" : "var(--card)", borderColor: active ? "var(--marigold)" : "var(--border)" }}>
                    {active && <Check size={14} color="var(--marigold-dark)" />}
                  </div>
                  <div className="lbl">{b.label}<small>{b.verbs}</small></div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Learning objectives</label>
          <textarea value={form.objectives} onChange={set("objectives")} placeholder="Describe what students should be able to do after this lesson…" />
          <button className="btn btn-ghost" onClick={onSuggest} disabled={loadingObjectives} style={{ marginTop: 6 }}>
            {loadingObjectives ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Suggest objectives
          </button>
        </div>
        <div className="field"><label>Additional criteria (optional)</label><textarea value={form.criteria} onChange={set("criteria")} placeholder="e.g. Include a group activity, keep it under 40 mins…" /></div>
      </div>

      <div className="card">
        <div className="field"><label>Reference material (optional)</label>
          <div className="upload-box" onClick={() => fileInputRef.current?.click()}>
            <Upload size={18} /> Upload .txt, .md, or .docx
            <input ref={fileInputRef} type="file" accept=".txt,.md,.docx" onChange={onFile} />
          </div>
          {fileNote && <div className="note-banner">{fileNote}</div>}
        </div>
        <div className="field"><label>Or paste text</label><textarea value={form.referenceText} onChange={set("referenceText")} rows={4} placeholder="Paste relevant textbook content here…" /></div>
      </div>

      <button className="btn btn-primary" onClick={onGenerate} disabled={loadingPlan}>
        {loadingPlan ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} Generate lesson plan
      </button>
    </div>
  );
}

// ─── Plan View ────────────────────────────────────────────────────────────────

function PlanView({ plan, onEditField, onRegenerate, loading, onGoWorksheets, onGoEmail }) {
  const c = plan.content || {};
  if (!c.title && plan.rawFallback) {
    return <div className="card"><h2>Generated (raw)</h2><pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{plan.rawFallback}</pre></div>;
  }
  const Section = ({ title, field, children }) => (
    <div style={{ marginBottom: 20 }}>
      <div className="section-title-row">
        <h3>{title}</h3>
        <button className="icon-btn" onClick={() => onRegenerate(field)} disabled={loading === "section-" + field}>
          {loading === "section-" + field ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {children}
    </div>
  );
  return (
    <div>
      <div className="plan-header">
        <h1 style={{ fontSize: 24 }}>{c.title}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => download((c.title || "plan") + ".md", planToMarkdown(plan))}><Download size={14} /> Export</button>
          <button className="btn btn-secondary" onClick={() => copyText(planToMarkdown(plan))}><Copy size={14} /> Copy</button>
        </div>
      </div>
      <div className="meta-row">
        <span className="chip">{boardLabel(plan.form)}</span>
        <span className="chip">{plan.form.grade}</span>
        <span className="chip">{plan.form.subject}</span>
        {plan.form.bloomLevels.map((k) => <span key={k} className="chip">{BLOOM_LEVELS.find((b) => b.key === k)?.label}</span>)}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        {c.objectives && <Section title="Learning Objectives" field="objectives"><ul>{c.objectives.map((o, i) => <li key={i}>{o}</li>)}</ul></Section>}
        {c.prerequisites && <Section title="Prerequisites" field="prerequisites"><p>{c.prerequisites}</p></Section>}
        {c.materials && <Section title="Materials" field="materials"><ul>{c.materials.map((m, i) => <li key={i}>{m}</li>)}</ul></Section>}
        {c.structure && <Section title="Lesson Structure" field="structure">
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
            <tbody>{c.structure.map((s, i) => <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}><td style={{ padding: "6px 8px", fontWeight: 600 }}>{s.phase}</td><td style={{ padding: "6px 8px" }}>{s.minutes} min</td><td style={{ padding: "6px 8px" }}>{s.description}</td></tr>)}</tbody>
          </table>
        </Section>}
        {c.differentiation && <Section title="Differentiation" field="differentiation"><p>{c.differentiation}</p></Section>}
        {c.assessment && <Section title="Formative Assessment" field="assessment"><ul>{c.assessment.map((a, i) => <li key={i}>{a}</li>)}</ul></Section>}
        {c.homework && <Section title="Homework" field="homework"><p>{c.homework}</p></Section>}
        {c.standardAlignment && <Section title="Standard Alignment" field="standardAlignment"><p>{c.standardAlignment}</p></Section>}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
        <button className="btn btn-secondary" onClick={onGoWorksheets}><ClipboardList size={14} /> Generate worksheets</button>
        <button className="btn btn-secondary" onClick={onGoEmail}><Mail size={14} /> Draft parent email</button>
      </div>
    </div>
  );
}

// ─── Worksheets View ──────────────────────────────────────────────────────────

function WorksheetsView({ plan, onGenerate, loading }) {
  const [type, setType] = useState("practice");
  const [count, setCount] = useState("5");
  const [variant, setVariant] = useState("");
  return (
    <div>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Worksheets</h1>
      <div className="card">
        <div className="row">
          <div className="field"><label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {WORKSHEET_TYPES.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
            </select>
          </div>
          <div className="field"><label>Number of items</label>
            <input type="text" value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <div className="field"><label>Difficulty (optional)</label>
            <input type="text" value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="e.g. easy, medium, hard" />
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => onGenerate(type, parseInt(count) || 5, variant)} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} Generate worksheet
        </button>
      </div>
      {plan.worksheets.map((ws) => (
        <div key={ws.id} className="card worksheet-item">
          <h3>{ws.content?.title || ws.type}</h3>
          {ws.content?.instructions && <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>{ws.content.instructions}</p>}
          {ws.content?.items && (
            <ol className="list-numbered">
              {ws.content.items.map((item, i) => (
                <li key={i}>{item.prompt}{item.options && <ul>{item.options.map((o, j) => <li key={j} style={{ listStyle: "lower-alpha" }}>{o}</li>)}</ul>}</li>
              ))}
            </ol>
          )}
          {ws.content?.answerKey && <div style={{ marginTop: 10, fontSize: 12, color: "var(--teal)" }}><strong>Answer key:</strong> {ws.content.answerKey.join(", ")}</div>}
          {ws.rawFallback && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{ws.rawFallback}</pre>}
        </div>
      ))}
    </div>
  );
}

// ─── Email View ───────────────────────────────────────────────────────────────

function EmailView({ plan, onGenerate, loading }) {
  const [studentName, setStudentName] = useState("");
  const [bullets, setBullets] = useState(["", "", ""]);
  const [tone, setTone] = useState("warm");
  const [language, setLanguage] = useState("English");
  const setBullet = (i, v) => setBullets((b) => b.map((x, j) => (j === i ? v : x)));
  return (
    <div>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Parent email</h1>
      <div className="card">
        <div className="row">
          <div className="field"><label>Student name</label><input type="text" value={studentName} onChange={(e) => setStudentName(e.target.value)} placeholder="e.g. Rahul" /></div>
          <div className="field"><label>Tone</label>
            <select value={tone} onChange={(e) => setTone(e.target.value)}><option>warm</option><option>formal</option><option>encouraging</option></select>
          </div>
          <div className="field"><label>Language</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}><option>English</option><option>Telugu</option></select>
          </div>
        </div>
        <div className="field"><label>Progress notes (bullet points)</label>
          {bullets.map((b, i) => <input key={i} type="text" value={b} onChange={(e) => setBullet(i, e.target.value)} placeholder={"Point " + (i + 1)} style={{ marginBottom: 6 }} />)}
          <button className="btn btn-ghost" onClick={() => setBullets([...bullets, ""])}>+ Add point</button>
        </div>
        <button className="btn btn-primary" onClick={() => onGenerate({ studentName, bullets, tone, language })} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <Mail size={16} />} Generate email
        </button>
      </div>
      {plan.emails.map((em) => (
        <div key={em.id} className="card">
          <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 4 }}>{em.studentName} · {em.language} · {em.tone}</div>
          {em.content && <>
            <h3 style={{ fontSize: 15 }}>{em.content.subject}</h3>
            <p style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.6 }}>{em.content.body}</p>
            <button className="btn btn-ghost" onClick={() => copyText(em.content.subject + "\n\n" + em.content.body)}><Copy size={13} /> Copy</button>
          </>}
          {em.rawFallback && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{em.rawFallback}</pre>}
        </div>
      ))}
    </div>
  );
}
