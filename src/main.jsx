import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clipboard,
  CloudCog,
  FileDown,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import "./styles.css";

import {
  stages,
  validateQuestion,
  formattedCopy,
} from "../shared/assessment.js";
import { api } from "./lib/api.js";
import { downloadAssessmentPdf } from "./lib/export-pdf.js";

function safeText(value) {
  return String(value ?? "").trim();
}

function itemQuestion(item, type) {
  if (type === "mcq") return item.stem || "";
  if (type === "truefalse") return item.statement || "";
  return item.task || "";
}

function setQuestion(item, type, value) {
  if (type === "mcq") return { ...item, stem: value };
  if (type === "truefalse") return { ...item, statement: value };
  return { ...item, task: value };
}

function topicsFromSource(sourceText) {
  const candidates = [];
  const add = (value) => {
    const topic = value.replace(/\s+/g, " ").replace(/[*_`#]+/g, "").trim().replace(/[:.;]+$/, "");
    if (topic.length < 3 || topic.length > 120) return;
    if (!candidates.some((existing) => existing.toLocaleLowerCase() === topic.toLocaleLowerCase()))
      candidates.push(topic);
  };
  for (const match of sourceText.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) add(match[1]);
  for (const match of sourceText.matchAll(/\*\*([^*]{3,100})\*\*/g)) add(match[1]);
  if (candidates.length < 2) {
    for (const paragraph of sourceText.split(/\n\s*\n/)) {
      const normalized = paragraph.replace(/^\s{0,3}#{1,6}\s+/gm, "").trim();
      const sentence = normalized.match(/^(.{12,140}?[.!?])(?:\s|$)/)?.[1] || normalized.slice(0, 100);
      add(sentence);
    }
  }
  return candidates.slice(0, 20).map((title, index) => ({ id: `source-topic-${index}`, title }));
}

function App() {
  const assessmentConfig = useRef(null);
  const modelRequest = useRef(0);
  const operation = useRef(false);
  const [settings, setSettings] = useState({
    provider: "gemini",
    model: "",
    hasGeminiKey: false,
    hasNvidiaKey: false,
  });
  const [provider, setProvider] = useState("gemini");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [toast, setToast] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [started, setStarted] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState([]);
  const [working, setWorking] = useState(false);
  const [gap, setGap] = useState(null);
  const [extraText, setExtraText] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [comments, setComments] = useState({});
  const [complete, setComplete] = useState(false);
  const [approved, setApproved] = useState({});
  const [copied, setCopied] = useState("");
  const [regenId, setRegenId] = useState("");
  const [topicFlowOpen, setTopicFlowOpen] = useState(false);
  const [topicOrigin, setTopicOrigin] = useState("start");
  const [topicInput, setTopicInput] = useState("");
  const [topicSuggestions, setTopicSuggestions] = useState([]);
  const [chosenTopics, setChosenTopics] = useState([]);
  const [materialDraft, setMaterialDraft] = useState("");
  const [developing, setDeveloping] = useState(false);
  const [developmentError, setDevelopmentError] = useState("");
  const [topicPlanOpen, setTopicPlanOpen] = useState(false);
  const [topicOptions, setTopicOptions] = useState([]);
  const [selectedPlanTopics, setSelectedPlanTopics] = useState([]);
  const [customPlanTopic, setCustomPlanTopic] = useState("");
  const [topicPlanError, setTopicPlanError] = useState("");

  const stage = stages[stageIndex];
  const keyAvailable =
    provider === "gemini" ? settings.hasGeminiKey : settings.hasNvidiaKey;
  const currentKey = apiKey || "";
  const workflowReady =
    Boolean(settings.model) &&
    (settings.provider === "gemini"
      ? settings.hasGeminiKey
      : settings.hasNvidiaKey);

  useEffect(() => {
    api("/api/settings")
      .then((data) => {
        setSettings(data);
        setProvider(data.provider);
        setModel(data.model);
        setModels(data.model ? [{ id: data.model, label: data.model }] : []);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function loadModels() {
    if (started) return;
    const requestId = ++modelRequest.current;
    setLoadingModels(true);
    setError("");
    try {
      const data = await api("/api/models", {
        method: "POST",
        body: JSON.stringify({
          provider,
          ...(currentKey ? { apiKey: currentKey } : {}),
        }),
      });
      if (requestId !== modelRequest.current) return;
      setModels(data.models || []);
      const savedModel = provider === settings.provider ? settings.model : "";
      setModel(
        savedModel && data.models.some((item) => item.id === savedModel)
          ? savedModel
          : data.models[0]?.id || "",
      );
      if (!data.models?.length)
        setError("No text generation models were returned for this key.");
    } catch (e) {
      if (requestId === modelRequest.current) {
        setError(e.message);
        setModels([]);
      }
    } finally {
      if (requestId === modelRequest.current) setLoadingModels(false);
    }
  }

  async function saveSettings() {
    if (started) return;
    setSavingSettings(true);
    setError("");
    try {
      const payload = {
        provider,
        model,
        ...(apiKey
          ? { [provider === "gemini" ? "geminiKey" : "nvidiaKey"]: apiKey }
          : {}),
      };
      const saved = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setSettings(saved);
      setApiKey("");
      setToast("Settings saved securely on this Windows account.");
      setSettingsOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function generateCategory(
    type = stage.id,
    feedback = "",
    single = false,
    material = sourceText,
  ) {
    if (operation.current) return;
    operation.current = true;
    const configuration = assessmentConfig.current || settings;
    setWorking(true);
    setError("");
    if (!single) setGap(null);
    try {
      const result = await api("/api/generate", {
        method: "POST",
        body: JSON.stringify({
          provider: configuration.provider,
          model: configuration.model,
          type,
          sourceText: material,
          feedback,
          single,
          selectedTopics: configuration.selectedTopics || [],
        }),
      });
      if (result.status === "gap" && single)
        return { status: "gap", ...result };
      else if (result.status === "gap") {
        setGap(result);
        setItems([]);
        setSelected([]);
      } else if (single) return result.items?.[0];
      else {
        setItems(result.items || []);
        setSelected([]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      operation.current = false;
      setWorking(false);
    }
  }

  async function startWorkflow(material = sourceText) {
    if (operation.current) return;
    if (!material.trim()) {
      setError("Paste the reading material first.");
      return;
    }
    if (!workflowReady) {
      setError("Add an API key and choose a model in Settings first.");
      setSettingsOpen(true);
      return;
    }
    assessmentConfig.current = { provider: settings.provider, model: settings.model, selectedTopics: [] };
    setProvider(settings.provider);
    setModel(settings.model);
    setEditing(null);
    setComments({});
    setStarted(false);
    setComplete(false);
    setStageIndex(0);
    setApproved({});
    setSourceText(material.trim());
    const topics = topicsFromSource(material.trim());
    setTopicOptions(topics);
    setSelectedPlanTopics(topics.map((topic) => topic.id));
    setCustomPlanTopic("");
    setTopicPlanError("");
    setTopicPlanOpen(true);
  }

  async function beginAssessment() {
    const selectedTopics = topicOptions
      .filter((topic) => selectedPlanTopics.includes(topic.id))
      .map((topic) => topic.title);
    if (!selectedTopics.length) {
      setTopicPlanError("Choose at least one topic before generating questions.");
      return;
    }
    assessmentConfig.current = {
      provider: settings.provider,
      model: settings.model,
      selectedTopics,
    };
    setTopicPlanOpen(false);
    setStarted(true);
    setComplete(false);
    setStageIndex(0);
    setApproved({});
    setItems([]);
    setSelected([]);
    setGap(null);
    setEditing(null);
    setComments({});
    await generateCategory("mcq", "", false, sourceText.trim());
  }

  function addPlanTopic() {
    const title = customPlanTopic.trim();
    if (!title) return;
    if (title.length > 120) {
      setTopicPlanError("Keep each topic under 120 characters.");
      return;
    }
    if (topicOptions.some((topic) => topic.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
      setTopicPlanError("That topic is already in the list.");
      return;
    }
    if (topicOptions.length >= 20) {
      setTopicPlanError("Choose up to 20 topics.");
      return;
    }
    const id = `custom-topic-${Date.now()}`;
    setTopicOptions((previous) => [...previous, { id, title }]);
    setSelectedPlanTopics((previous) => [...previous, id]);
    setCustomPlanTopic("");
    setTopicPlanError("");
  }

  function openTopicFlow(origin) {
    setTopicOrigin(origin);
    setTopicInput(origin === "gap" ? (gap?.missingTopics || []).join("\n") : "");
    setTopicSuggestions([]);
    setChosenTopics([]);
    setMaterialDraft("");
    setDevelopmentError("");
    setTopicFlowOpen(true);
  }

  async function suggestMaterialTopics() {
    if (!topicInput.trim()) {
      setDevelopmentError("Add a rough topic or concept first.");
      return;
    }
    const configuration = assessmentConfig.current || settings;
    if (!configuration.model) {
      setDevelopmentError("Choose a provider and model in Settings first.");
      return;
    }
    setDeveloping(true);
    setDevelopmentError("");
    setTopicSuggestions([]);
    setChosenTopics([]);
    setMaterialDraft("");
    try {
      const result = await api("/api/material/suggest", {
        method: "POST",
        body: JSON.stringify({
          provider: configuration.provider,
          model: configuration.model,
          topicInput: topicInput.trim(),
          sourceText,
        }),
      });
      setTopicSuggestions(result.topics || []);
    } catch (e) {
      setDevelopmentError(e.message);
    } finally {
      setDeveloping(false);
    }
  }

  async function draftSelectedMaterial() {
    if (!chosenTopics.length) return;
    const configuration = assessmentConfig.current || settings;
    setDeveloping(true);
    setDevelopmentError("");
    try {
      const result = await api("/api/material/draft", {
        method: "POST",
        body: JSON.stringify({
          provider: configuration.provider,
          model: configuration.model,
          topics: topicSuggestions
            .filter((topic) => chosenTopics.includes(topic.id))
            .map((topic) => topic.title),
          sourceText,
        }),
      });
      setMaterialDraft(result.material || "");
    } catch (e) {
      setDevelopmentError(e.message);
    } finally {
      setDeveloping(false);
    }
  }

  async function acceptDevelopedMaterial() {
    const addition = materialDraft.trim();
    if (!addition) return;
    const nextSource = [sourceText.trim(), addition].filter(Boolean).join("\n\n");
    if (nextSource.length > 100000) {
      setDevelopmentError("Combined source material must be at most 100,000 characters.");
      return;
    }
    const newlyCoveredTopics = topicSuggestions
      .filter((topic) => chosenTopics.includes(topic.id))
      .map((topic) => topic.title);
    setSourceText(nextSource);
    setTopicFlowOpen(false);
    setTopicSuggestions([]);
    setChosenTopics([]);
    setMaterialDraft("");
    setDevelopmentError("");
    if (topicOrigin === "gap") {
      if (assessmentConfig.current) {
        assessmentConfig.current = {
          ...assessmentConfig.current,
          selectedTopics: [...new Set([
            ...(assessmentConfig.current.selectedTopics || []),
            ...newlyCoveredTopics,
          ])],
        };
      }
      setGap(null);
      setToast("Reviewed material added. Rechecking this category.");
      await generateCategory(stage.id, "", false, nextSource);
    } else {
      await startWorkflow(nextSource);
    }
  }

  function toggleSelection(id) {
    setSelected((previous) => {
      if (previous.includes(id)) return previous.filter((item) => item !== id);
      if (previous.length >= stage.target) {
        setToast("Select exactly " + stage.target + " questions to continue.");
        return previous;
      }
      return [...previous, id];
    });
  }

  function updateItem(id, patch) {
    setItems((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  async function regenerate(item) {
    const note = safeText(comments[item.id]);
    if (!note) {
      setToast("Add a short instruction for the regeneration first.");
      return;
    }
    setRegenId(item.id);
    setError("");
    const replacement = await generateCategory(stage.id, note, true);
    if (replacement?.status === "gap") {
      setToast(
        "This candidate cannot be regenerated from the source. Add material covering: " +
          (replacement.missingTopics || []).join(", "),
      );
    } else if (replacement) {
      const fresh = { ...replacement, id: item.id, approved: false };
      setItems((previous) =>
        previous.map((candidate) =>
          candidate.id === item.id ? fresh : candidate,
        ),
      );
      setSelected((previous) => previous.filter((id) => id !== item.id));
      setComments((previous) => ({ ...previous, [item.id]: "" }));
      setToast("Question regenerated with your direction.");
    }
    setRegenId("");
  }

  async function addMoreMaterial() {
    if (!extraText.trim()) return;
    if (sourceText.length + extraText.trim().length + 2 > 100000) {
      setError("Source material must be at most 100,000 characters.");
      return;
    }
    setSourceText((previous) => previous + "\n\n" + extraText.trim());
    setExtraText("");
    setGap(null);
    setToast("Added source material. Regenerate this category when ready.");
  }

  async function continueWorkflow() {
    if (operation.current) return;
    const accepted = items.filter((item) => selected.includes(item.id));
    if (accepted.length !== stage.target) return;
    let validated;
    try {
      validated = accepted.map((item) => ({
        ...validateQuestion(item, stage.id, sourceText),
        id: item.id,
        approved: true,
      }));
    } catch (e) {
      setError("Review the selected questions: " + e.message);
      return;
    }
    const nextApproved = { ...approved, [stage.id]: validated };
    setEditing(null);
    setComments({});
    setApproved(nextApproved);
    if (stageIndex >= stages.length - 1) {
      setComplete(true);
      setStarted(false);
      return;
    }
    const next = stageIndex + 1;
    setStageIndex(next);
    setItems([]);
    setSelected([]);
    setGap(null);
    await generateCategory(stages[next].id);
  }

  async function copyVersion(which) {
    try {
      await navigator.clipboard.writeText(
        formattedCopy(approved, which === "trainer"),
      );
      setCopied(which);
      setToast(
        (which === "trainer" ? "Trainer" : "Student") +
          " copy copied to clipboard.",
      );
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setToast("Clipboard access is unavailable in this browser.");
    }
  }

  async function downloadPdf(which) {
    try {
      await downloadAssessmentPdf(approved, which);
    } catch {
      setError("Could not create the PDF. Try copying the text instead.");
      setToast("PDF export failed. Try copying the text.");
    }
  }

  function closeSettings() {
    if (savingSettings) return;
    ++modelRequest.current;
    setLoadingModels(false);
    setProvider(settings.provider);
    setModel(settings.model);
    setModels(
      settings.model ? [{ id: settings.model, label: settings.model }] : [],
    );
    setApiKey("");
    setError("");
    setSettingsOpen(false);
  }

  useEffect(() => {
    if (!settingsOpen && !topicFlowOpen && !topicPlanOpen) return;
    const listener = (event) => {
      if (event.key === "Escape") {
        if (topicPlanOpen) setTopicPlanOpen(false);
        else if (topicFlowOpen && !developing) setTopicFlowOpen(false);
        else if (settingsOpen) closeSettings();
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [settingsOpen, savingSettings, settings, topicFlowOpen, topicPlanOpen, developing]);

  function reset() {
    if (operation.current) return;
    assessmentConfig.current = null;
    setStarted(false);
    setComplete(false);
    setItems([]);
    setApproved({});
    setSelected([]);
    setGap(null);
    setError("");
    setEditing(null);
    setComments({});
    setExtraText("");
    setTopicPlanOpen(false);
    setTopicOptions([]);
    setSelectedPlanTopics([]);
    setCustomPlanTopic("");
    setTopicPlanError("");
    setTopicFlowOpen(false);
    setTopicSuggestions([]);
    setChosenTopics([]);
    setMaterialDraft("");
    setStageIndex(0);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <BookOpen size={18} />
          </span>
          <span>
            Question<span className="brand-light">Studio</span>
          </span>
          <span className="brand-tag">BETA</span>
        </a>
        <div className="topbar-right">
          <span className="privacy">
            <LockKeyhole size={13} /> Local workspace
          </span>
          <button
            className="icon-button"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <main id="top">
        {!started && !complete && (
          <section className="intro-layout">
            <div className="intro-copy">
              <div className="eyebrow">
                <span className="eyebrow-line" /> ASSESSMENT WORKBENCH{" "}
                <span className="mono">/ 01—03</span>
              </div>
              <h1>
                Good questions
                <br />
                start with <em>good material.</em>
              </h1>
              <p className="intro-dek">
                Build a focused assessment from your reading material. Review
                every candidate, keep only what earns its place.
              </p>
              <div className="workflow-map">
                {stages.map((step, index) => (
                  <div className="workflow-row" key={step.id}>
                    <span className="workflow-num">0{index + 1}</span>
                    <span className="workflow-name">{step.label}</span>
                    <span className="workflow-count">{step.sub}</span>
                  </div>
                ))}
              </div>
              <div className="grounding-note">
                <ShieldCheck size={16} />
                <span>
                  Every candidate is checked against the material. Missing
                  coverage is flagged before you proceed.
                </span>
              </div>
            </div>
            <div className="source-panel">
              <div className="panel-top">
                <div>
                  <span className="section-number">01</span>
                  <h2>Bring in your material</h2>
                </div>
                <span className="micro-label">TEXT ONLY</span>
              </div>
              <p className="panel-hint">
                Paste lesson text with explanations and examples. A topic title alone isn't enough.
              </p>
              <div className="source-wrap">
                <textarea
                  maxLength={100000}
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  placeholder="Paste a lesson, chapter, article, or course notes…"
                  aria-label="Reading material"
                />
                <div className="source-footer">
                  <span>{sourceText.length.toLocaleString()} characters</span>
                  <span>Sent to selected provider</span>
                </div>
              </div>
              <button
                className="text-button develop-entry"
                onClick={() => openTopicFlow("start")}
                disabled={working}
              >
                <WandSparkles size={15} /> I have rough topics instead
              </button>
              <div className="provider-strip">
                <span className="provider-symbol">
                  {provider === "gemini" ? "✳" : "◈"}
                </span>
                <span>
                  <b>
                    {provider === "gemini" ? "Google Gemini" : "NVIDIA NIM"}
                  </b>
                  <small>
                    {model ||
                      (workflowReady
                        ? "Model not selected"
                        : "Connect a provider to begin")}
                  </small>
                </span>
                <button
                  className="text-button"
                  onClick={() => setSettingsOpen(true)}
                >
                  Configure <ArrowRight size={14} />
                </button>
              </div>
              {error && !settingsOpen && (
                <div className="inline-error">
                  <CircleHelp size={15} />
                  {error}
                </div>
              )}
              <button
                className="primary-button start-button"
                disabled={working}
                onClick={startWorkflow}
              >
                {working ? (
                  <>
                    <LoaderCircle className="spin" size={17} /> Preparing…
                  </>
                ) : (
                  <>
                    Choose topics first <ArrowRight size={17} />
                  </>
                )}
              </button>
              <div className="safe-caption">
                <LockKeyhole size={12} /> API keys are encrypted for your
                Windows account.
              </div>
            </div>
          </section>
        )}

        {started && (
          <section className="review-layout">
            <aside className="progress-rail">
              <div className="eyebrow">YOUR ASSESSMENT</div>
              <h2>
                Review
                <br />
                <em>in sequence.</em>
              </h2>
              <div className="progress-list">
                {stages.map((step, index) => (
                  <div
                    className={
                      "progress-step " +
                      (index === stageIndex
                        ? "active"
                        : index < stageIndex
                          ? "done"
                          : "")
                    }
                    key={step.id}
                  >
                    <span className="progress-dot">
                      {index < stageIndex ? (
                        <Check size={13} />
                      ) : (
                        "0" + (index + 1)
                      )}
                    </span>
                    <span>
                      <b>{step.label}</b>
                      <small>
                        {approved[step.id]?.length
                          ? approved[step.id].length + " approved"
                          : step.sub}
                      </small>
                    </span>
                    {index < stageIndex && (
                      <CheckCircle2 className="step-check" size={16} />
                    )}
                  </div>
                ))}
              </div>
              <div className="source-chip">
                <BookOpen size={14} />
                <span>
                  {sourceText.length.toLocaleString()} characters of source
                </span>
              </div>
              <button
                className="quiet-button"
                onClick={() => setSettingsOpen(true)}
              >
                <CloudCog size={15} />{" "}
                {provider === "gemini" ? "Gemini" : "NVIDIA"} ·{" "}
                {model || "no model"}
              </button>
              <button
                className="quiet-button"
                onClick={reset}
                disabled={working}
              >
                <ArrowLeft size={15} /> Discard assessment
              </button>
            </aside>
            <div className="review-main">
              <div className="review-heading">
                <div>
                  <div className="eyebrow">
                    <span className="eyebrow-line" /> STEP 0{stageIndex + 1}{" "}
                    <span className="mono">/ 03</span>
                  </div>
                  <h1>
                    {stage.label}
                    <span className="candidate-count">
                      {stage.total} candidates
                    </span>
                  </h1>
                  <p>
                    Choose {stage.target} to approve. Edit any candidate, or
                    leave a note to regenerate it.
                  </p>
                </div>
                <button
                  className="quiet-button regenerate-all"
                  onClick={() => generateCategory(stage.id)}
                  disabled={working}
                >
                  <RefreshCw size={14} className={working ? "spin" : ""} />{" "}
                  Regenerate set
                </button>
              </div>
              {error && (
                <div className="inline-error main-error">
                  <CircleHelp size={16} />
                  {error}
                </div>
              )}
              {working && (
                <div className="loading-card">
                  <div className="loading-orbit">
                    <Sparkles size={20} />
                  </div>
                  <div>
                    <b>Reading the material, then drafting candidates.</b>
                    <p>
                      This category is generated in a separate request so the
                      source stays in focus.
                    </p>
                  </div>
                  <LoaderCircle className="spin" size={18} />
                </div>
              )}
              {gap && (
                <div className="gap-card">
                  <div className="gap-icon">
                    <CircleHelp size={19} />
                  </div>
                  <div className="gap-content">
                    <div className="eyebrow">SOURCE COVERAGE GAP</div>
                    <h3>There isn’t enough material here yet.</h3>
                    <p>{gap.reason}</p>
                    {gap.missingTopics?.length > 0 && (
                      <div className="missing-topics">
                        {gap.missingTopics.map((topic) => (
                          <span key={topic}>{topic}</span>
                        ))}
                      </div>
                    )}
                    <label className="add-source-label">
                      Add material that covers these concepts
                      <textarea
                        value={extraText}
                        onChange={(e) => setExtraText(e.target.value)}
                        placeholder="Paste additional lesson notes or explanations…"
                      />
                    </label>
                    <div className="gap-actions">
                      <button
                        className="secondary-button"
                        onClick={() => openTopicFlow("gap")}
                        disabled={working}
                      >
                        <WandSparkles size={15} /> Develop missing topics
                      </button>
                      <button
                        className="secondary-button"
                        onClick={addMoreMaterial}
                        disabled={!extraText.trim()}
                      >
                        <Plus size={15} /> Add to source
                      </button>
                      <button
                        className="primary-button"
                        onClick={() => generateCategory(stage.id)}
                        disabled={working}
                      >
                        <RefreshCw size={15} /> Recheck this category
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {!working && !gap && items.length > 0 && (
                <>
                  <div className="selection-meter">
                    <span>
                      <b>{selected.length}</b> of {stage.target} selected
                    </span>
                    <div className="meter-track">
                      <span
                        style={{
                          width: (selected.length / stage.target) * 100 + "%",
                        }}
                      />
                    </div>
                    <span className="meter-note">
                      Choose {stage.target} to continue
                    </span>
                  </div>
                  <div className="candidate-grid">
                    {items.map((item, index) => {
                      const isSelected = selected.includes(item.id);
                      const isEditing = editing === item.id;
                      return (
                        <article
                          className={
                            "candidate-card " + (isSelected ? "selected" : "")
                          }
                          key={item.id}
                        >
                          <div className="candidate-card-top">
                            <button
                              className={
                                "select-candidate " +
                                (isSelected ? "checked" : "")
                              }
                              onClick={() => toggleSelection(item.id)}
                              aria-label={
                                isSelected
                                  ? "Unselect candidate"
                                  : "Select candidate"
                              }
                            >
                              {isSelected && <Check size={13} />}
                            </button>
                            <span className="candidate-index">
                              CANDIDATE 0{index + 1}
                            </span>
                            <div className="card-actions">
                              <button
                                className="small-icon"
                                title="Edit question"
                                onClick={() =>
                                  setEditing(isEditing ? null : item.id)
                                }
                              >
                                {isEditing ? (
                                  <Check size={14} />
                                ) : (
                                  <WandSparkles size={14} />
                                )}
                              </button>
                              <button
                                className="small-icon"
                                title="Remove this candidate"
                                onClick={() => {
                                  setItems((prev) =>
                                    prev.filter((c) => c.id !== item.id),
                                  );
                                  setSelected((prev) =>
                                    prev.filter((id) => id !== item.id),
                                  );
                                }}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                          {isEditing ? (
                            <div className="edit-fields">
                              {stage.id === "coding" && (
                                <input
                                  value={item.title || ""}
                                  placeholder="Question title"
                                  onChange={(e) =>
                                    updateItem(item.id, {
                                      title: e.target.value,
                                    })
                                  }
                                />
                              )}
                              <textarea
                                value={itemQuestion(item, stage.id)}
                                onChange={(e) =>
                                  updateItem(
                                    item.id,
                                    setQuestion(item, stage.id, e.target.value),
                                  )
                                }
                              />
                              {stage.id === "coding" && (
                                <>
                                  <label>
                                    Code snippet
                                    <textarea
                                      className="code-edit"
                                      value={item.codeSnippet || ""}
                                      onChange={(e) =>
                                        updateItem(item.id, {
                                          codeSnippet: e.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                </>
                              )}
                              {stage.id === "mcq" && (
                                <div className="option-edits">
                                  {item.options.map((option, optionIndex) => (
                                    <input
                                      key={optionIndex}
                                      value={option}
                                      onChange={(e) =>
                                        updateItem(item.id, {
                                          options: item.options.map(
                                            (value, n) =>
                                              n === optionIndex
                                                ? e.target.value
                                                : value,
                                          ),
                                        })
                                      }
                                    />
                                  ))}
                                </div>
                              )}
                              {stage.id === "truefalse" ? (
                                <select
                                  aria-label="Correct answer"
                                  value={String(item.correctAnswer)}
                                  onChange={(e) =>
                                    updateItem(item.id, {
                                      correctAnswer: e.target.value === "true",
                                    })
                                  }
                                >
                                  <option value="true">True</option>
                                  <option value="false">False</option>
                                </select>
                              ) : (
                                <input
                                  aria-label="Correct answer"
                                  value={
                                    stage.id === "mcq"
                                      ? item.correctAnswer
                                      : item.expectedAnswer
                                  }
                                  onChange={(e) =>
                                    updateItem(
                                      item.id,
                                      stage.id === "mcq"
                                        ? {
                                            correctAnswer:
                                              e.target.value.toUpperCase(),
                                          }
                                        : { expectedAnswer: e.target.value },
                                    )
                                  }
                                  placeholder="Correct answer"
                                />
                              )}
                              <textarea
                                value={item.explanation || ""}
                                onChange={(e) =>
                                  updateItem(item.id, {
                                    explanation: e.target.value,
                                  })
                                }
                                placeholder="Trainer explanation"
                              />
                            </div>
                          ) : (
                            <div className="candidate-body">
                              {stage.id === "coding" && (
                                <>
                                  <h3>{item.title || "Code analysis"}</h3>
                                  <pre className="code-block">
                                    {item.codeSnippet}
                                  </pre>
                                  <p>{item.task}</p>
                                </>
                              )}
                              {stage.id !== "coding" && (
                                <h3>
                                  {stage.id === "mcq"
                                    ? item.stem
                                    : item.statement}
                                </h3>
                              )}
                              {stage.id === "mcq" && (
                                <ol className="option-list" type="A">
                                  {item.options.map((option, n) => (
                                    <li key={n}>{option}</li>
                                  ))}
                                </ol>
                              )}
                              <div className="metadata-row">
                                <span
                                  className={
                                    "difficulty diff-" +
                                    item.difficulty.toLowerCase()
                                  }
                                >
                                  <i />
                                  {item.difficulty}
                                </span>
                                {(item.topics || []).map((topic) => (
                                  <span className="topic-pill" key={topic}>
                                    {topic}
                                  </span>
                                ))}
                              </div>
                              <details className="answer-details">
                                <summary>
                                  Trainer preview <ChevronDown size={13} />
                                </summary>
                                <div>
                                  <p>
                                    <b>Answer</b> ·{" "}
                                    {stage.id === "truefalse"
                                      ? item.correctAnswer
                                        ? "True"
                                        : "False"
                                      : stage.id === "mcq"
                                        ? item.correctAnswer
                                        : item.expectedAnswer}
                                  </p>
                                  <p>
                                    <b>Why</b> · {item.explanation}
                                  </p>
                                  <p className="evidence">
                                    <b>Source link</b> · “{item.evidence}”
                                  </p>
                                </div>
                              </details>
                            </div>
                          )}
                          <div className="regen-box">
                            <input
                              value={comments[item.id] || ""}
                              onChange={(e) =>
                                setComments((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              placeholder="Tell the model how to improve this…"
                            />
                            <button
                              onClick={() => regenerate(item)}
                              disabled={regenId === item.id || working}
                              title="Regenerate this question"
                            >
                              {regenId === item.id ? (
                                <LoaderCircle className="spin" size={15} />
                              ) : (
                                <RefreshCw size={15} />
                              )}
                              <span>Retry</span>
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  <div className="review-footer">
                    <span className="review-tip">
                      <ShieldCheck size={15} /> Check the source evidence before
                      approving.
                    </span>
                    <button
                      className="primary-button continue-button"
                      disabled={selected.length !== stage.target || working}
                      onClick={continueWorkflow}
                    >
                      {stageIndex === stages.length - 1
                        ? "Build both copies"
                        : "Approve & continue"}{" "}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </>
              )}
              {!working && !gap && items.length === 0 && !error && (
                <div className="empty-state">
                  <Sparkles size={20} />
                  <b>Ready to work with your source.</b>
                  <button
                    className="primary-button"
                    onClick={() => generateCategory(stage.id)}
                  >
                    Generate {stage.total} candidates <ArrowRight size={15} />
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {complete && (
          <section className="complete-layout">
            <div className="complete-heading">
              <div className="eyebrow">
                <span className="eyebrow-line" /> REVIEW COMPLETE{" "}
                <span className="mono">/ 05 APPROVED</span>
              </div>
              <h1>
                Ready for the <em>classroom.</em>
              </h1>
              <p>Two versions, built from the questions you approved.</p>
            </div>
            <div className="copy-grid">
              <article className="copy-card trainer-card">
                <div className="copy-card-top">
                  <span className="copy-mark">
                    <ShieldCheck size={17} />
                  </span>
                  <span className="micro-label">INSTRUCTOR EDITION</span>
                  <span className="copy-count">05 QUESTIONS</span>
                </div>
                <h2>Trainer’s copy</h2>
                <p>
                  Answers, explanations, and source references are included for
                  review.
                </p>
                <div className="included-list">
                  <span>
                    <Check size={13} /> Correct answers
                  </span>
                  <span>
                    <Check size={13} /> Explanations
                  </span>
                  <span>
                    <Check size={13} /> Source evidence
                  </span>
                </div>
                <div className="copy-actions">
                  <button
                    className="secondary-button"
                    onClick={() => copyVersion("trainer")}
                  >
                    <Clipboard size={15} />
                    {copied === "trainer" ? "Copied" : "Copy text"}
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => downloadPdf("trainer")}
                  >
                    <FileDown size={15} /> Download PDF
                  </button>
                </div>
              </article>
              <article className="copy-card student-card">
                <div className="copy-card-top">
                  <span className="copy-mark student-mark">
                    <BookOpen size={17} />
                  </span>
                  <span className="micro-label">STUDENT EDITION</span>
                  <span className="copy-count">05 QUESTIONS</span>
                </div>
                <h2>Student’s copy</h2>
                <p>
                  Questions only, with difficulty and topics for clear
                  expectations.
                </p>
                <div className="included-list">
                  <span>
                    <Check size={13} /> Questions & code snippets
                  </span>
                  <span>
                    <Check size={13} /> Difficulty and topic labels
                  </span>
                  <span>
                    <X size={13} /> No answer key
                  </span>
                </div>
                <div className="copy-actions">
                  <button
                    className="secondary-button"
                    onClick={() => copyVersion("student")}
                  >
                    <Clipboard size={15} />
                    {copied === "student" ? "Copied" : "Copy text"}
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => downloadPdf("student")}
                  >
                    <FileDown size={15} /> Download PDF
                  </button>
                </div>
              </article>
            </div>
            <div className="complete-bottom">
              <button className="text-button" onClick={reset}>
                <ArrowLeft size={15} /> Start another set
              </button>
              <span>
                <ShieldCheck size={14} /> API keys remain encrypted on this
                device.
              </span>
            </div>
          </section>
        )}
      </main>

      {topicPlanOpen && (
        <div
          className="modal-scrim topic-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTopicPlanOpen(false);
          }}
        >
          <section
            className="settings-modal topic-modal topic-plan-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topic-plan-title"
          >
            <div className="modal-head">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> STEP 01 · TOPIC PLAN</div>
                <h2 id="topic-plan-title">What should this assessment cover?</h2>
              </div>
              <button className="icon-button" aria-label="Close topic plan" onClick={() => setTopicPlanOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <p className="settings-intro">
              Topics were collected from your headings and emphasized terms. Select the concepts you want across all three question stages, or add your own.
            </p>
            <div className="topic-suggestions topic-plan-list">
              {topicOptions.map((topic) => (
                <label className="topic-suggestion" key={topic.id}>
                  <input
                    type="checkbox"
                    checked={selectedPlanTopics.includes(topic.id)}
                    onChange={(event) => setSelectedPlanTopics((previous) => event.target.checked
                      ? [...previous, topic.id]
                      : previous.filter((id) => id !== topic.id))}
                  />
                  <span><b>{topic.title}</b></span>
                </label>
              ))}
            </div>
            <div className="add-plan-topic">
              <input
                aria-label="Add an assessment topic"
                maxLength={120}
                value={customPlanTopic}
                onChange={(event) => setCustomPlanTopic(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addPlanTopic(); } }}
                placeholder="Add a topic"
              />
              <button className="secondary-button" onClick={addPlanTopic} disabled={!customPlanTopic.trim()}>
                <Plus size={15} /> Add
              </button>
            </div>
            <div className="built-in-guide">
              <b><Sparkles size={14} /> Built-in question design guide</b>
              <span>MCQs: one defensible answer and plausible distractors.</span>
              <span>True/false: one clear claim, without ambiguity.</span>
              <span>Code analysis: only syntax and behaviors taught in your source.</span>
            </div>
            <p className="topic-step-note">Selected topics are sent with each stage and must be supported by the source material.</p>
            {topicPlanError && <div className="inline-error" role="alert">{topicPlanError}</div>}
            <div className="topic-footer">
              <button className="text-button" onClick={() => setTopicPlanOpen(false)}>Back to source</button>
              <button className="primary-button" onClick={beginAssessment} disabled={!selectedPlanTopics.length}>
                Generate 5 MCQs <ArrowRight size={16} />
              </button>
            </div>
          </section>
        </div>
      )}

      {topicFlowOpen && (
        <div
          className="modal-scrim topic-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !developing)
              setTopicFlowOpen(false);
          }}
        >
          <section
            className="settings-modal topic-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="topic-title"
          >
            <div className="modal-head">
              <div>
                <div className="eyebrow">
                  <span className="eyebrow-line" /> GUIDED MATERIAL
                </div>
                <h2 id="topic-title">Develop the missing detail.</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close topic development"
                disabled={developing}
                onClick={() => setTopicFlowOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="settings-intro">
              {topicOrigin === "gap"
                ? "Add detail for this coverage gap. Your approved questions stay in the assessment."
                : "Enter rough topics. Your selected provider will suggest concepts, then draft lesson material for you to review."}
            </p>
            {!topicSuggestions.length && !materialDraft && (
              <>
                <label className="form-label" htmlFor="rough-topics">
                  Rough topics or concepts
                  <textarea
                    id="rough-topics"
                    className="topic-input"
                    maxLength={5000}
                    value={topicInput}
                    onChange={(event) => setTopicInput(event.target.value)}
                    placeholder="For example: HTML forms, accessible labels, validation, and submission…"
                  />
                </label>
                <p className="topic-provider-note">
                  Uses {provider === "gemini" ? "Gemini" : "NVIDIA"} · {model || "no model selected"}
                </p>
                {developmentError && <div className="inline-error">{developmentError}</div>}
                <div className="topic-footer">
                  <button
                    className="primary-button"
                    onClick={suggestMaterialTopics}
                    disabled={developing || !topicInput.trim()}
                  >
                    {developing ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
                    Suggest topics
                  </button>
                </div>
              </>
            )}
            {topicSuggestions.length > 0 && !materialDraft && (
              <>
                <p className="topic-step-note">Choose the concepts you want the lesson to cover.</p>
                <div className="topic-suggestions">
                  {topicSuggestions.map((topic) => (
                    <label className="topic-suggestion" key={topic.id}>
                      <input
                        type="checkbox"
                        checked={chosenTopics.includes(topic.id)}
                        onChange={(event) => setChosenTopics((previous) => event.target.checked
                          ? [...previous, topic.id]
                          : previous.filter((id) => id !== topic.id))}
                      />
                      <span>
                        <b>{topic.title}</b>
                        <small>{topic.rationale}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {developmentError && <div className="inline-error">{developmentError}</div>}
                <div className="topic-footer">
                  <button className="text-button" onClick={() => { setTopicSuggestions([]); setChosenTopics([]); }} disabled={developing}>
                    Change rough topics
                  </button>
                  <button
                    className="primary-button"
                    onClick={draftSelectedMaterial}
                    disabled={developing || !chosenTopics.length}
                  >
                    {developing ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
                    Draft selected topics
                  </button>
                </div>
              </>
            )}
            {materialDraft && (
              <>
                <div className="draft-review-note">
                  <ShieldCheck size={16} />
                  <span>This is AI-generated draft material. Review and edit it before it becomes source for questions.</span>
                </div>
                <label className="form-label" htmlFor="material-draft">
                  Lesson material to add
                  <textarea
                    id="material-draft"
                    className="material-draft"
                    maxLength={12000}
                    value={materialDraft}
                    onChange={(event) => setMaterialDraft(event.target.value)}
                  />
                </label>
                {developmentError && <div className="inline-error">{developmentError}</div>}
                <div className="topic-footer">
                  <button className="text-button" onClick={() => setMaterialDraft("")} disabled={developing}>
                    Back to topic choices
                  </button>
                  <button
                    className="primary-button"
                    onClick={acceptDevelopedMaterial}
                    disabled={developing || !materialDraft.trim()}
                  >
                    {topicOrigin === "gap" ? "Add material & recheck" : "Use material & choose topics"}
                    <ArrowRight size={16} />
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <footer className="page-footer">
        <span>
          QUESTION STUDIO <span className="footer-divider">/</span> MATERIAL-LED
          ASSESSMENT
        </span>
        <span>BUILT FOR REVIEWERS, BY DESIGN</span>
      </footer>

      {settingsOpen && (
        <div
          className="modal-scrim"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeSettings();
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="modal-head">
              <div>
                <div className="eyebrow">
                  <span className="eyebrow-line" /> PROVIDER SETTINGS
                </div>
                <h2 id="settings-title">Connect your model.</h2>
              </div>
              <button
                className="icon-button"
                onClick={closeSettings}
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </div>
            <p className="settings-intro">
              Choose one provider for the full assessment. Your key stays on
              this device.
            </p>
            <div className="provider-choice">
              <button
                className={provider === "gemini" ? "chosen" : ""}
                disabled={started || savingSettings}
                onClick={() => {
                  setProvider("gemini");
                  setModel("");
                  setModels([]);
                  ++modelRequest.current;
                  setLoadingModels(false);
                  setApiKey("");
                  setError("");
                }}
              >
                <span>✳</span>
                <b>Google Gemini</b>
                <small>
                  {settings.hasGeminiKey ? "Key saved" : "Connect API key"}
                </small>
              </button>
              <button
                className={provider === "nvidia" ? "chosen" : ""}
                disabled={started || savingSettings}
                onClick={() => {
                  setProvider("nvidia");
                  setModel("");
                  setModels([]);
                  ++modelRequest.current;
                  setLoadingModels(false);
                  setApiKey("");
                  setError("");
                }}
              >
                <span>◈</span>
                <b>NVIDIA NIM</b>
                <small>
                  {settings.hasNvidiaKey ? "Key saved" : "Connect API key"}
                </small>
              </button>
            </div>
            {started && (
              <div className="active-provider-note">
                This provider and model stay fixed until this assessment is
                complete.
              </div>
            )}
            <label className="form-label">
              {provider === "gemini" ? "Gemini API key" : "NVIDIA API key"}
              <div className="key-entry">
                <KeyRound size={15} />
                <input
                  type="password"
                  disabled={started || savingSettings || loadingModels}
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    keyAvailable
                      ? "Saved on this device — enter a new key to replace"
                      : "Paste your API key"
                  }
                />
                <span className="saved-state">
                  {keyAvailable && !apiKey ? (
                    <>
                      <ShieldCheck size={13} /> SAVED
                    </>
                  ) : (
                    "PRIVATE"
                  )}
                </span>
              </div>
            </label>
            <button
              className="secondary-button model-load"
              onClick={loadModels}
              disabled={
                started ||
                savingSettings ||
                loadingModels ||
                (!currentKey && !keyAvailable)
              }
            >
              {loadingModels ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <RefreshCw size={15} />
              )}{" "}
              Load available models
            </button>
            <label className="form-label">
              Generation model
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={
                  !models.length || started || savingSettings || loadingModels
                }
              >
                <option value="">
                  {models.length ? "Choose a model…" : "Load models first"}
                </option>
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <div className="inline-error modal-error">
                <CircleHelp size={15} />
                {error}
              </div>
            )}
            <div className="secure-explainer">
              <LockKeyhole size={15} />
              <span>
                On Windows, the backend encrypts your key with your account’s
                built-in protection. The browser never receives the saved key.
              </span>
            </div>
            <div className="modal-actions">
              <button
                className="quiet-button"
                onClick={() => setSettingsOpen(false)}
              >
                Close
              </button>
              <button
                className="primary-button"
                onClick={saveSettings}
                disabled={
                  savingSettings ||
                  loadingModels ||
                  !model ||
                  started ||
                  (!currentKey && !keyAvailable)
                }
              >
                {savingSettings ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Check size={15} />
                )}{" "}
                Save settings
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
