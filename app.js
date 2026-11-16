"use strict";

const byId = id => document.getElementById(id);
const source = byId("source");
const result = byId("result");
const sourceContext = source.getContext("2d", { willReadFrequently: true });
const resultContext = result.getContext("2d");
const colorButtons = [...document.querySelectorAll("[data-ink]")];
const backgroundButtons = [...document.querySelectorAll("[data-bg]")];
const defaults = { ink: "auto", sensitivity: 60, strength: 100, clean: true, trim: true };
let name = "", originalSize = "", scaled = false, loaded = false, isSample = false;
let region = null, selecting = false, drag = null;
let ink = defaults.ink, revision = 0, loading = 0, timer, worker, running = false, waiting = false;

function report(message, error = false) {
  byId("status").textContent = message;
  byId("status").dataset.error = error;
}

function mark(buttons, attribute, value) {
  buttons.forEach(button => button.setAttribute("aria-pressed", button.dataset[attribute] === value));
}

function fit(canvas, stage) {
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.min(width / canvas.width, height / canvas.height, 2);
  if (scale <= 0) return;
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
}

new ResizeObserver(() => {
  if (loaded) fit(source, byId("source-stage"));
  if (!result.hidden) fit(result, byId("result-stage"));
}).observe(document.querySelector(".compare"));

function showSelection(rect) {
  const selection = byId("selection");
  selection.hidden = !rect;
  if (!rect) return;
  selection.style.left = `${100 * rect.x / source.width}%`;
  selection.style.top = `${100 * rect.y / source.height}%`;
  selection.style.width = `${100 * rect.width / source.width}%`;
  selection.style.height = `${100 * rect.height / source.height}%`;
}

function setSelecting(enabled) {
  selecting = enabled;
  drag = null;
  byId("crop").setAttribute("aria-pressed", enabled);
  byId("crop").textContent = enabled ? "退出框选" : region ? "重新框选" : "框选区域";
  byId("source-wrap").classList.toggle("selecting", enabled);
  showSelection(region);
}

function showRegion() {
  byId("clear-crop").hidden = !region;
  byId("source-caption").textContent = region ? `选区 ${region.width} × ${region.height}` : isSample ? "内置模拟扫描件" : "全图";
  showSelection(region);
}

function applySource(image, filename, sample = false) {
  const fullWidth = image.naturalWidth || image.width;
  const fullHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, 4096 / Math.max(fullWidth, fullHeight), Math.sqrt(8000000 / (fullWidth * fullHeight)));
  source.width = Math.max(1, Math.round(fullWidth * scale));
  source.height = Math.max(1, Math.round(fullHeight * scale));
  sourceContext.drawImage(image, 0, 0, source.width, source.height);
  name = filename;
  originalSize = `${fullWidth} × ${fullHeight}`;
  scaled = scale < 1;
  loaded = true;
  isSample = sample;
  region = null;
  setSelecting(false);
  showRegion();
  byId("file-info").textContent = `${name} · ${originalSize}`;
  byId("file-info").title = byId("file-info").textContent;
  fit(source, byId("source-stage"));
  result.hidden = true;
  queue();
}

function settings() {
  return {
    ink, sensitivity: Number(byId("sensitivity").value), strength: Number(byId("strength").value),
    clean: byId("clean").checked, trim: byId("trim").checked
  };
}

function queue() {
  if (!loaded) return;
  revision++;
  waiting = true;
  byId("download").disabled = true;
  report("正在提取印章…");
  clearTimeout(timer);
  timer = setTimeout(process, 65);
}

function complete(job, output) {
  running = false;
  if (job === revision) render(output);
  if (waiting) process();
}

function render(output) {
  result.hidden = !output.width;
  byId("placeholder").hidden = Boolean(output.width);
  if (!output.width) {
    byId("placeholder").textContent = "未找到匹配的印迹";
    byId("result-caption").textContent = "—";
    report("可切换红章或蓝章、提高浅印保留，或框选印章所在区域。");
    return;
  }
  result.width = output.width;
  result.height = output.height;
  resultContext.putImageData(new ImageData(output.pixels, output.width, output.height), 0, 0);
  fit(result, byId("result-stage"));
  byId("result-caption").textContent = `${output.width} × ${output.height}`;
  byId("download").disabled = false;
  const label = output.color === "red" ? "红章" : "蓝章";
  report(`${ink === "auto" ? "自动识别为" : "已提取"}${label}${scaled ? ` · 大图已缩至 ${source.width} × ${source.height}` : ""}`);
}

