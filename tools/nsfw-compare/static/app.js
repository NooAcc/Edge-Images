"use strict";

/* ---------- constants ---------- */

const CLASS_ORDER = ["safe", "hentai", "porn", "sexy", "drawing"];
const NSFW_CLASSES = ["hentai", "porn", "sexy"];
const CLASS_META = {
  safe: { label: "安全", color: "var(--safe)" },
  hentai: { label: "二次元色情", color: "var(--hentai)" },
  porn: { label: "色情", color: "var(--porn)" },
  sexy: { label: "性感", color: "var(--sexy)" },
  drawing: { label: "非色情绘画", color: "var(--drawing)" },
};
const CRED_KEY = "nsfwCompare.credentials";
const THRESHOLD_KEY = "nsfwCompare.threshold";
const MAX_UPLOAD_BYTES = 28 * 1024 * 1024;

/* ---------- state ---------- */

const state = {
  items: [],
  index: -1,
  threshold: loadThreshold(),
};

/* ---------- dom ---------- */

const $ = (id) => document.getElementById(id);
const emptyState = $("emptyState");
const viewer = $("viewer");
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const preview = $("preview");
const stageLoading = $("stageLoading");
const stageError = $("stageError");
const imageNote = $("imageNote");
const imageInfo = $("imageInfo");
const position = $("position");
const mismatchBadge = $("mismatchBadge");
const localBody = $("localBody");
const cloudBody = $("cloudBody");
const localVerdict = $("localVerdict");
const cloudVerdict = $("cloudVerdict");
const filmstrip = $("filmstrip");
const filmstripWrap = $("filmstripWrap");
const filmstripCount = $("filmstripCount");
const dropOverlay = $("dropOverlay");
const toastEl = $("toast");
const thresholdInput = $("threshold");
const thresholdValue = $("thresholdValue");
const credDot = $("credDot");
const settingsDialog = $("settingsDialog");
const settingsStatus = $("settingsStatus");
const accountInput = $("accountIdInput");
const tokenInput = $("tokenInput");
const rememberInput = $("rememberInput");

/* ---------- helpers ---------- */

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pct(value) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  const percent = clamped * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nsfwScore(probabilities) {
  return NSFW_CLASSES.reduce((sum, name) => sum + (probabilities[name] || 0), 0);
}

function currentItem() {
  return state.items[state.index] || null;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `img-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2600);
}

/* ---------- credentials ---------- */

function loadCredentials() {
  try {
    const raw =
      localStorage.getItem(CRED_KEY) || sessionStorage.getItem(CRED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.accountId || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCredentials(accountId, token, remember) {
  const payload = JSON.stringify({ accountId, token });
  localStorage.removeItem(CRED_KEY);
  sessionStorage.removeItem(CRED_KEY);
  (remember ? localStorage : sessionStorage).setItem(CRED_KEY, payload);
  updateCredDot();
}

function clearCredentials() {
  localStorage.removeItem(CRED_KEY);
  sessionStorage.removeItem(CRED_KEY);
  updateCredDot();
}

function updateCredDot() {
  credDot.classList.toggle("on", Boolean(loadCredentials()));
}

/* ---------- threshold ---------- */

function loadThreshold() {
  const raw = Number(localStorage.getItem(THRESHOLD_KEY));
  return Number.isFinite(raw) && raw >= 0.05 && raw <= 0.95 ? raw : 0.5;
}

function applyThreshold(value) {
  state.threshold = value;
  thresholdInput.value = String(value);
  thresholdValue.textContent = value.toFixed(2);
  localStorage.setItem(THRESHOLD_KEY, String(value));
  renderCurrent();
}

/* ---------- files ---------- */

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (file) => file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)
  );
  if (!files.length) {
    toast("没有找到可用的图片");
    return;
  }

  const wasEmpty = state.items.length === 0;
  for (const file of files) {
    const item = {
      id: newId(),
      file,
      url: URL.createObjectURL(file),
      status: "idle",
      result: null,
      error: null,
      runId: 0,
    };
    if (file.size > MAX_UPLOAD_BYTES) {
      item.status = "error";
      item.error = `图片 ${formatBytes(file.size)} 超过 ${formatBytes(MAX_UPLOAD_BYTES)}，无法上传`;
    }
    state.items.push(item);
  }

  emptyState.classList.add("hidden");
  viewer.classList.remove("hidden");
  filmstripWrap.classList.remove("hidden");
  renderStrip();

  if (wasEmpty) {
    select(state.items.length - files.length);
  } else {
    renderCurrent();
  }
}

function select(index) {
  if (index < 0 || index >= state.items.length) return;
  state.index = index;
  const item = state.items[index];
  preview.src = item.url;
  renderStrip();
  position.textContent = `${index + 1} / ${state.items.length}`;
  if (item.status === "idle") {
    analyze(item);
  } else {
    renderCurrent();
  }
}

function clearAll() {
  for (const item of state.items) URL.revokeObjectURL(item.url);
  state.items = [];
  state.index = -1;
  preview.removeAttribute("src");
  filmstrip.innerHTML = "";
  emptyState.classList.remove("hidden");
  viewer.classList.add("hidden");
  filmstripWrap.classList.add("hidden");
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function analyze(item) {
  const runId = (item.runId || 0) + 1;
  item.runId = runId;
  item.status = "loading";
  item.error = null;
  renderStrip();
  if (currentItem() === item) renderLoading();

  let dataUrl;
  try {
    dataUrl = await readAsDataURL(item.file);
  } catch (error) {
    finishWithError(item, runId, error.message);
    return;
  }

  const body = { image: dataUrl };
  const creds = loadCredentials();
  if (creds) body.credentials = { accountId: creds.accountId, token: creds.token };

  let response;
  try {
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      throw new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`);
    }
    response = payload;
  } catch (error) {
    finishWithError(item, runId, error.message || "请求失败");
    return;
  }

  if (item.runId !== runId) return;
  item.result = response;
  item.status = "done";
  renderStrip();
  if (currentItem() === item) renderResult();
}

