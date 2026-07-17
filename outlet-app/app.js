// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "catalogo") loadCatalog();
    if (btn.dataset.tab === "historico") loadHistory();
  });
});

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".mode-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("mode-" + btn.dataset.mode).classList.add("active");
  });
});

// ---------- Image upload ----------
let pendingImages = []; // {data, media_type, name}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const previewList = document.getElementById("imagePreviewList");

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
dropzone.addEventListener("dragover", (e) => e.preventDefault());
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});

function handleFiles(fileList) {
  Array.from(fileList).forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      pendingImages.push({ data: base64, media_type: file.type, name: file.name });
      const img = document.createElement("img");
      img.src = reader.result;
      previewList.appendChild(img);
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Local OCR parsing (no API key / credits needed) ----------
function normalizeOcr(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits a line like "4 marrom" or "off white 1uni" into { qty, text }.
function splitQtyAndText(line) {
  let m = line.match(/^(\d+)\s*(?:x|un\.?|uni\.?)?\s*(.+)$/i);
  if (m && m[2]) return { qty: parseInt(m[1], 10), text: m[2].trim() };
  m = line.match(/^(.+?)\s*(\d+)\s*(?:x|un\.?|uni\.?)?\s*$/i);
  if (m && m[1]) return { qty: parseInt(m[2], 10), text: m[1].trim() };
  return { qty: null, text: line };
}

let aliasListsCache = null;
async function fetchAliasLists() {
  if (aliasListsCache) return aliasListsCache;
  const resp = await fetch("/api/aliases");
  aliasListsCache = await resp.json();
  return aliasListsCache;
}

// Turns raw OCR text into {modelo, cor, quantidade} candidates using the
// same model/color alias dictionaries the server uses for matching.
function parseOcrText(text, models, colors) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = [];
  let currentModelo = "";

  for (const line of lines) {
    const norm = normalizeOcr(line);
    const modelMatch = models.find((m) => norm.includes(m.alias));
    const colorMatch = colors.find((c) => norm.includes(c.alias));
    const { qty, text: rest } = splitQtyAndText(line);

    if (modelMatch && !colorMatch && qty === null) {
      currentModelo = line;
      continue;
    }
    if (colorMatch || qty !== null) {
      items.push({
        modelo: currentModelo || line,
        cor: rest || line,
        quantidade: qty || 1,
      });
      continue;
    }
    currentModelo = line;
  }
  return items;
}

async function runOcr(image, onProgress) {
  const dataUrl = `data:${image.media_type};base64,${image.data}`;
  const { data } = await Tesseract.recognize(dataUrl, "por", { logger: onProgress });
  return data.text;
}

document.getElementById("btnParseImages").addEventListener("click", async () => {
  if (pendingImages.length === 0) {
    alert("Selecione ao menos um print.");
    return;
  }
  const btn = document.getElementById("btnParseImages");
  btn.disabled = true;
  try {
    const { models, colors } = await fetchAliasLists();
    const allItems = [];
    for (let i = 0; i < pendingImages.length; i++) {
      btn.textContent = `Lendo print ${i + 1}/${pendingImages.length}...`;
      const text = await runOcr(pendingImages[i]);
      allItems.push(...parseOcrText(text, models, colors));
    }
    if (allItems.length === 0) {
      alert("Não consegui identificar itens nos prints. Tente a opção \"Colar texto\".");
      return;
    }
    await matchAndRender(allItems);
  } catch (err) {
    alert("Erro ao ler prints: " + err.message);
  } finally {
    btn.textContent = "Ler prints e gerar itens";
    btn.disabled = false;
  }
});

// ---------- Text paste mode ----------
document.getElementById("btnParseText").addEventListener("click", async () => {
  const raw = document.getElementById("textInput").value;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines.map((line) => {
    const parts = line.split(" - ").map((p) => p.trim());
    let modelo = "", cor = "", quantidade = 1;
    if (parts.length >= 3) {
      modelo = parts[0];
      cor = parts[1];
      quantidade = parseInt(parts[2]) || 1;
    } else if (parts.length === 2) {
      modelo = parts[0];
      const m = parts[1].match(/^(.*?)(\d+)?$/);
      cor = (m && m[1] ? m[1].trim() : parts[1]);
      quantidade = (m && m[2]) ? parseInt(m[2]) : 1;
    } else {
      modelo = line;
      cor = "";
      quantidade = 1;
    }
    return { modelo, cor, quantidade };
  });
  await matchAndRender(items);
});

// ---------- Matching + Review table ----------
let reviewRows = [];
let catalogCache = [];

async function fetchCatalogCache() {
  if (catalogCache.length) return catalogCache;
  const resp = await fetch("/api/catalog");
  const data = await resp.json();
  catalogCache = data.skus || [];
  return catalogCache;
}

async function matchAndRender(items) {
  const resp = await fetch("/api/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const data = await resp.json();
  reviewRows = data.results || [];
  await fetchCatalogCache();
  renderReviewTable();
}

function statusStamp(status) {
  if (status === "matched") return `<span class="stamp ok">Ok</span>`;
  if (status === "matched_parcial") return `<span class="stamp warn">Parcial</span>`;
  if (status === "modelo_nao_encontrado") return `<span class="stamp err">Modelo?</span>`;
  if (status === "cor_nao_encontrada") return `<span class="stamp warn">Cor?</span>`;
  if (status === "sku_nao_cadastrado") return `<span class="stamp err">Sem SKU</span>`;
  return `<span class="stamp warn">Revisar</span>`;
}

function renderReviewTable() {
  const tbody = document.getElementById("reviewTableBody");
  tbody.innerHTML = "";
  reviewRows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    const skuOptionsHtml = buildSkuOptions(row.sku_code);
    tr.innerHTML = `
      <td><input type="text" value="${escapeHtml(row.modelo_bruto)}" data-field="modelo_bruto" data-idx="${idx}" /></td>
      <td><input type="text" value="${escapeHtml(row.cor_bruta)}" data-field="cor_bruta" data-idx="${idx}" /></td>
      <td><input type="number" min="1" value="${row.qtd}" data-field="qtd" data-idx="${idx}" style="width:60px" /></td>
      <td>
        <select data-field="sku_code" data-idx="${idx}">
          <option value="">— selecionar —</option>
          ${skuOptionsHtml}
        </select>
      </td>
      <td>${statusStamp(row.status)}</td>
      <td><button class="row-remove" data-idx="${idx}" title="Remover">✕</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("change", onCellChange);
  });
  tbody.querySelectorAll(".row-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      reviewRows.splice(Number(btn.dataset.idx), 1);
      renderReviewTable();
    });
  });
}

function buildSkuOptions(selectedSku) {
  return catalogCache
    .map((s) => {
      const sel = s.sku_code === selectedSku ? "selected" : "";
      return `<option value="${escapeHtml(s.sku_code)}" ${sel}>${escapeHtml(s.produto)} (${escapeHtml(s.sku_code)})</option>`;
    })
    .join("");
}

async function onCellChange(e) {
  const idx = Number(e.target.dataset.idx);
  const field = e.target.dataset.field;
  const row = reviewRows[idx];
  if (field === "qtd") {
    row.qtd = Number(e.target.value) || 1;
    return;
  }
  if (field === "sku_code") {
    const chosen = catalogCache.find((s) => s.sku_code === e.target.value);
    if (chosen) {
      row.sku_code = chosen.sku_code;
      row.produto_matched = chosen.produto;
      row.color_matched = chosen.color;
      row.status = "manual";
      // teach the system: save aliases for future matches
      if (row.modelo_bruto && chosen.model_code) {
        fetch("/api/aliases/model", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ alias: row.modelo_bruto, model_code: chosen.model_code }),
        }).catch(() => {});
      }
      if (row.cor_bruta && chosen.color) {
        fetch("/api/aliases/color", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ alias: row.cor_bruta, color: chosen.color }),
        }).catch(() => {});
      }
    }
    renderReviewTable();
    return;
  }
  if (field === "modelo_bruto" || field === "cor_bruta") {
    row[field] = e.target.value;
    // re-match this single row
    const resp = await fetch("/api/match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ modelo: row.modelo_bruto, cor: row.cor_bruta, quantidade: row.qtd }] }),
    });
    const data = await resp.json();
    reviewRows[idx] = data.results[0];
    renderReviewTable();
  }
}

document.getElementById("btnAddRow").addEventListener("click", () => {
  reviewRows.push({
    modelo_bruto: "",
    cor_bruta: "",
    qtd: 1,
    sku_code: null,
    produto_matched: null,
    color_matched: null,
    status: "manual",
  });
  renderReviewTable();
});

document.getElementById("btnExport").addEventListener("click", async () => {
  if (reviewRows.length === 0) {
    alert("Não há itens para exportar.");
    return;
  }

  // group by sku (or by modelo+cor if no sku) summing quantities
  const groups = {};
  reviewRows.forEach((r) => {
    const key = r.sku_code || `${r.modelo_bruto}__${r.cor_bruta}`;
    if (!groups[key]) {
      groups[key] = {
        produto: r.produto_matched || r.modelo_bruto,
        cor: r.color_matched || r.cor_bruta,
        sku: r.sku_code || "",
        qtd: 0,
      };
    }
    groups[key].qtd += Number(r.qtd) || 0;
  });

  const rows = Object.values(groups);

  const wsData = [["Produto", "Cor", "SKU", "Quantidade"]];
  rows.forEach((r) => wsData.push([r.produto, r.cor, r.sku, r.qtd]));
  wsData.push(["TOTAL GERAL", "", "", rows.reduce((a, r) => a + r.qtd, 0)]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!cols"] = [{ wch: 40 }, { wch: 18 }, { wch: 20 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Conferencia");
  const fname = `conferencia_estoque_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fname);

  // save to history
  try {
    await fetch("/api/conferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: fname, items: reviewRows }),
    });
  } catch (e) {
    // non-blocking
  }
});

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- Catálogo tab ----------
const catalogFileInput = document.getElementById("catalogFileInput");
catalogFileInput.parentElement.addEventListener("click", () => {});
catalogFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("catalogImportStatus");
  statusEl.textContent = "Lendo planilha...";
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const records = rows.map((r) => {
    const produto = r["Produto"] || r["produto"] || "";
    const sku_code = r["Código (SKU)"] || r["SKU"] || r["sku_code"] || r["Codigo (SKU)"] || "";
    const gtin = r["GTIN/EAN"] || r["gtin"] || "";
    return { produto, sku_code, gtin };
  }).filter((r) => r.produto && r.sku_code);

  const resp = await fetch("/api/catalog/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ records }),
  });
  const result = await resp.json();
  statusEl.textContent = `✓ Catálogo atualizado: ${result.imported} produtos importados.`;
  catalogCache = [];
  loadCatalog();
});