function process() {
  if (running || !waiting) return;
  running = true;
  waiting = false;
  const job = revision;
  const area = region || { x: 0, y: 0, width: source.width, height: source.height };
  const { x, y, width, height } = area;
  const options = settings();
  const pixels = sourceContext.getImageData(x, y, width, height).data;
  if (worker) {
    worker.postMessage({ job, pixels, width, height, options }, [pixels.buffer]);
    return;
  }
  try {
    complete(job, extractSeal(pixels, width, height, options));
  } catch {
    running = false;
    report("提取失败，请试试较小的图片。", true);
  }
}

try {
  // A blob worker keeps the static demo usable when opened directly from Finder.
  const workerCode = `${extractSeal.toString()}
    self.onmessage = ({ data }) => {
      const { job, pixels, width, height, options } = data;
      const output = extractSeal(pixels, width, height, options);
      self.postMessage({ job, output }, output.pixels ? [output.pixels.buffer] : []);
    };`;
  const workerURL = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  try {
    worker = new Worker(workerURL);
    worker.onmessage = ({ data }) => complete(data.job, data.output);
    worker.onerror = () => {
      worker.terminate();
      worker = null;
      running = false;
      waiting = true;
      process();
    };
  } finally {
    URL.revokeObjectURL(workerURL);
  }
} catch {
  worker = null;
}

function importImage(file) {
  if (!file) return;
  const request = ++loading;
  if (file.size > 40 * 1024 * 1024) {
    report("图片超过 40 MB，请选较小的图片。", true);
    return;
  }
  const image = new Image();
  const url = URL.createObjectURL(file);
  image.onload = () => {
    try {
      if (request === loading) applySource(image, file.name || "粘贴图片");
    } catch {
      report("无法读取这张图片，请尝试 JPG 或 PNG。", true);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    if (request === loading) report("无法打开这个文件，请使用 JPG、PNG 或 WebP 图片。", true);
  };
  image.src = url;
}

function makeSample() {
  const page = document.createElement("canvas");
  page.width = 680;
  page.height = 790;
  const ctx = page.getContext("2d");
  const paper = ctx.createLinearGradient(0, 0, 680, 790);
  paper.addColorStop(0, "#fcf9f1");
  paper.addColorStop(1, "#f1eddf");
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 680, 790);
  ctx.textAlign = "center";
  ctx.fillStyle = "#272723";
  ctx.font = 'bold 46px "Songti SC", serif';
  ctx.fillText("文件归档记录", 340, 128);
  ctx.font = '16px -apple-system, sans-serif';
  ctx.fillStyle = "#6b665a";
  ctx.fillText("示例扫描件 · ARCHIVE RECORD", 340, 168);
  ctx.strokeStyle = "#a6a195";
  ctx.lineWidth = 1;
  ctx.strokeRect(66, 214, 548, 441);
  [275, 337, 399, 461, 523].forEach(y => {
    ctx.beginPath();
    ctx.moveTo(66, y);
    ctx.lineTo(614, y);
    ctx.stroke();
  });
  ctx.textAlign = "left";
  ctx.fillStyle = "#34332c";
  ctx.font = '21px "PingFang SC", sans-serif';
  ["文件编号        ARC—2026—017", "文件类别        内部资料", "登记日期        2026 年 11 月", "保管期限        长期", "登记备注        示例资料，仅作演示"].forEach((line, i) => {
    ctx.fillText(line, 89, 253 + i * 62);
  });
  ctx.fillText("核验记录", 90, 578);
  ctx.font = '15px "PingFang SC", sans-serif';
  ctx.fillStyle = "#6b665a";
  ctx.fillText("本页为虚构样本", 66, 713);

  const stamp = document.createElement("canvas");
  stamp.width = 285;
  stamp.height = 285;
  const mark = stamp.getContext("2d", { willReadFrequently: true });
  mark.translate(142, 142);
  mark.strokeStyle = "#ae3336";
  mark.fillStyle = "#ae3336";
  mark.lineWidth = 7;
  mark.beginPath();
  mark.arc(0, 0, 131, 0, Math.PI * 2);
  mark.stroke();
  mark.lineWidth = 2;
  mark.beginPath();
  mark.arc(0, 0, 120, 0, Math.PI * 2);
  mark.stroke();
  mark.textAlign = "center";
  mark.textBaseline = "middle";
  mark.font = 'bold 29px "Songti SC", serif';
  [..."印章提取演示专用"].forEach((letter, index, letters) => {
    const angle = (index - (letters.length - 1) / 2) * .277;
    mark.save();
    mark.rotate(angle);
    mark.fillText(letter, 0, -94);
    mark.restore();
  });
  mark.font = '68px sans-serif';
  mark.fillText("★", 0, -3);
  mark.font = 'bold 30px "Songti SC", serif';
  mark.fillText("样  章", 0, 62);
  mark.font = '12px -apple-system, sans-serif';
  mark.fillText("DEMO   ·   0000", 0, 94);

  const data = mark.getImageData(0, 0, stamp.width, stamp.height);
  let seed = 1431;
  for (let i = 0; i < data.data.length; i += 4) {
    if (!data.data[i + 3]) continue;
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const n = i / 4;
    const wave = .75 + .16 * Math.sin((n % 285) / 26 + Math.floor(n / 285) / 29);
    const grain = seed / 4294967296;
    data.data[i + 3] *= wave * (grain < .062 ? .17 : .76 + .24 * grain);
  }
  mark.putImageData(data, 0, 0);
  ctx.save();
  ctx.translate(467, 542);
  ctx.rotate(-.145);
  ctx.drawImage(stamp, -142, -142);
  ctx.restore();
  return page;
}