function finishWithError(item, runId, message) {
  if (item.runId !== runId) return;
  item.status = "error";
  item.error = message;
  renderStrip();
  if (currentItem() === item) renderCurrent();
}

/* ---------- rendering ---------- */

function renderStrip() {
  filmstrip.innerHTML = "";
  state.items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb" + (index === state.index ? " active" : "");
    button.title = item.file.name;

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = "";
    button.append(img);

    const dot = document.createElement("span");
    dot.className = `dot ${item.status === "done" ? "done" : item.status}`;
    button.append(dot);

    button.addEventListener("click", () => select(index));
    filmstrip.append(button);
  });
  filmstripCount.textContent = `${state.items.length} 张`;
}

function renderCurrent() {
  const item = currentItem();
  if (!item) return;
  if (item.status === "loading") {
    renderLoading();
  } else if (item.status === "error" || !item.result) {
    renderStageError(item.error || "识别失败");
    renderCardError(localBody, localVerdict, item.error || "识别失败", false);
    renderCardError(cloudBody, cloudVerdict, item.error || "识别失败", false);
  } else {
    renderResult();
  }
}

function renderLoading() {
  stageLoading.classList.remove("hidden");
  stageError.classList.add("hidden");
  imageInfo.textContent = "正在识别…";
  mismatchBadge.classList.add("hidden");
  imageNote.classList.add("hidden");
  setVerdict(localVerdict, "idle", "识别中");
  setVerdict(cloudVerdict, "idle", "识别中");
  localBody.innerHTML = skeletonHtml();
  cloudBody.innerHTML = skeletonHtml();
}

function skeletonHtml() {
  return `<div class="skeleton">
    <div class="skeleton-row" style="height:56px;border-radius:11px"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  </div>`;
}

function renderStageError(message) {
  stageLoading.classList.add("hidden");
  stageError.textContent = message;
  stageError.classList.remove("hidden");
  imageInfo.textContent = "";
  mismatchBadge.classList.add("hidden");
  imageNote.classList.add("hidden");
}