document.getElementById("catalogSearch").addEventListener("input", (e) => {
  loadCatalog(e.target.value);
});

async function loadCatalog(query) {
  const url = query ? `/api/catalog?q=${encodeURIComponent(query)}` : "/api/catalog";
  const resp = await fetch(url);
  const data = await resp.json();
  const tbody = document.getElementById("catalogTableBody");
  tbody.innerHTML = "";
  (data.skus || []).forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(s.base || s.produto)}</td><td>${escapeHtml(s.color)}</td><td class="sku-code">${escapeHtml(s.sku_code)}</td>`;
    tbody.appendChild(tr);
  });
}

// ---------- Histórico tab ----------
async function loadHistory() {
  const resp = await fetch("/api/conferences");
  const data = await resp.json();
  const tbody = document.getElementById("historyTableBody");
  tbody.innerHTML = "";
  (data.conferences || []).forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${new Date(c.created_at).toLocaleString("pt-BR")}</td><td>${escapeHtml(c.name)}</td><td>-</td><td><span class="history-item-link" data-id="${c.id}">ver itens</span></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".history-item-link").forEach((link) => {
    link.addEventListener("click", () => showHistoryDetail(link.dataset.id));
  });
}

async function showHistoryDetail(id) {
  const resp = await fetch(`/api/conferences/${id}`);
  const data = await resp.json();
  const el = document.getElementById("historyDetail");
  let html = `<h3 style="font-family:var(--font-display);font-size:14px;margin-top:20px;">Itens da conferência #${id}</h3>`;
  html += `<div class="table-wrap"><table><thead><tr><th>Produto</th><th>Cor</th><th>Qtd</th><th>SKU</th></tr></thead><tbody>`;
  (data.items || []).forEach((it) => {
    html += `<tr><td>${escapeHtml(it.produto_matched || it.modelo_bruto)}</td><td>${escapeHtml(it.color_matched || it.cor_bruta)}</td><td>${it.qtd}</td><td class="sku-code">${escapeHtml(it.sku_matched)}</td></tr>`;
  });
  html += `</tbody></table></div>`;
  el.innerHTML = html;
}