function loadSample() {
  loading++;
  applySource(makeSample(), "模拟档案扫描件.png", true);
}

function pointerPosition(event) {
  const box = source.getBoundingClientRect();
  return {
    x: Math.round(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * source.width),
    y: Math.round(Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) * source.height)
  };
}

function rectangle(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

const sourceWrap = byId("source-wrap");
sourceWrap.addEventListener("pointerdown", event => {
  if (!selecting || !event.isPrimary || event.button !== 0) return;
  drag = pointerPosition(event);
  sourceWrap.setPointerCapture(event.pointerId);
});
sourceWrap.addEventListener("pointermove", event => {
  if (drag && event.isPrimary) showSelection(rectangle(drag, pointerPosition(event)));
});
sourceWrap.addEventListener("pointerup", event => {
  if (!drag || !event.isPrimary) return;
  const next = rectangle(drag, pointerPosition(event));
  drag = null;
  if (next.width < 5 || next.height < 5) {
    showSelection(region);
    return;
  }
  region = next;
  setSelecting(false);
  showRegion();
  queue();
});
sourceWrap.addEventListener("pointercancel", () => {
  drag = null;
  showSelection(region);
});

byId("choose").addEventListener("click", () => byId("file").click());
byId("file").addEventListener("change", event => {
  importImage(event.target.files[0]);
  event.target.value = "";
});
byId("sample").addEventListener("click", loadSample);
byId("crop").addEventListener("click", () => {
  setSelecting(!selecting);
  report(selecting ? "在原始图片上拖出矩形，圈住要提取的印章。" : "已退出框选。");
});
byId("clear-crop").addEventListener("click", () => {
  region = null;
  setSelecting(false);
  showRegion();
  queue();
});
document.addEventListener("keydown", event => {
  if (selecting && event.key === "Escape") {
    setSelecting(false);
    report("已退出框选。");
  }
});
const workspace = document.querySelector(".workspace");
document.addEventListener("dragover", event => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  workspace.classList.add("dragging");
});
document.addEventListener("dragleave", event => {
  if (!event.relatedTarget) workspace.classList.remove("dragging");
});
document.addEventListener("drop", event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  workspace.classList.remove("dragging");
  importImage(event.dataTransfer.files[0]);
});
document.addEventListener("paste", event => {
  const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  importImage(file);
});

colorButtons.forEach(button => button.addEventListener("click", () => {
  ink = button.dataset.ink;
  mark(colorButtons, "ink", ink);
  queue();
}));
backgroundButtons.forEach(button => button.addEventListener("click", () => {
  mark(backgroundButtons, "bg", button.dataset.bg);
  byId("result-stage").className = `stage ${button.dataset.bg}`;
}));

function syncControls() {
  byId("sensitivity-value").value = byId("sensitivity").value;
  byId("strength-value").value = byId("strength").value + "%";
  byId("download").lastChild.textContent = byId("white-export").checked ? " 下载白底 PNG" : " 下载透明 PNG";
}
for (const id of ["sensitivity", "strength", "clean", "trim"]) {
  byId(id).addEventListener("input", () => {
    syncControls();
    queue();
  });
}
byId("white-export").addEventListener("change", syncControls);
byId("reset").addEventListener("click", () => {
  ink = defaults.ink;
  mark(colorButtons, "ink", ink);
  for (const id of ["sensitivity", "strength"]) byId(id).value = defaults[id];
  for (const id of ["clean", "trim"]) byId(id).checked = defaults[id];
  byId("white-export").checked = false;
  syncControls();
  queue();
});

byId("download").addEventListener("click", () => {
  const white = byId("white-export").checked;
  const filename = (name.replace(/\.[^.]+$/, "") || "印章") + (white ? "-印章-白底.png" : "-印章-透明.png");
  let canvas = result;
  if (white) {
    canvas = document.createElement("canvas");
    canvas.width = result.width;
    canvas.height = result.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(result, 0, 0);
  }
  canvas.toBlob(blob => {
    if (!blob) {
      report("导出失败，请重新下载。", true);
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, "image/png");
});

loadSample();