function renderResult() {
  const item = currentItem();
  const result = item && item.result;
  if (!result) return;

  stageLoading.classList.add("hidden");
  stageError.classList.add("hidden");

  const meta = result.image || {};
  const parts = [];
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  if (meta.bytes) parts.push(formatBytes(meta.bytes));
  if (item.file && item.file.name) parts.push(item.file.name);
  imageInfo.textContent = parts.join(" · ");

  if (meta.note) {
    imageNote.textContent = `已为 Cloudflare 调整图片：${meta.note}`;
    imageNote.classList.remove("hidden");
  } else if (meta.cloudReady === false) {
    imageNote.textContent = "这张图片无法发送给 Cloudflare（格式或体积不满足要求），右侧只有本地结果。";
    imageNote.classList.remove("hidden");
  } else {
    imageNote.classList.add("hidden");
  }

  renderOneCard("local", localBody, localVerdict, result.local);
  renderOneCard("cloud", cloudBody, cloudVerdict, result.cloud);
  updateMismatch(result);
}

function renderOneCard(kind, body, verdict, part) {
  if (!part) {
    setVerdict(verdict, "idle", "无结果");
    body.innerHTML = "";
    return;
  }
  if (part.error) {
    const missingCreds = kind === "cloud" && /设置|配置|Token/.test(part.error);
    setVerdict(verdict, "error", missingCreds ? "未配置" : "出错");
    renderCardError(body, verdict, part.error, missingCreds);
    return;
  }

  const probabilities = part.probabilities || {};
  const score = nsfwScore(probabilities);
  const isNsfw = score >= state.threshold;
  setVerdict(verdict, isNsfw ? "nsfw" : "safe", isNsfw ? "NSFW" : "安全");

  const rows = CLASS_ORDER.map((name) => {
    const meta = CLASS_META[name];
    const value = probabilities[name] || 0;
    return `<div class="class-row">
      <span class="class-name">${meta.label}<small>${name}</small></span>
      <div class="bar"><div class="fill" style="width:${(value * 100).toFixed(2)}%;background:${meta.color}"></div></div>
      <span class="pct">${pct(value)}</span>
    </div>`;
  }).join("");

  const extras =
    kind === "cloud"
      ? `<div class="cloud-extra">
          <span>clef 直接判断 NSFW：<strong>${pct(part.nsfwProbability)}</strong></span>
          <span>最可能类别：<strong>${escapeHtml(part.choice || "—")}</strong>（置信度 ${pct(part.confidence || 0)}）</span>
          <span>${part.inputTokens ?? "—"} input tokens · ${part.latencyMs ?? "—"} ms</span>
        </div>`
      : `<div class="cloud-extra">
          <span>耗时 <strong>${part.latencyMs ?? "—"} ms</strong></span>
          <span>输入 ${part.inputSize ?? 380}×${part.inputSize ?? 380}</span>
        </div>`;

  body.innerHTML = `
    <div class="aggregate">
      <div class="agg-head">
        <span>NSFW 合计 <small>hentai + porn + sexy</small></span>
        <strong>${pct(score)}</strong>
      </div>
      <div class="bar big">
        <div class="fill" style="width:${(score * 100).toFixed(2)}%;background:linear-gradient(90deg,var(--sexy),var(--danger))"></div>
        <div class="marker" style="left:calc(${(state.threshold * 100).toFixed(1)}% - 1px)" title="阈值 ${state.threshold.toFixed(2)}"></div>
      </div>
    </div>
    <div class="class-list">${rows}</div>
    ${extras}`;
}

function renderCardError(body, verdict, message, withSettingsLink) {
  setVerdict(verdict, "error", withSettingsLink ? "未配置" : "出错");
  const link = withSettingsLink
    ? `<br><button type="button" class="btn ghost small" data-action="open-settings">去设置</button>`
    : "";
  body.innerHTML = `<div class="card-error">${escapeHtml(message)}${link}</div>`;
}

function setVerdict(element, kind, text) {
  element.className = `verdict ${kind}`;
  element.textContent = text;
}

function updateMismatch(result) {
  const local = result.local && result.local.probabilities;
  const cloud = result.cloud && result.cloud.probabilities;
  if (!local || !cloud) {
    mismatchBadge.classList.add("hidden");
    return;
  }
  const localNsfw = nsfwScore(local) >= state.threshold;
  const cloudNsfw = nsfwScore(cloud) >= state.threshold;
  if (localNsfw === cloudNsfw) {
    mismatchBadge.classList.add("hidden");
    return;
  }
  mismatchBadge.textContent = `结论不一致：本地判为${localNsfw ? " NSFW" : "安全"}，Cloudflare 判为${cloudNsfw ? " NSFW" : "安全"}`;
  mismatchBadge.classList.remove("hidden");
}

