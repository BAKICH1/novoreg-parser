(function () {
  "use strict";

  const PAGE_SIZE = 30;
  const LS_CRM_KEY = "novoreg_crm_map_v1";
  const LS_LIVE_LEADS_KEY = "novoreg_live_leads_v1";
  const LS_KEYS_KEY = "novoreg_api_keys_v1";
  const LS_THEME_KEY = "novoreg_theme_v1";

  const state = {
    serverLeads: [],
    siteDataLeads: [],
    liveLeads: [],
    mergedLeads: [],
    filteredLeads: [],
    stats: null,
    lastUpdatedIso: "",
    crmMap: {},
    cloudNoteIds: {},
    siteDataReady: false,
    page: 1,
    filters: {
      q: "",
      entityType: "",
      contactMode: "",
      region: "",
      category: "",
      crm: "",
      sort: "smart",
    },
  };

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function copyText(txt, label) {
    if (!txt) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(() => {
        showToast(label || `Скопировано: ${txt}`);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast(label || `Скопировано: ${txt}`);
    }
  }

  function normalizePhoneJS(raw) {
    if (!raw) return null;
    let d = String(raw).replace(/\D/g, "");
    if (d.length === 10 && ["9", "4", "8", "3"].includes(d[0])) d = "7" + d;
    else if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
    else if (!(d.length === 11 && d[0] === "7")) return null;

    const b = d.slice(1);
    const area = parseInt(b.slice(0, 3), 10);
    const okArea =
      (area >= 900 && area <= 999) ||
      area === 800 ||
      area === 804 ||
      (area >= 300 && area <= 499) ||
      (area >= 811 && area <= 879);
    if (!okArea) return null;
    return `+7 (${b.slice(0, 3)}) ${b.slice(3, 6)}-${b.slice(6, 8)}-${b.slice(8, 10)}`;
  }

  function digitsOnly(ph) {
    return String(ph || "").replace(/\D/g, "");
  }

  function isMobilePhone(ph) {
    const d = digitsOnly(ph);
    return d.length === 11 && d.startsWith("79");
  }

  function formatDateRu(iso) {
    if (!iso) return "—";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return iso;
    return `${m[3]}.${m[2]}.${m[1]}`;
  }

  function loadLocalStorageState() {
    try {
      state.crmMap = JSON.parse(localStorage.getItem(LS_CRM_KEY) || "{}") || {};
    } catch (_) {
      state.crmMap = {};
    }
    try {
      state.liveLeads = JSON.parse(localStorage.getItem(LS_LIVE_LEADS_KEY) || "[]") || [];
    } catch (_) {
      state.liveLeads = [];
    }
    try {
      const keys = JSON.parse(localStorage.getItem(LS_KEYS_KEY) || "{}") || {};
      if (keys.dadata) document.getElementById("live-dadata-key").value = keys.dadata;
      if (keys.twogis) document.getElementById("live-twogis-key").value = keys.twogis;
    } catch (_) {}

    const savedTheme = localStorage.getItem(LS_THEME_KEY) || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);
  }

  function getCrm(leadId) {
    return state.crmMap[leadId] || { stage: "new", note: "" };
  }

  async function saveCrm(leadId, stage, note) {
    state.crmMap[leadId] = { stage, note, updatedAt: new Date().toISOString() };
    try {
      localStorage.setItem(LS_CRM_KEY, JSON.stringify(state.crmMap));
    } catch (_) {}

    // Синхронизация со встроенной облачной БД here.now Site Data (если сайт закреплён за аккаунтом)
    try {
      const existingRecId = state.cloudNoteIds[leadId];
      if (existingRecId) {
        await fetch(`./.herenow/data/crm_notes/${encodeURIComponent(existingRecId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ crm_stage: stage, note: note || "" }),
        });
      } else {
        const res = await fetch("./.herenow/data/crm_notes", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
          },
          body: JSON.stringify({
            lead_key: leadId,
            crm_stage: stage,
            note: note || "",
          }),
        });
        if (res.ok) {
          const j = await res.json();
          if (j && j.record && j.record.id) {
            state.cloudNoteIds[leadId] = j.record.id;
          }
        }
      }
    } catch (_) {}

    applyFiltersAndRender(false);
  }

  async function fetchCloudSiteData() {
    try {
      const notesRes = await fetch("./.herenow/data/crm_notes?limit=200", { cache: "no-store" });
      if (notesRes.ok) {
        state.siteDataReady = true;
        const notesJson = await notesRes.json();
        (notesJson.records || []).forEach((rec) => {
          if (rec.lead_key) {
            state.cloudNoteIds[rec.lead_key] = rec.id;
            state.crmMap[rec.lead_key] = {
              stage: rec.crm_stage || "new",
              note: rec.note || "",
            };
          }
        });
      }
    } catch (_) {}

    try {
      const leadsRes = await fetch("./.herenow/data/leads?limit=200", { cache: "no-store" });
      if (leadsRes.ok) {
        const lj = await leadsRes.json();
        state.siteDataLeads = (lj.records || []).map((r) => ({
          id: r.lead_key || `sd-${r.id}`,
          entity_type: r.entity_type || "ООО",
          name: r.name || "",
          full_name: r.name || "",
          inn: r.inn || "",
          ogrn: r.ogrn || "",
          kpp: "",
          reg_date: r.reg_date || "",
          region_code: r.region_code || "",
          region_name: r.region_name || "",
          address: r.address || "",
          person_name: r.person_name || "",
          person_role: r.entity_type === "ИП" ? "Индивидуальный предприниматель" : "Руководитель",
          okved_code: r.okved_code || "",
          okved_name: r.okved_category || "",
          okved_category: r.okved_category || "Прочие виды деятельности",
          phones: r.phones_all ? r.phones_all.split(",").map((s) => s.trim()).filter(Boolean) : [],
          emails: r.email_primary ? [r.email_primary] : [],
          websites: r.website ? [r.website] : [],
          socials: {},
          sources: r.source_tag ? r.source_tag.split(",").map((s) => s.trim()) : ["Site Data"],
          has_phone: Boolean(r.has_phone),
        }));
      }
    } catch (_) {}
  }

  function mergeAllLeads() {
    const map = new Map();
    const all = [...state.liveLeads, ...state.siteDataLeads, ...state.serverLeads];

    for (const item of all) {
      if (!item || !item.name) continue;
      const key = item.inn ? `inn-${item.inn}` : item.ogrn ? `ogrn-${item.ogrn}` : item.id;
      if (!map.has(key)) {
        map.set(key, {
          ...item,
          id: item.id || key,
          phones: Array.isArray(item.phones) ? [...item.phones] : [],
          emails: Array.isArray(item.emails) ? [...item.emails] : [],
          websites: Array.isArray(item.websites) ? [...item.websites] : [],
          sources: Array.isArray(item.sources) ? [...item.sources] : [],
          socials: item.socials || {},
        });
      } else {
        const cur = map.get(key);
        (item.phones || []).forEach((p) => {
          if (!cur.phones.includes(p)) cur.phones.push(p);
        });
        (item.emails || []).forEach((e) => {
          if (!cur.emails.includes(e)) cur.emails.push(e);
        });
        (item.websites || []).forEach((w) => {
          if (!cur.websites.includes(w)) cur.websites.push(w);
        });
        (item.sources || []).forEach((s) => {
          if (!cur.sources.includes(s)) cur.sources.push(s);
        });
        cur.has_phone = cur.phones.length > 0;
      }
    }

    state.mergedLeads = Array.from(map.values()).map((x) => ({
      ...x,
      has_phone: (x.phones && x.phones.length > 0),
    }));
  }

  async function loadServerData(isSilentPoll) {
    try {
      const [statsRes, leadsRes] = await Promise.all([
        fetch(`./data/stats.json?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`./data/leads.json?t=${Date.now()}`, { cache: "no-store" }),
      ]);

      if (statsRes.ok) {
        const st = await statsRes.json();
        const prevIso = state.lastUpdatedIso;
        state.stats = st;
        state.lastUpdatedIso = st.updated_at || "";
        if (isSilentPoll && prevIso && state.lastUpdatedIso && prevIso !== state.lastUpdatedIso) {
          showToast("🔔 Получены свежие данные от фонового парсера!");
        }
      }

      if (leadsRes.ok) {
        const ld = await leadsRes.json();
        state.serverLeads = Array.isArray(ld.leads) ? ld.leads : Array.isArray(ld) ? ld : [];
      }
    } catch (err) {
      console.warn("Не удалось загрузить JSON:", err);
    }

    await fetchCloudSiteData();
    mergeAllLeads();
    populateDynamicSelects();
    renderKPIsAndAnalytics();
    applyFiltersAndRender(false);
  }

  function populateDynamicSelects() {
    const regSelect = document.getElementById("f-region");
    const catSelect = document.getElementById("f-category");
    const curReg = regSelect.value;
    const curCat = catSelect.value;

    const regCounts = {};
    const catCounts = {};
    for (const l of state.mergedLeads) {
      if (l.region_code && l.region_name) {
        const k = `${l.region_code}|${l.region_name}`;
        regCounts[k] = (regCounts[k] || 0) + 1;
      }
      if (l.okved_category) {
        catCounts[l.okved_category] = (catCounts[l.okved_category] || 0) + 1;
      }
    }

    const regEntries = Object.entries(regCounts).sort((a, b) => b[1] - a[1]);
    regSelect.innerHTML = `<option value="">Все регионы РФ (${regEntries.length})</option>` +
      regEntries
        .map(([k, cnt]) => {
          const [code, name] = k.split("|");
          return `<option value="${esc(code)}">${esc(code)} — ${esc(name)} (${cnt})</option>`;
        })
        .join("");
    regSelect.value = curReg;

    const catEntries = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    catSelect.innerHTML = `<option value="">Все отрасли ОКВЭД (${catEntries.length})</option>` +
      catEntries
        .map(([cat, cnt]) => `<option value="${esc(cat)}">${esc(cat)} (${cnt})</option>`)
        .join("");
    catSelect.value = curCat;
  }

  function renderKPIsAndAnalytics() {
    const all = state.mergedLeads;
    const total = all.length;
    const ipCount = all.filter((x) => x.entity_type === "ИП").length;
    const oooCount = all.filter((x) => x.entity_type === "ООО").length;
    const withPhone = all.filter((x) => x.phones && x.phones.length > 0).length;
    const withMobile = all.filter((x) => (x.phones || []).some(isMobilePhone)).length;
    const withEmail = all.filter((x) => x.emails && x.emails.length > 0).length;
    const withSite = all.filter((x) => x.websites && x.websites.length > 0).length;
    const regs = new Set(all.map((x) => x.region_code).filter(Boolean)).size;
    const pct = total ? ((withPhone / total) * 100).toFixed(1) : "0.0";

    document.getElementById("nav-count-total").textContent = String(total);
    document.getElementById("kpi-total").textContent = String(total);
    document.getElementById("kpi-split").textContent = `ООО: ${oooCount} • ИП: ${ipCount}`;
    document.getElementById("kpi-phones").textContent = String(withPhone);
    document.getElementById("kpi-phone-rate").textContent = `Покрытие телефонами: ${pct}%`;
    document.getElementById("kpi-mobile").textContent = String(withMobile);
    document.getElementById("kpi-email-site").textContent = `Email: ${withEmail} • Сайтов: ${withSite}`;
    document.getElementById("kpi-regions").textContent = `${regs} субъектов РФ`;

    if (state.stats && state.stats.updated_at) {
      const dt = new Date(state.stats.updated_at);
      const timeStr = isNaN(dt.getTime())
        ? state.stats.updated_at
        : dt.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      document.getElementById("last-updated-label").textContent = `Автопарсер активен • Обновлено: ${timeStr}`;
      document.getElementById("kpi-runs").textContent =
        `Циклов сбора: ${state.stats.runs_count || 1} • Конвейер 2-в-1`;
    } else {
      document.getElementById("last-updated-label").textContent = `База загружена (${total} записей)`;
    }

    // Диаграммы аналитики
    renderBarChart(
      "chart-regions",
      (state.stats && state.stats.top_regions) || []
    );
    renderBarChart(
      "chart-categories",
      (state.stats && state.stats.top_categories) || []
    );
    renderBarChart(
      "chart-sources",
      (state.stats && state.stats.sources_breakdown) || []
    );

    const runsBox = document.getElementById("runs-log-box");
    const runs = (state.stats && state.stats.recent_runs) || [];
    if (runs.length) {
      runsBox.textContent = runs
        .map(
          (r) =>
            `[${r.timestamp}] Найдено за цикл: ${r.fetched} | Новых: +${r.added_new} | Обновлено: ${r.updated} | Время: ${r.duration_sec}с | Модули: ${(r.sources || []).join(", ")}`
        )
        .join("\n");
    } else {
      runsBox.textContent = "Циклы сбора выполнены успешно.";
    }

    // Автоподстановка slug текущего сайта here.now во вкладке настройки
    const host = window.location.hostname || "";
    if (host.endsWith(".here.now")) {
      const slug = host.replace(".here.now", "");
      const secBlock = document.getElementById("setup-secrets-block");
      if (secBlock) {
        secBlock.textContent = secBlock.textContent.replace(
          /HERENOW_SLUG\s*=\s*[^\n]+/,
          `HERENOW_SLUG        = ${slug}`
        );
      }
    }
  }

  function renderBarChart(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = `<div style="color: var(--text-muted); font-size: 13px;">Нет данных</div>`;
      return;
    }
    const maxVal = Math.max(...items.map((x) => x.count || 0), 1);
    el.innerHTML = items
      .map((item) => {
        const w = Math.max(4, Math.round(((item.count || 0) / maxVal) * 100));
        return `
          <div class="bar-row">
            <div class="bar-row-top">
              <span>${esc(item.label)}</span>
              <strong>${esc(item.count)}</strong>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width: ${w}%"></div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function applyFiltersAndRender(resetPage) {
    if (resetPage) state.page = 1;
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");

    let list = state.mergedLeads.filter((l) => {
      if (f.entityType && l.entity_type !== f.entityType) return false;
      if (f.region && l.region_code !== f.region) return false;
      if (f.category && l.okved_category !== f.category) return false;

      if (f.contactMode === "phone" && !(l.phones && l.phones.length)) return false;
      if (f.contactMode === "mobile" && !(l.phones || []).some(isMobilePhone)) return false;
      if (f.contactMode === "email" && !(l.emails && l.emails.length)) return false;
      if (f.contactMode === "site" && !(l.websites && l.websites.length)) return false;

      if (f.crm) {
        const st = getCrm(l.id).stage || "new";
        if (st !== f.crm) return false;
      }

      if (q) {
        const hay = [
          l.name,
          l.full_name,
          l.inn,
          l.ogrn,
          l.person_name,
          l.address,
          l.region_name,
          l.okved_code,
          l.okved_name,
          ...(l.phones || []),
          ...(l.emails || []),
          ...(l.websites || []),
        ]
          .join(" ")
          .toLowerCase();

        const phoneDigitsMatch =
          qDigits.length >= 4 &&
          (l.phones || []).some((p) => digitsOnly(p).includes(qDigits));

        if (!hay.includes(q) && !phoneDigitsMatch) return false;
      }

      return true;
    });

    if (f.sort === "date_desc") {
      list.sort((a, b) => String(b.reg_date || "").localeCompare(String(a.reg_date || "")));
    } else if (f.sort === "phones_desc") {
      list.sort((a, b) => (b.phones || []).length - (a.phones || []).length);
    } else if (f.sort === "region_asc") {
      list.sort((a, b) => String(a.region_code || "99").localeCompare(String(b.region_code || "99")));
    } else {
      list.sort((a, b) => {
        const pa = a.phones && a.phones.length ? 1 : 0;
        const pb = b.phones && b.phones.length ? 1 : 0;
        if (pb !== pa) return pb - pa;
        return String(b.reg_date || "").localeCompare(String(a.reg_date || ""));
      });
    }

    state.filteredLeads = list;
    renderTable();
  }

  function renderTable() {
    const tbody = document.getElementById("leads-tbody");
    const total = state.filteredLeads.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;

    const start = (state.page - 1) * PAGE_SIZE;
    const slice = state.filteredLeads.slice(start, start + PAGE_SIZE);

    const phonesInFilter = state.filteredLeads.filter((x) => x.phones && x.phones.length).length;
    document.getElementById("results-summary").textContent =
      `Найдено ${total} контрагентов (из них с телефоном: ${phonesInFilter}) • Показаны ${total ? start + 1 : 0}–${start + slice.length}`;
    document.getElementById("page-info").textContent = `Страница ${state.page} из ${totalPages}`;
    document.getElementById("btn-prev-page").disabled = state.page <= 1;
    document.getElementById("btn-next-page").disabled = state.page >= totalPages;

    if (!slice.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 38px; color: var(--text-muted);">
            По выбранным фильтрам записей не найдено. Попробуйте сбросить фильтры или запустить «⚡ Живой поиск по API».
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = slice
      .map((l) => {
        const isIp = l.entity_type === "ИП";
        const crm = getCrm(l.id);
        const stageClass = `crm-stage-${crm.stage || "new"}`;

        const phonesHtml =
          l.phones && l.phones.length
            ? `<div class="phone-list">` +
              l.phones
                .slice(0, 2)
                .map((ph) => {
                  const dg = digitsOnly(ph);
                  const waBtn = isMobilePhone(ph)
                    ? `<a href="https://wa.me/${dg}" target="_blank" rel="noopener" class="mini-action" onclick="event.stopPropagation()" title="Написать в WhatsApp">WA</a>`
                    : "";
                  return `
                    <div class="phone-item">
                      <a href="tel:+${dg}" class="phone-link" onclick="event.stopPropagation()">${esc(ph)}</a>
                      <button type="button" class="mini-action js-copy" data-copy="${esc(ph)}" title="Скопировать номер">📋</button>
                      ${waBtn}
                    </div>
                  `;
                })
                .join("") +
              (l.phones.length > 2
                ? `<span style="font-size:11px; color:var(--text-muted);">+ ещё ${l.phones.length - 2} ном.</span>`
                : "") +
              `</div>`
            : `<span class="no-phone-tag">Нет публичного номера</span>`;

        const extraContacts = [];
        if (l.emails && l.emails[0]) {
          extraContacts.push(
            `<a href="mailto:${esc(l.emails[0])}" onclick="event.stopPropagation()" style="font-size:12px;">✉️ ${esc(l.emails[0])}</a>`
          );
        }
        if (l.websites && l.websites[0]) {
          const shortHost = l.websites[0].replace(/^https?:\/\//, "");
          extraContacts.push(
            `<a href="${esc(l.websites[0])}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:12px;">🌐 ${esc(shortHost)}</a>`
          );
        }

        const codesHtml = [
          l.inn ? `<span class="code-chip" title="ИНН">ИНН ${esc(l.inn)}</span>` : "",
          l.ogrn ? `<span class="code-chip" title="ОГРН / ОГРНИП">ОГРН ${esc(l.ogrn)}</span>` : "",
        ]
          .filter(Boolean)
          .join("");

        return `
          <tr class="js-lead-row ${stageClass}" data-id="${esc(l.id)}">
            <td>
              <div class="lead-title">
                <span class="type-badge ${isIp ? "type-ip" : "type-ooo"}">${esc(l.entity_type)}</span>
                ${esc(l.name)}
              </div>
              <div class="lead-codes">${codesHtml || '<span style="font-size:11px;color:var(--text-dim);">Каталог МСП</span>'}</div>
            </td>
            <td style="white-space: nowrap; font-weight: 600;">
              ${esc(formatDateRu(l.reg_date))}
            </td>
            <td style="max-width: 230px;">
              <div style="font-weight: 600; font-size: 12.5px;">${esc(l.region_code)} — ${esc(l.region_name)}</div>
              <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">${esc((l.address || "").slice(0, 85))}</div>
            </td>
            <td style="max-width: 210px;">
              <div style="font-size: 12px; font-weight: 600;">
                ${l.okved_code ? `<span class="code-chip">${esc(l.okved_code)}</span> ` : ""}${esc(l.okved_category)}
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">${esc((l.okved_name || "").slice(0, 75))}</div>
            </td>
            <td style="max-width: 180px;">
              <div style="font-size: 12.5px; font-weight: 600;">${esc(l.person_name || "—")}</div>
              <div style="font-size: 11px; color: var(--text-dim);">${esc(l.person_role || "")}</div>
            </td>
            <td>
              ${phonesHtml}
              ${extraContacts.length ? `<div style="margin-top:5px; display:flex; flex-direction:column; gap:2px;">${extraContacts.join("")}</div>` : ""}
            </td>
            <td>
              ${(l.sources || []).map((s) => `<span class="source-pill">${esc(s)}</span>`).join("")}
            </td>
            <td onclick="event.stopPropagation()">
              <select class="crm-select js-crm-stage" data-id="${esc(l.id)}" aria-label="Статус CRM">
                <option value="new" ${crm.stage === "new" ? "selected" : ""}>🆕 Новый</option>
                <option value="work" ${crm.stage === "work" ? "selected" : ""}>⏳ В работе</option>
                <option value="callback" ${crm.stage === "callback" ? "selected" : ""}>📞 Перезвон</option>
                <option value="won" ${crm.stage === "won" ? "selected" : ""}>✅ Клиент</option>
                <option value="lost" ${crm.stage === "lost" ? "selected" : ""}>❌ Отказ</option>
              </select>
              ${crm.note ? `<div style="font-size:11px; color:var(--amber); margin-top:4px; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(crm.note)}">📝 ${esc(crm.note)}</div>` : ""}
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function openLeadDrawer(leadId) {
    const lead = state.mergedLeads.find((x) => x.id === leadId);
    if (!lead) return;

    const crm = getCrm(lead.id);
    const isIp = lead.entity_type === "ИП";
    document.getElementById("d-badges").innerHTML = `
      <span class="type-badge ${isIp ? "type-ip" : "type-ooo"}">${esc(lead.entity_type)}</span>
      ${(lead.sources || []).map((s) => `<span class="source-pill">${esc(s)}</span>`).join("")}
    `;
    document.getElementById("d-title").textContent = lead.name;
    document.getElementById("d-fullname").textContent = lead.full_name || "";

    const phonesBlock =
      lead.phones && lead.phones.length
        ? lead.phones
            .map((ph) => {
              const dg = digitsOnly(ph);
              return `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; background:var(--bg-input); border:1px solid var(--border); border-radius:8px; margin-bottom:6px; flex-wrap:wrap;">
                  <a href="tel:+${dg}" class="phone-link" style="font-size:15px;">${esc(ph)}</a>
                  <div style="display:flex; gap:6px;">
                    <a href="tel:+${dg}" class="btn btn-sm btn-emerald">📞 Позвонить</a>
                    ${isMobilePhone(ph) ? `<a href="https://wa.me/${dg}" target="_blank" rel="noopener" class="btn btn-sm">💬 WhatsApp</a>` : ""}
                    <button type="button" class="btn btn-sm js-copy" data-copy="${esc(ph)}">📋 Копия</button>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div style="color:var(--text-muted); font-size:13px;">В открытом доступе телефон пока не опубликован. Проверьте контрагента во внешних справочниках ниже или через 2ГИС API.</div>`;

    const checkQuery = encodeURIComponent(lead.inn || lead.ogrn || lead.name);
    const body = document.getElementById("drawer-body");
    body.innerHTML = `
      <div>
        <div style="font-size:12px; font-weight:700; color:var(--text-muted); margin-bottom:8px; text-transform:uppercase;">Деловые телефоны и связь</div>
        ${phonesBlock}
        ${
          lead.emails && lead.emails.length
            ? `<div style="margin-top:8px;"><strong>Email:</strong> ${lead.emails
                .map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`)
                .join(", ")}</div>`
            : ""
        }
        ${
          lead.websites && lead.websites.length
            ? `<div style="margin-top:6px;"><strong>Сайт:</strong> ${lead.websites
                .map((w) => `<a href="${esc(w)}" target="_blank" rel="noopener">${esc(w)}</a>`)
                .join(", ")}</div>`
            : ""
        }
      </div>

      <div class="detail-grid">
        <div class="detail-box">
          <div class="lbl">ИНН</div>
          <div class="val">${lead.inn ? `${esc(lead.inn)} <button class="mini-action js-copy" data-copy="${esc(lead.inn)}">📋</button>` : "Не указан"}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">ОГРН / ОГРНИП</div>
          <div class="val">${lead.ogrn ? `${esc(lead.ogrn)} <button class="mini-action js-copy" data-copy="${esc(lead.ogrn)}">📋</button>` : "Не указан"}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">Дата регистрации</div>
          <div class="val">${esc(formatDateRu(lead.reg_date))}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">Регион РФ</div>
          <div class="val">${esc(lead.region_code)} — ${esc(lead.region_name)}</div>
        </div>
        <div class="detail-box" style="grid-column: span 2;">
          <div class="lbl">${esc(lead.person_role || "Руководитель / ИП")}</div>
          <div class="val">${esc(lead.person_name || "Не указан")}</div>
        </div>
        <div class="detail-box" style="grid-column: span 2;">
          <div class="lbl">Юридический адрес / локация</div>
          <div class="val">${esc(lead.address || "—")}</div>
        </div>
        <div class="detail-box" style="grid-column: span 2;">
          <div class="lbl">Основной ОКВЭД и сфера деятельности</div>
          <div class="val">${lead.okved_code ? `${esc(lead.okved_code)} — ` : ""}${esc(lead.okved_name || lead.okved_category)}</div>
        </div>
      </div>

      <div class="detail-box">
        <div class="lbl" style="margin-bottom:8px;">Быстрая проверка в реестрах и на картах</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <a class="btn btn-sm" href="https://checko.ru/search?query=${checkQuery}" target="_blank" rel="noopener">Checko.ru ↗</a>
          <a class="btn btn-sm" href="https://www.rusprofile.ru/search?query=${checkQuery}" target="_blank" rel="noopener">Rusprofile ↗</a>
          <a class="btn btn-sm" href="https://2gis.ru/search/${encodeURIComponent(lead.name + " " + (lead.region_name || ""))}" target="_blank" rel="noopener">Найти в 2ГИС ↗</a>
          <a class="btn btn-sm" href="https://egrul.nalog.ru/" target="_blank" rel="noopener">ФНС Выписка ↗</a>
        </div>
      </div>

      <div class="detail-box">
        <div class="lbl" style="margin-bottom:8px; font-weight:700; color:var(--text);">Мини-CRM прозвона (сохраняется автоматически)</div>
        <div class="form-group">
          <label for="drawer-crm-stage">Этап работы с лидом</label>
          <select id="drawer-crm-stage" class="select-control">
            <option value="new" ${crm.stage === "new" ? "selected" : ""}>🆕 Новый (не звонили)</option>
            <option value="work" ${crm.stage === "work" ? "selected" : ""}>⏳ В работе</option>
            <option value="callback" ${crm.stage === "callback" ? "selected" : ""}>📞 Перезвонить позже</option>
            <option value="won" ${crm.stage === "won" ? "selected" : ""}>✅ Клиент / Передан в отдел продаж</option>
            <option value="lost" ${crm.stage === "lost" ? "selected" : ""}>❌ Отказ / Неактуально</option>
          </select>
        </div>
        <div class="form-group">
          <label for="drawer-crm-note">Заметка менеджера по звонку</label>
          <textarea id="drawer-crm-note" rows="3" class="input-control" placeholder="Например: ЛПР выходит в понедельник, отправить КП на расчётный счёт / бухгалтерию…">${esc(crm.note || "")}</textarea>
        </div>
        <button type="button" class="btn btn-primary" id="btn-save-drawer-crm" data-id="${esc(lead.id)}">
          💾 Сохранить статус и заметку
        </button>
      </div>
    `;

    document.getElementById("drawer-backdrop").classList.add("open");
    document.getElementById("lead-drawer").classList.add("open");
  }

  function closeDrawer() {
    document.getElementById("drawer-backdrop").classList.remove("open");
    document.getElementById("lead-drawer").classList.remove("open");
  }

  // ЭКСПОРТ В CSV И EXCEL (.XLS XML SpreadsheetML)
  function exportCSV() {
    const rows = state.filteredLeads;
    if (!rows.length) {
      showToast("Нет записей для выгрузки");
      return;
    }
    const headers = [
      "Форма",
      "Наименование",
      "ИНН",
      "ОГРН_ОГРНИП",
      "Дата_регистрации",
      "Код_региона",
      "Регион",
      "ОКВЭД",
      "Отрасль",
      "Руководитель_ИП",
      "Телефоны",
      "Email",
      "Сайт",
      "Адрес",
      "Источники",
      "CRM_статус",
      "Заметка",
    ];

    const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [headers.join(";")];
    for (const l of rows) {
      const crm = getCrm(l.id);
      lines.push(
        [
          l.entity_type,
          l.name,
          l.inn ? `'${l.inn}` : "",
          l.ogrn ? `'${l.ogrn}` : "",
          formatDateRu(l.reg_date),
          l.region_code,
          l.region_name,
          l.okved_code,
          l.okved_category,
          l.person_name,
          (l.phones || []).join(", "),
          (l.emails || []).join(", "),
          (l.websites || []).join(", "),
          l.address,
          (l.sources || []).join(", "),
          crm.stage,
          crm.note,
        ]
          .map(csvEscape)
          .join(";")
      );
    }

    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8;",
    });
    triggerDownload(blob, `novoregi_rf_${new Date().toISOString().slice(0, 10)}.csv`);
    showToast(`Выгружено ${rows.length} записей в CSV`);
  }

  function exportExcelXML() {
    const rows = state.filteredLeads;
    if (!rows.length) {
      showToast("Нет записей для выгрузки");
      return;
    }
    const cols = [
      ["Форма", 65],
      ["Наименование ИП / ООО", 240],
      ["ИНН", 105],
      ["ОГРН / ОГРНИП", 125],
      ["Дата рег.", 85],
      ["Регион РФ", 150],
      ["ОКВЭД", 75],
      ["Отрасль", 165],
      ["Руководитель / ИП", 180],
      ["Телефоны", 210],
      ["Email", 160],
      ["Сайт", 150],
      ["Адрес", 240],
      ["Источник", 130],
      ["CRM Статус", 90],
      ["Заметка менеджера", 180],
    ];

    const xmlEsc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const colTags = cols.map(([, w]) => `<Column ss:Width="${w}"/>`).join("");
    const headerCells = cols
      .map(([title]) => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${xmlEsc(title)}</Data></Cell>`)
      .join("");

    const dataRows = rows
      .map((l) => {
        const crm = getCrm(l.id);
        const vals = [
          l.entity_type,
          l.name,
          l.inn,
          l.ogrn,
          formatDateRu(l.reg_date),
          `${l.region_code} — ${l.region_name}`,
          l.okved_code,
          l.okved_category,
          l.person_name,
          (l.phones || []).join(", "),
          (l.emails || []).join(", "),
          (l.websites || []).join(", "),
          l.address,
          (l.sources || []).join(", "),
          crm.stage,
          crm.note,
        ];
        return (
          "<Row>" +
          vals
            .map((v) => `<Cell ss:StyleID="txt"><Data ss:Type="String">${xmlEsc(v)}</Data></Cell>`)
            .join("") +
          "</Row>"
        );
      })
      .join("\n");

    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="hdr">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E3A8A" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="txt">
   <NumberFormat ss:Format="@"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Новореги ИП и ООО">
  <Table>
   ${colTags}
   <Row>${headerCells}</Row>
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;

    const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8;" });
    triggerDownload(blob, `novoregi_ip_ooo_${new Date().toISOString().slice(0, 10)}.xls`);
    showToast(`Выгружено ${rows.length} карточек в Excel`);
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 300);
  }

  // LIVE BROWSER API ПОИСК (DaData + 2ГИС)
  async function runLiveBrowserSearch() {
    const dadataKey = document.getElementById("live-dadata-key").value.trim();
    const twogisKey = document.getElementById("live-twogis-key").value.trim();
    const entityMode = document.getElementById("live-entity-type").value;
    const maxDays = parseInt(document.getElementById("live-max-days").value, 10) || 30;
    const rawQueries = document.getElementById("live-query").value;
    const logEl = document.getElementById("live-log");

    if (!dadataKey) {
      logEl.textContent =
        "⚠️ Укажите бесплатный API-ключ DaData.ru (выдаётся сразу после подтверждения почты на dadata.ru/profile — 10 000 запросов в день бесплатно).";
      showToast("Введите API-ключ DaData");
      return;
    }

    const queries = rawQueries
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!queries.length) {
      logEl.textContent = "⚠️ Введите хотя бы одно ключевое слово или префикс ОГРН.";
      return;
    }

    const minTimestamp = Date.now() - maxDays * 86400 * 1000;
    const partyTypes = entityMode === "BOTH" ? ["INDIVIDUAL", "LEGAL"] : [entityMode];
    const discovered = [];

    logEl.textContent = `⏳ Запуск живого поиска (${queries.length} запросов, возраст <= ${maxDays} дн.)…\n`;

    for (const q of queries) {
      for (const ptype of partyTypes) {
        try {
          const res = await fetch(
            "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Token ${dadataKey}`,
              },
              body: JSON.stringify({
                query: q,
                count: 20,
                type: ptype,
                status: ["ACTIVE"],
              }),
            }
          );

          if (!res.ok) {
            logEl.textContent += `❌ Ошибка DaData HTTP ${res.status} на запросе "${q}"\n`;
            continue;
          }
          const json = await res.json();
          const items = json.suggestions || [];
          let matchedHere = 0;

          for (const it of items) {
            const d = it.data || {};
            const regTs = d.state && d.state.registration_date;
            if (!regTs || regTs < minTimestamp) continue;

            const isIp = d.type === "INDIVIDUAL";
            const shortName = (d.name && d.name.short_with_opf) || it.value || "";
            if (!isIp && !shortName.toUpperCase().startsWith("ООО")) continue;

            const phones = [];
            (d.phones || []).forEach((ph) => {
              const np = normalizePhoneJS(ph.value || ph);
              if (np && !phones.includes(np)) phones.push(np);
            });

            const emails = (d.emails || [])
              .map((em) => String(em.value || em || "").toLowerCase())
              .filter(Boolean);

            const fio = d.fio
              ? [d.fio.surname, d.fio.name, d.fio.patronymic].filter(Boolean).join(" ")
              : (d.management && d.management.name) || "";

            const kladr = String((d.address && d.address.data && d.address.data.region_kladr_id) || "").slice(0, 2);
            const regionLabel = (d.address && d.address.data && d.address.data.region_with_type) || "Россия";

            discovered.push({
              id: `inn-${d.inn || d.ogrn}`,
              entity_type: isIp ? "ИП" : "ООО",
              name: shortName,
              full_name: (d.name && d.name.full_with_opf) || shortName,
              inn: String(d.inn || ""),
              ogrn: String(d.ogrn || ""),
              kpp: String(d.kpp || ""),
              reg_date: new Date(regTs).toISOString().slice(0, 10),
              region_code: kladr || "77",
              region_name: regionLabel,
              address: (d.address && d.address.value) || "",
              person_name: fio,
              person_role: isIp ? "Индивидуальный предприниматель" : "Генеральный директор",
              okved_code: String(d.okved || ""),
              okved_name: "",
              okved_category: "Свежие из Live API",
              phones,
              emails,
              websites: [],
              socials: {},
              sources: ["Live DaData API"],
              has_phone: phones.length > 0,
            });
            matchedHere++;
          }
          logEl.textContent += `✔ Запрос "${q}" (${ptype === "INDIVIDUAL" ? "ИП" : "ООО"}): найдено свежих новорегов — ${matchedHere}\n`;
        } catch (err) {
          logEl.textContent += `❌ Сбой сети на "${q}": ${err.message}\n`;
        }
      }
    }

    // Опциональное дообогащение телефонов через 2ГИС API прямо в браузере
    if (twogisKey && discovered.length) {
      logEl.textContent += `🔎 Дообогащение телефонов через 2ГИС API…\n`;
      let enriched = 0;
      for (const lead of discovered.slice(0, 15)) {
        if (lead.phones.length) continue;
        const cleanBrand = lead.name.replace(/^(ООО|ИП)\s*/i, "").replace(/["«»]/g, "").trim();
        try {
          const u = `https://catalog.api.2gis.com/3.0/items?q=${encodeURIComponent(cleanBrand + " " + lead.region_name)}&fields=items.contact_groups&page_size=2&key=${encodeURIComponent(twogisKey)}`;
          const r2 = await fetch(u);
          if (r2.ok) {
            const j2 = await r2.json();
            const top = j2.result && j2.result.items && j2.result.items[0];
            if (top && top.contact_groups) {
              for (const g of top.contact_groups) {
                for (const c of g.contacts || []) {
                  if (c.type === "phone") {
                    const np = normalizePhoneJS(c.value || c.text);
                    if (np && !lead.phones.includes(np)) lead.phones.push(np);
                  } else if (c.type === "email" && c.value) {
                    lead.emails.push(c.value);
                  }
                }
              }
              if (lead.phones.length) {
                lead.has_phone = true;
                lead.sources.push("2ГИС API");
                enriched++;
              }
            }
          }
        } catch (_) {}
      }
      logEl.textContent += `📞 Дообогащено номерами из 2ГИС: +${enriched}\n`;
    }

    state.liveLeads = [...discovered, ...state.liveLeads].slice(0, 1000);
    try {
      localStorage.setItem(LS_LIVE_LEADS_KEY, JSON.stringify(state.liveLeads));
    } catch (_) {}

    mergeAllLeads();
    populateDynamicSelects();
    renderKPIsAndAnalytics();
    applyFiltersAndRender(true);

    logEl.textContent += `\n🎉 Готово! Добавлено в таблицу: ${discovered.length} свежих записей. Перейдите во вкладку «База новорегов» для фильтрации и выгрузки в Excel.`;
    showToast(`Добавлено новорегов: ${discovered.length}`);
  }

  function bindEvents() {
    // Вкладки
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".nav-tab").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        const target = document.getElementById(btn.dataset.tab);
        if (target) target.classList.add("active");
      });
    });

    // Тема
    document.getElementById("btn-theme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(LS_THEME_KEY, next);
    });

    document.getElementById("btn-refresh").addEventListener("click", () => {
      showToast("Синхронизация с сервером…");
      loadServerData(false);
    });

    // Поиск и селекты
    document.getElementById("f-search").addEventListener("input", (e) => {
      state.filters.q = e.target.value;
      applyFiltersAndRender(true);
    });
    document.getElementById("f-region").addEventListener("change", (e) => {
      state.filters.region = e.target.value;
      applyFiltersAndRender(true);
    });
    document.getElementById("f-category").addEventListener("change", (e) => {
      state.filters.category = e.target.value;
      applyFiltersAndRender(true);
    });
    document.getElementById("f-crm").addEventListener("change", (e) => {
      state.filters.crm = e.target.value;
      applyFiltersAndRender(true);
    });
    document.getElementById("f-sort").addEventListener("change", (e) => {
      state.filters.sort = e.target.value;
      applyFiltersAndRender(true);
    });

    // Сегментированные кнопки
    document.querySelectorAll("#seg-type .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#seg-type .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.filters.entityType = btn.dataset.val || "";
        applyFiltersAndRender(true);
      });
    });

    document.querySelectorAll("#seg-contact .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#seg-contact .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.filters.contactMode = btn.dataset.val || "";
        applyFiltersAndRender(true);
      });
    });

    document.getElementById("btn-reset-filters").addEventListener("click", () => {
      state.filters = {
        q: "",
        entityType: "",
        contactMode: "",
        region: "",
        category: "",
        crm: "",
        sort: "smart",
      };
      document.getElementById("f-search").value = "";
      document.getElementById("f-region").value = "";
      document.getElementById("f-category").value = "";
      document.getElementById("f-crm").value = "";
      document.getElementById("f-sort").value = "smart";
      document.querySelectorAll("#seg-type .seg-btn").forEach((b, i) => b.classList.toggle("active", i === 0));
      document.querySelectorAll("#seg-contact .seg-btn").forEach((b, i) => b.classList.toggle("active", i === 0));
      applyFiltersAndRender(true);
    });

    // Пагинация
    document.getElementById("btn-prev-page").addEventListener("click", () => {
      if (state.page > 1) {
        state.page--;
        renderTable();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
    document.getElementById("btn-next-page").addEventListener("click", () => {
      state.page++;
      renderTable();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    // Делегирование кликов по таблице и карточке
    document.addEventListener("click", (e) => {
      const copyBtn = e.target.closest(".js-copy");
      if (copyBtn) {
        e.stopPropagation();
        copyText(copyBtn.dataset.copy);
        return;
      }

      const saveDrawerBtn = e.target.closest("#btn-save-drawer-crm");
      if (saveDrawerBtn) {
        const lid = saveDrawerBtn.dataset.id;
        const stg = document.getElementById("drawer-crm-stage").value;
        const note = document.getElementById("drawer-crm-note").value;
        saveCrm(lid, stg, note);
        showToast("✅ Статус и заметка сохранены");
        return;
      }

      const row = e.target.closest(".js-lead-row");
      if (row && !e.target.closest("select, a, button")) {
        openLeadDrawer(row.dataset.id);
      }
    });

    document.addEventListener("change", (e) => {
      const sel = e.target.closest(".js-crm-stage");
      if (sel) {
        const lid = sel.dataset.id;
        const cur = getCrm(lid);
        saveCrm(lid, sel.value, cur.note || "");
        showToast("Статус CRM обновлён");
      }
    });

    document.getElementById("btn-close-drawer").addEventListener("click", closeDrawer);
    document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    // Экспорт
    document.getElementById("btn-export-csv").addEventListener("click", exportCSV);
    document.getElementById("btn-export-xls").addEventListener("click", exportExcelXML);
    document.getElementById("btn-copy-phones").addEventListener("click", () => {
      const phones = [];
      const seen = new Set();
      for (const l of state.filteredLeads) {
        for (const p of l.phones || []) {
          if (!seen.has(p)) {
            seen.add(p);
            phones.push(p);
          }
        }
      }
      if (!phones.length) {
        showToast("В текущей выборке нет телефонов");
        return;
      }
      copyText(phones.join("\n"), `Скопировано номеров: ${phones.length}`);
    });

    // Live API
    document.getElementById("btn-run-live").addEventListener("click", runLiveBrowserSearch);
    document.getElementById("btn-save-keys").addEventListener("click", () => {
      const dadata = document.getElementById("live-dadata-key").value.trim();
      const twogis = document.getElementById("live-twogis-key").value.trim();
      localStorage.setItem(LS_KEYS_KEY, JSON.stringify({ dadata, twogis }));
      showToast("🔑 Ключи сохранены в вашем браузере");
    });
    document.getElementById("btn-clear-live").addEventListener("click", () => {
      state.liveLeads = [];
      localStorage.removeItem(LS_LIVE_LEADS_KEY);
      mergeAllLeads();
      populateDynamicSelects();
      renderKPIsAndAnalytics();
      applyFiltersAndRender(true);
      showToast("Локальный кэш Live-поиска очищен");
    });
  }

  // Инициализация
  loadLocalStorageState();
  bindEvents();
  loadServerData(false);

  // Авто-пуллинг свежих данных от крона каждые 60 секунд без перезагрузки страницы
  setInterval(() => {
    loadServerData(true);
  }, 60000);
})();