/* ---------- settings ---------- */

function openSettings() {
  const creds = loadCredentials();
  accountInput.value = creds ? creds.accountId : "";
  tokenInput.value = creds ? creds.token : "";
  tokenInput.type = "password";
  const storedLongTerm = localStorage.getItem(CRED_KEY) !== null;
  const storedSession = sessionStorage.getItem(CRED_KEY) !== null;
  rememberInput.checked = storedLongTerm || !storedSession;
  settingsStatus.textContent = "";
  settingsStatus.className = "settings-status";
  settingsDialog.showModal();
}

function closeSettings() {
  settingsDialog.close();
}

function saveSettings() {
  const accountId = accountInput.value.trim();
  const token = tokenInput.value.trim();
  if (!accountId && !token) {
    clearCredentials();
    closeSettings();
    toast("已清除 Cloudflare 凭证");
    rerunIfCloudFailed();
    return;
  }
  if (!accountId || !token) {
    settingsStatus.textContent = "Account ID 和 API Token 需要同时填写，或者都留空以清除。";
    settingsStatus.className = "settings-status err";
    return;
  }
  saveCredentials(accountId, token, rememberInput.checked);
  closeSettings();
  toast("已保存 Cloudflare 凭证");
  rerunIfCloudFailed();
}

async function testCredentials() {
  const accountId = accountInput.value.trim();
  const token = tokenInput.value.trim();
  if (!accountId || !token) {
    settingsStatus.textContent = "请先填写 Account ID 和 API Token。";
    settingsStatus.className = "settings-status err";
    return;
  }
  const button = $("testBtn");
  button.disabled = true;
  button.textContent = "测试中…";
  settingsStatus.textContent = "";
  settingsStatus.className = "settings-status";
  try {
    const res = await fetch("/api/test-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, token }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `连接失败（HTTP ${res.status}）`);
    settingsStatus.textContent = "连接成功，凭证有效。";
    settingsStatus.className = "settings-status ok";
  } catch (error) {
    settingsStatus.textContent = error.message || "连接失败";
    settingsStatus.className = "settings-status err";
  } finally {
    button.disabled = false;
    button.textContent = "测试连接";
  }
}

function rerunIfCloudFailed() {
  const item = currentItem();
  if (!item || !item.result || !item.result.cloud || !item.result.cloud.error) return;
  item.status = "idle";
  item.result = null;
  analyze(item);
}

/* ---------- wire up ---------- */

thresholdInput.addEventListener("input", () => {
  applyThreshold(Number(thresholdInput.value));
});
thresholdValue.textContent = state.threshold.toFixed(2);
thresholdInput.value = String(state.threshold);

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = "";
});

$("prevBtn").addEventListener("click", () => select(state.index - 1));
$("nextBtn").addEventListener("click", () => select(state.index + 1));
$("clearBtn").addEventListener("click", clearAll);
$("rerunBtn").addEventListener("click", () => {
  const item = currentItem();
  if (!item || item.status === "loading") return;
  item.status = "idle";
  item.result = null;
  item.error = null;
  analyze(item);
});
$("settingsBtn").addEventListener("click", openSettings);
$("cancelSettings").addEventListener("click", closeSettings);
$("saveSettings").addEventListener("click", saveSettings);
$("testBtn").addEventListener("click", testCredentials);
$("toggleToken").addEventListener("click", () => {
  tokenInput.type = tokenInput.type === "password" ? "text" : "password";
});
document.addEventListener("click", (event) => {
  const target = event.target.closest('[data-action="open-settings"]');
  if (target) openSettings();
});

/* drag & drop */

let dragDepth = 0;
function hasFiles(event) {
  return Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types || []).includes("Files");
}
window.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.remove("hidden");
});
window.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add("hidden");
});
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
  addFiles(event.dataTransfer.files);
});

/* paste */

document.addEventListener("paste", (event) => {
  const files = Array.from((event.clipboardData && event.clipboardData.files) || []);
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});

/* keyboard navigation */

document.addEventListener("keydown", (event) => {
  if (settingsDialog.open) return;
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    select(state.index - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    select(state.index + 1);
  }
});

updateCredDot();
