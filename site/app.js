(function () {
  "use strict";

  const PAGE_SIZE = 30;
  const LS_CRM_KEY = "novoreg_crm_map_v1";
  const LS_LIVE_LEADS_KEY = "novoreg_live_leads_v1";
  const LS_EDGE_LEADS_KEY = "novoreg_edge_leads_v1";
  const LS_KEYS_KEY = "novoreg_api_keys_v1";
  const LS_THEME_KEY = "novoreg_theme_v1";

  const state = {
    serverLeads: [],
    siteDataLeads: [],
    edgeLocalLeads: [],
    liveLeads: [],
    mergedLeads: [],
    filteredLeads: [],
    stats: null,
    lastUpdatedIso: "",
    cloudHarvestIso: "",
    harvestCursor: {
      recId: "",
      city_cursor: 0,
      cat_cursor: 0,
      cat_page: 1,
      last_harvest_iso: "",
    },
    harvestRunning: false,
    turboActive: false,
    turboAddedCount: 0,
    turboTimer: null,
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
      orgStatus: "",
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
    if (new Set(b.split("")).size <= 2) return null;
    if (
      b.startsWith("000") ||
      b.endsWith("0000000") ||
      b === "1234567890" ||
      b === "9999999999" ||
      b === "8664553252"
    ) {
      return null;
    }
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
      state.edgeLocalLeads = JSON.parse(localStorage.getItem(LS_EDGE_LEADS_KEY) || "[]") || [];
    } catch (_) {
      state.edgeLocalLeads = [];
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

  const EDGE_CITY_FEEDS = [
    ["moskva", "77", "г. Москва"],
    ["sankt-peterburg", "78", "г. Санкт-Петербург"],
    ["krasnodar", "23", "Краснодарский край"],
    ["ekaterinburg", "66", "Свердловская область"],
    ["novosibirsk", "54", "Новосибирская область"],
    ["kazan", "16", "Республика Татарстан"],
    ["nizhniy-novgorod", "52", "Нижегородская область"],
    ["rostov-na-donu", "61", "Ростовская область"],
    ["samara", "63", "Самарская область"],
    ["chelyabinsk", "74", "Челябинская область"],
    ["ufa", "02", "Республика Башкортостан"],
    ["krasnoyarsk", "24", "Красноярский край"],
    ["voronezh", "36", "Воронежская область"],
    ["perm", "59", "Пермский край"],
    ["tyumen", "72", "Тюменская область"],
    ["volgograd", "34", "Волгоградская область"],
    ["saratov", "64", "Саратовская область"],
    ["tolyatti", "63", "Самарская область"],
    ["izhevsk", "18", "Удмуртская Республика"],
    ["barnaul", "22", "Алтайский край"],
    ["ulyanovsk", "73", "Ульяновская область"],
    ["irkutsk", "38", "Иркутская область"],
    ["khabarovsk", "27", "Хабаровский край"],
    ["yaroslavl", "76", "Ярославская область"],
    ["vladivostok", "25", "Приморский край"],
    ["tomsk", "70", "Томская область"],
    ["orenburg", "56", "Оренбургская область"],
    ["kemerovo", "42", "Кемеровская область — Кузбасс"],
    ["ryazan", "62", "Рязанская область"],
    ["astrakhan", "30", "Астраханская область"],
    ["penza", "58", "Пензенская область"],
    ["lipetsk", "48", "Липецкая область"],
    ["kirov", "43", "Кировская область"],
    ["cheboksary", "21", "Чувашская Республика"],
    ["tula", "71", "Тульская область"],
    ["kaliningrad", "39", "Калининградская область"],
    ["kursk", "46", "Курская область"],
    ["stavropol", "26", "Ставропольский край"],
    ["sochi", "23", "Краснодарский край"],
    ["tver", "69", "Тверская область"],
    ["ivanovo", "37", "Ивановская область"],
    ["bryansk", "32", "Брянская область"],
    ["belgorod", "31", "Белгородская область"],
  ];

  const EDGE_CATEGORY_FEEDS = [
    ["строительство", "41.20", "Строительство, ремонт и недвижимость"],
    ["бизнес", "70.22", "Консалтинг, право и бухгалтерия"],
    ["услуги", "96.09", "Услуги населению и бизнесу"],
    ["промышленность", "25.11", "Производство и промышленность"],
    ["розничная_торговля", "47.19", "Торговля оптовая и розничная"],
    ["транспорт", "49.41", "Транспорт и логистика"],
    ["informatsionnye-tekhnologii", "62.01", "ИТ, связь и разработка ПО"],
    ["nedvizhimost", "68.31", "Строительство, ремонт и недвижимость"],
    ["avto-i-moto", "45.20", "Транспорт и логистика"],
    ["yuridicheskie-uslugi", "69.10", "Консалтинг, право и бухгалтерия"],
    ["reklama-i-poligrafiya", "73.11", "Консалтинг, право и бухгалтерия"],
    ["dom-i-interer", "43.39", "Строительство, ремонт и недвижимость"],
    ["otdelochnye-raboty", "43.39", "Строительство, ремонт и недвижимость"],
    ["ремонт", "43.39", "Строительство, ремонт и недвижимость"],
    ["odezhda-i-obuv", "47.71", "Торговля оптовая и розничная"],
    ["krasota-i-zdorove", "96.02", "Услуги населению и бизнесу"],
    ["restorany-kafe", "56.10", "Гостиницы и общепит"],
    ["oteli-i-gostinitsy", "55.10", "Гостиницы и общепит"],
    ["медицина", "86.21", "Медицина и фармацевтика"],
    ["kompyuternyy-remont", "95.11", "ИТ, связь и разработка ПО"],
    ["remont-elektriki", "43.21", "Строительство, ремонт и недвижимость"],
    ["remont-instrumentov", "33.12", "Производство и промышленность"],
    ["dorozhnyy-remont", "42.11", "Строительство, ремонт и недвижимость"],
    ["remont-elektroniki", "95.21", "Услуги населению и бизнесу"],
    ["жкх_и_благоустройство", "81.21", "Строительство, ремонт и недвижимость"],
    ["образование", "85.42", "Услуги населению и бизнесу"],
    ["sport", "93.11", "Услуги населению и бизнесу"],
    ["туризм_и_отдых", "79.11", "Услуги населению и бизнесу"],
    ["досуг", "93.29", "Услуги населению и бизнесу"],
  ];

  function getTodayIsoDate() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function decodeHtmlEntities(str) {
    if (!str) return "";
    const txt = document.createElement("textarea");
    txt.innerHTML = String(str);
    return txt.value.replace(/\s+/g, " ").trim();
  }

  function classifyRubricToOkved(rubric, fallbackCat) {
    const r = String(rubric || "").toLowerCase();
    if (/строит|ремонт|недвиж|окна|двер|мебел|архитект|сантех|электр/.test(r))
      return "Строительство, ремонт и недвижимость";
    if (/торгов|магаз|оптов|маркет|автозапч|одежд|цвет|продукт/.test(r))
      return "Торговля оптовая и розничная";
    if (/сайт|программ|компьют|связь|интернет|маркетинг|реклам|дизайн/.test(r))
      return "ИТ, связь и разработка ПО";
    if (/перевоз|логист|такси|доставк|склад|автосервис|шиномонтаж/.test(r))
      return "Транспорт и логистика";
    if (/кафе|ресторан|кофейн|бар|отел|гостин|пекарн|пицц/.test(r))
      return "Гостиницы и общепит";
    if (/юрид|адвокат|бухгалт|нотари|консалт|аудит|страхов|финанс/.test(r))
      return "Консалтинг, право и бухгалтерия";
    if (/завод|производ|металл|станок|оборудован|упаковк|фабрик/.test(r))
      return "Производство и промышленность";
    if (/клиник|стоматол|медиц|аптек|ветеринар/.test(r))
      return "Медицина и фармацевтика";
    return fallbackCat || "Услуги населению и бизнесу";
  }

  function inferRegionFromCitySlug(slug) {
    const hit = EDGE_CITY_FEEDS.find((c) => c[0] === slug);
    if (hit) return { code: hit[1], name: hit[2] };
    return { code: "77", name: "г. Москва" };
  }

  const BAD_TG_SLUGS = new Set([
    "share", "iv", "joinchat", "addstickers", "proxy", "socks", "login",
    "orgpage", "tilda", "wordpress", "bitrix", "telegram", "botfather",
    "contact", "dl", "setlanguage",
  ]);

  function normalizeTelegramJS(raw) {
    if (!raw) return "";
    const s = String(raw).trim();
    const mUrl = /(?:https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?|tg:\/\/resolve\?domain=|^@)([a-zA-Z][a-zA-Z0-9_]{3,31})\b/i.exec(s);
    if (mUrl && !BAD_TG_SLUGS.has(mUrl[1].toLowerCase())) {
      return `@${mUrl[1]}`;
    }
    if (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(s) && !BAD_TG_SLUGS.has(s.toLowerCase())) {
      return `@${s}`;
    }
    return "";
  }

  function extractTelegramJS(html) {
    if (!html) return "";
    const rx = /(?:https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?|tg:\/\/resolve\?domain=)([a-zA-Z][a-zA-Z0-9_]{3,31})\b/gi;
    let m;
    while ((m = rx.exec(html)) !== null) {
      if (!BAD_TG_SLUGS.has(m[1].toLowerCase())) return `@${m[1]}`;
    }
    return "";
  }

  function compactWorkHoursJS(raw) {
    if (!raw) return "";
    let s = decodeHtmlEntities(String(raw).replace(/<[^>]+>/g, " "));
    const reps = [
      [/\bПонедельник\s*[-–—]\s*пятница\b/gi, "Пн-Пт"],
      [/\bПонедельник\s*[-–—]\s*четверг\b/gi, "Пн-Чт"],
      [/\bПонедельник\s*[-–—]\s*суббота\b/gi, "Пн-Сб"],
      [/\bПонедельник\s*[-–—]\s*воскресенье\b/gi, "Пн-Вс"],
      [/\bСуббота\s*[,–—\-]\s*воскресенье\b/gi, "Сб-Вс"],
      [/\bПятница\s*[-–—]\s*суббота\b/gi, "Пт-Сб"],
      [/\bПонедельник\b/gi, "Пн"],
      [/\bВторник\b/gi, "Вт"],
      [/\bСреда\b/gi, "Ср"],
      [/\bЧетверг\b/gi, "Чт"],
      [/\bПятница\b/gi, "Пт"],
      [/\bСуббота\b/gi, "Сб"],
      [/\bВоскресенье\b/gi, "Вс"],
      [/\s*[–—]\s*/g, ": "],
      [/:\s*:/g, ":"],
      [/\(перерыв:\s*с\s*/gi, "(пер. "],
      [/\s+до\s+/gi, "-"],
    ];
    for (const [pat, rep] of reps) s = s.replace(pat, rep);
    return s.replace(/\s+/g, " ").replace(/^[ ;,.]+|[ ;,.]+$/g, "").slice(0, 180);
  }

  function extractWorkHoursJS(html) {
    if (!html) return "";
    const lines = [];
    for (const pm of html.matchAll(/<div[^>]*class=["']period["'][^>]*>([\s\S]*?)<\/div>/gi)) {
      for (const p of pm[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
        const cp = compactWorkHoursJS(p[1]);
        if (cp && !lines.includes(cp)) lines.push(cp);
      }
    }
    if (lines.length) return lines.join("; ").slice(0, 180);

    const meta = /itemprop=["']openingHours["'][^>]*content=["']([^"']{3,120})["']/i.exec(html);
    if (meta) return compactWorkHoursJS(meta[1]);
    return "";
  }

  function detectOrgStatusJS(html, workHours) {
    const wh = String(workHours || "").toLowerCase();
    if (wh === "пн-вс: выходной" || wh === "выходной") {
      return { isActive: false, status: "Временно не работает" };
    }
    if (html) {
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ");
      if (
        /(?:организация\s+(?:больше\s+не\s+работает|закрыта|ликвидирована)|компания\s+(?:закрыта|больше\s+не\s+работает)|деятельность\s+прекращена|временно\s+не\s+работает|закрыто\s+навсегда)/i.test(
          stripped
        )
      ) {
        return { isActive: false, status: "Закрыта / не работает" };
      }
    }
    return { isActive: true, status: "Действующая" };
  }

  function computeTelegramFields(lead) {
    const tg =
      normalizeTelegramJS(lead.telegram) ||
      normalizeTelegramJS(lead.socials && lead.socials.telegram);
    let mobPhone = lead.telegram_phone || "";
    if (!mobPhone && Array.isArray(lead.phones)) {
      const hit = lead.phones.find(isMobilePhone);
      if (hit) mobPhone = `+${digitsOnly(hit)}`;
    }
    return {
      telegram: tg,
      telegram_phone: mobPhone,
      telegram_status: tg ? "verified" : mobPhone ? "by_phone" : "none",
    };
  }

  async function checkSabyFnsOnline(inn) {
    const cleanInn = String(inn || "").replace(/\D/g, "");
    if (cleanInn.length !== 10 && cleanInn.length !== 12) return null;
    try {
      const res = await fetch(`./api/saby/contragents/${cleanInn}`, { cache: "no-store" });
      if (!res.ok) return null;
      const html = await res.text();
      const liqDate = /"ДатаЛиквидации"\s*:\s*"([^"]+)"/.exec(html);
      const inLiq = /"ВПроцессеЛиквидации"\s*:\s*true/i.test(html);
      const stHtml = /<b>Статус:<\/b>\s*([^<]{3,90})/i.exec(html);
      const dirHtml = /<b>(?:Генеральный директор|Директор|Руководитель|Предприниматель):<\/b>\s*([^<]{4,100})/i.exec(html);
      const ogrnHtml = /ОГРН(?:ИП)?[\s:]*(\d{13}|\d{15})\b/.exec(html);

      let isActive = true;
      let status = "Действующая (ФНС)";
      if (liqDate && liqDate[1] && liqDate[1] !== "null") {
        isActive = false;
        status = `Закрыта / ликвидирована (${liqDate[1].slice(0, 10)})`;
      } else if (inLiq) {
        isActive = false;
        status = "В процессе ликвидации (ФНС)";
      } else if (stHtml) {
        const stTxt = decodeHtmlEntities(stHtml[1]).replace(/\.$/, "");
        if (/ликвидир|прекращ|не действует|закрыт|банкрот/i.test(stTxt)) {
          isActive = false;
          status = `Закрыта (${stTxt})`;
        } else {
          isActive = true;
          status = "Действующая (ФНС)";
        }
      }
      return {
        isActive,
        status,
        personName: dirHtml ? decodeHtmlEntities(dirHtml[1]).replace(/\.$/, "") : "",
        ogrn: ogrnHtml ? ogrnHtml[1] : "",
      };
    } catch (_) {
      return null;
    }
  }

  function mapCloudRecordToLead(r) {
    const d = r.data || r;
    const cleanPhones = [];
    const rawPhones = d.phones_all
      ? String(d.phones_all).split(",")
      : d.phone_primary
      ? [d.phone_primary]
      : [];
    rawPhones.forEach((s) => {
      const np = normalizePhoneJS(s);
      if (np && !cleanPhones.includes(np)) cleanPhones.push(np);
    });
    return {
      id: d.lead_key || `sd-${r.id}`,
      entity_type: d.entity_type || "ООО",
      name: d.name || "",
      full_name: d.name || "",
      inn: d.inn || "",
      ogrn: d.ogrn || "",
      kpp: "",
      reg_date: d.reg_date || "",
      created_at: r.createdAt || "",
      region_code: d.region_code || "",
      region_name: d.region_name || "",
      address: d.address || "",
      person_name: d.person_name || "",
      person_role:
        d.entity_type === "ИП" ? "Индивидуальный предприниматель" : "Руководитель",
      okved_code: d.okved_code || "",
      okved_name: d.okved_category || "",
      okved_category: d.okved_category || "Прочие виды деятельности",
      phones: cleanPhones,
      emails: d.email_primary ? [d.email_primary] : [],
      websites: d.website ? [d.website] : [],
      socials: d.telegram ? { telegram: `https://t.me/${String(d.telegram).replace(/^@/, "")}` } : {},
      status: d.org_status || "Действующая",
      is_active: d.is_active !== false,
      work_hours: d.work_hours || "",
      telegram: d.telegram || "",
      telegram_status: d.telegram_status || "",
      telegram_phone: d.telegram_phone || "",
      sources: d.source_tag
        ? String(d.source_tag)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["Edge-облако Here.now"],
      has_phone: cleanPhones.length > 0,
    };
  }

  async function fetchCloudSiteData(isIncremental) {
    // Запускаем чтение CRM-заметок и курсора параллельно без блокировки
    await Promise.allSettled([
      (async () => {
        try {
          const notesRes = await fetch("./.herenow/data/crm_notes?limit=100", { cache: "no-store" });
          if (notesRes.ok) {
            state.siteDataReady = true;
            const notesJson = await notesRes.json();
            (notesJson.records || []).forEach((rec) => {
              const d = rec.data || rec;
              if (d.lead_key) {
                state.cloudNoteIds[d.lead_key] = rec.id;
                state.crmMap[d.lead_key] = {
                  stage: d.crm_stage || "new",
                  note: d.note || "",
                };
              }
            });
          }
        } catch (_) {}
      })(),
      (async () => {
        try {
          const hsRes = await fetch("./.herenow/data/harvest_state?limit=5", { cache: "no-store" });
          if (hsRes.ok) {
            const hsJson = await hsRes.json();
            const recs = hsJson.records || [];
            const globalRec = recs.find((r) => (r.data || r).state_key === "global") || recs[0];
            if (globalRec) {
              const d = globalRec.data || globalRec;
              state.harvestCursor = {
                recId: globalRec.id,
                city_cursor: Math.max(state.harvestCursor.city_cursor || 0, Number(d.city_cursor || 0)),
                cat_cursor: Math.max(state.harvestCursor.cat_cursor || 0, Number(d.cat_cursor || 0)),
                cat_page: Math.max(1, Number(d.cat_page || 1)),
                last_harvest_iso: d.last_harvest_iso || globalRec.updatedAt || "",
              };
              if (state.harvestCursor.last_harvest_iso) {
                state.cloudHarvestIso = state.harvestCursor.last_harvest_iso;
              }
            }
          }
        } catch (_) {}
      })(),
    ]);

    try {
      // На фоновом опросе, если облако уже загружено, подтягиваем только свежую первую страницу (мгновенно!)
      const maxPages = isIncremental && state.siteDataLeads.length > 0 ? 2 : 25;
      const fetchedRecords = [];
      let cursor = "";

      for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
        const url = cursor
          ? `./.herenow/data/leads?limit=100&cursor=${encodeURIComponent(cursor)}`
          : "./.herenow/data/leads?limit=100";
        const leadsRes = await fetch(url, { cache: "no-store" });
        if (!leadsRes.ok) break;
        const lj = await leadsRes.json();
        const batch = lj.records || [];
        fetchedRecords.push(...batch);

        // Мгновенное прогрессивное отображение первой сотни облачных лидов без ожидания хвоста пагинации
        if (pageIdx === 0 && batch.length && !isIncremental) {
          const firstMapped = batch.map(mapCloudRecordToLead).filter((x) => x.name);
          if (firstMapped.length) {
            const byId = new Map(state.siteDataLeads.map((x) => [x.id, x]));
            firstMapped.forEach((x) => byId.set(x.id, x));
            state.siteDataLeads = Array.from(byId.values());
            mergeAllLeads();
            populateDynamicSelects();
            renderKPIsAndAnalytics();
            applyFiltersAndRender(false);
          }
        }

        if (!lj.nextCursor || !batch.length) break;
        cursor = lj.nextCursor;
      }

      if (fetchedRecords.length) {
        const newestCreated = fetchedRecords[0].createdAt || "";
        if (newestCreated && (!state.cloudHarvestIso || newestCreated > state.cloudHarvestIso)) {
          state.cloudHarvestIso = newestCreated;
        }
        const mapped = fetchedRecords.map(mapCloudRecordToLead).filter((x) => x.name);
        if (isIncremental && state.siteDataLeads.length > 0) {
          const mergedCloud = new Map(state.siteDataLeads.map((x) => [x.id, x]));
          mapped.forEach((x) => mergedCloud.set(x.id, x));
          state.siteDataLeads = Array.from(mergedCloud.values());
        } else {
          state.siteDataLeads = mapped;
        }
      }
    } catch (_) {}
  }

  const EXCLUDED_OPF_RX = /^(?:ЗАО|ОАО|ПАО|НАО|АО|ГБУ|ГБУЗ|ГБОУ|МБУ|МБОУ|МУП|ГУП|ФГУП|ФГБУ|АНО|ТСЖ|ТСН|СНТ|ДНП|ФОНД|КОЛЛЕГИЯ)$/i;

  function parseOrgpageCardHtml(html, pathUrl, fallbackReg, fallbackCat, fallbackOkved) {
    const cm = /companyData\s*=\s*(\{[\s\S]*?\});/.exec(html);
    if (!cm) return null;
    let cd = null;
    try {
      cd = JSON.parse(cm[1]);
    } catch (_) {
      return null;
    }
    const rawName = decodeHtmlEntities(cd.name || "");
    if (!rawName || rawName.length < 2) return null;

    const opfRaw = decodeHtmlEntities(cd.opf || "").trim();
    const opfUpper = opfRaw.toUpperCase();
    // Пропускаем бюджетные учреждения, ЗАО/ПАО/АО/ТСЖ — собираем целевые ИП и ООО
    if (opfUpper && EXCLUDED_OPF_RX.test(opfUpper)) {
      return null;
    }

    const phones = [];
    const addPh = (raw) => {
      const np = normalizePhoneJS(raw);
      if (np && !phones.includes(np)) phones.push(np);
    };
    if (cd.phone) addPh(cd.phone);
    const telMatches = html.matchAll(/(?:tel:|itemprop=["']telephone["'][^>]*content=["'])([^"'<>]+)/gi);
    for (const m of telMatches) addPh(m[1]);
    // Дополнительно из блока контактов без <script>/<meta>
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<meta[^>]+>/gi, " ");
    const rxPh = /(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
    let pm;
    while ((pm = rxPh.exec(stripped)) !== null) {
      addPh(pm[0]);
      if (phones.length >= 4) break;
    }
    if (!phones.length) return null;

    const emails = [];
    for (const em of html.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,10})/gi)) {
      const addr = em[1].toLowerCase();
      if (!addr.endsWith("orgpage.ru") && !emails.includes(addr)) emails.push(addr);
    }

    const websites = [];
    for (const wm of html.matchAll(/itemprop=["']url["'][^>]*href=["'](https?:\/\/[^"'<>]+)["']/gi)) {
      const w = wm[1].trim();
      if (!w.includes("orgpage.ru") && !websites.includes(w)) websites.push(w);
    }

    // Извлекаем ИНН/ОГРН и явные упоминания ИП ФИО / ООО из текста карточки, если есть
    const flatText = decodeHtmlEntities(stripped.replace(/<[^>]+>/g, " "));
    const innHit = /\bИНН[\s:№]*(\d{12}|\d{10})\b/i.exec(flatText);
    const ogrnHit = /\bОГРН(?:ИП)?[\s:№]*(\d{15}|\d{13})\b/i.exec(flatText);
    const innVal = innHit ? innHit[1] : "";
    const ogrnVal = ogrnHit ? ogrnHit[1] : "";

    const ipFioHit = /\bИП\s+([А-ЯЁ][а-яё\-]+\s+[А-ЯЁ][а-яё.\-]+(?:\s+[А-ЯЁ][а-яё.\-]+)?)/.exec(flatText);
    const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const h1Text = h1Match ? decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, " ")) : "";

    let entityType = "";
    if (
      opfUpper.includes("ИП") ||
      lenEq(innVal, 12) ||
      lenEq(ogrnVal, 15) ||
      /\bИП\b/.test(h1Text) ||
      /^ИП\s+/i.test(rawName) ||
      /\/ip[-_]/i.test(String(pathUrl || "")) ||
      Boolean(ipFioHit)
    ) {
      entityType = "ИП";
    } else if (
      opfUpper.includes("ООО") ||
      lenEq(innVal, 10) ||
      lenEq(ogrnVal, 13) ||
      /\bООО\b/.test(h1Text) ||
      /^ООО[\s"«]/i.test(rawName) ||
      /\/ooo[-_]/i.test(String(pathUrl || ""))
    ) {
      entityType = "ООО";
    } else {
      // Если ОПФ не указана явно: микробизнес с мобильным номером без сайта чаще ИП, остальные — ООО
      entityType = phones[0] && isMobilePhone(phones[0]) && !websites.length ? "ИП" : "ООО";
    }

    const cleanBrand = rawName.replace(/^(?:ООО|ИП)\s*/i, "").replace(/^["«]+|["»]+$/g, "").trim();
    const personFio = ipFioHit ? ipFioHit[1].trim() : entityType === "ИП" ? cleanBrand.slice(0, 150) : "";
    const displayName =
      entityType === "ИП"
        ? ipFioHit
          ? `ИП ${ipFioHit[1].trim()}`
          : rawName.toUpperCase().startsWith("ИП ")
          ? rawName
          : `ИП — ${cleanBrand}`
        : rawName.toUpperCase().startsWith("ООО")
        ? rawName
        : `ООО "${cleanBrand}"`;

    const slugParts = String(pathUrl || "").split("/").filter(Boolean);
    const citySlug = slugParts[0] || "moskva";
    const reg = fallbackReg || inferRegionFromCitySlug(citySlug);
    const rubric = decodeHtmlEntities(cd.rubric || "");
    const category = classifyRubricToOkved(rubric, fallbackCat);
    const addrText = decodeHtmlEntities(cd.address || "");
    const cityText = decodeHtmlEntities(cd.city || "");
    const fullAddr = [reg.name, cityText && !reg.name.includes(cityText) ? cityText : "", addrText]
      .filter(Boolean)
      .join(", ")
      .slice(0, 250);

    const compId = cd.company_id || (/-(\d+)\.html/.exec(pathUrl) || [])[1] || Date.now();
    const leadKey = innVal ? `inn-${innVal}` : `orgpage-${compId}`;
    const todayIso = getTodayIsoDate();
    const workHours = extractWorkHoursJS(html);
    const orgSt = detectOrgStatusJS(html, workHours);
    const tgHandle = extractTelegramJS(html);
    const mobHit = phones.find(isMobilePhone);
    const tgPhone = mobHit ? `+${digitsOnly(mobHit)}` : "";

    return {
      id: leadKey,
      entity_type: entityType,
      name: displayName.slice(0, 195),
      full_name: displayName.slice(0, 195),
      inn: innVal,
      ogrn: ogrnVal,
      kpp: "",
      reg_date: todayIso,
      created_at: new Date().toISOString(),
      region_code: reg.code,
      region_name: reg.name,
      address: fullAddr || reg.name,
      person_name: personFio,
      person_role: entityType === "ИП" ? "Индивидуальный предприниматель" : "Руководитель",
      okved_code: fallbackOkved || "",
      okved_name: rubric || category,
      okved_category: category,
      phones,
      emails: emails.slice(0, 2),
      websites: websites.slice(0, 2),
      socials: tgHandle ? { telegram: `https://t.me/${tgHandle.slice(1)}` } : {},
      status: orgSt.status,
      is_active: orgSt.isActive,
      workHoursHint: Boolean(workHours),
      work_hours: workHours,
      telegram: tgHandle,
      telegram_status: tgHandle ? "verified" : tgPhone ? "by_phone" : "none",
      telegram_phone: tgPhone,
      sources: ["Edge-парсер Here.now", "Открытый каталог РФ"],
      has_phone: true,
    };
  }

  function lenEq(s, n) {
    return Boolean(s && String(s).length === n);
  }

  async function persistLeadToSiteData(lead) {
    try {
      const tgInfo = computeTelegramFields(lead);
      const payload = {
        lead_key: String(lead.id).slice(0, 64),
        entity_type: String(lead.entity_type || "ООО").slice(0, 16),
        name: String(lead.name || "").slice(0, 200),
        inn: String(lead.inn || "").slice(0, 16),
        ogrn: String(lead.ogrn || "").slice(0, 20),
        reg_date: String(lead.reg_date || getTodayIsoDate()).slice(0, 20),
        region_code: String(lead.region_code || "").slice(0, 8),
        region_name: String(lead.region_name || "").slice(0, 120),
        okved_code: String(lead.okved_code || "").slice(0, 24),
        okved_category: String(lead.okved_category || "").slice(0, 100),
        person_name: String(lead.person_name || "").slice(0, 160),
        phone_primary: String((lead.phones && lead.phones[0]) || "").slice(0, 48),
        phones_all: String((lead.phones || []).join(", ")).slice(0, 240),
        email_primary: String((lead.emails && lead.emails[0]) || "").slice(0, 140),
        website: String((lead.websites && lead.websites[0]) || "").slice(0, 200),
        address: String(lead.address || "").slice(0, 260),
        org_status: String(lead.status || "Действующая").slice(0, 80),
        is_active: lead.is_active !== false,
        work_hours: String(lead.work_hours || "").slice(0, 200),
        telegram: String(tgInfo.telegram || "").slice(0, 64),
        telegram_status: String(tgInfo.telegram_status || "none").slice(0, 24),
        telegram_phone: String(tgInfo.telegram_phone || "").slice(0, 24),
        source_tag: String((lead.sources || ["Edge-парсер Here.now"]).join(", ")).slice(0, 140),
        has_phone: Boolean(lead.phones && lead.phones.length > 0),
      };
      const res = await fetch("./.herenow/data/leads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `edge-${lead.id}`,
        },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  async function saveHarvestCursor(nextCursor) {
    state.harvestCursor = { ...state.harvestCursor, ...nextCursor };
    state.cloudHarvestIso = state.harvestCursor.last_harvest_iso;
    const bodyObj = {
      state_key: "global",
      city_cursor: state.harvestCursor.city_cursor,
      cat_cursor: state.harvestCursor.cat_cursor,
      cat_page: state.harvestCursor.cat_page,
      last_harvest_iso: state.harvestCursor.last_harvest_iso,
    };
    try {
      if (state.harvestCursor.recId) {
        await fetch(`./.herenow/data/harvest_state/${encodeURIComponent(state.harvestCursor.recId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyObj),
        });
      } else {
        const res = await fetch("./.herenow/data/harvest_state", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": `hs-${Date.now()}`,
          },
          body: JSON.stringify(bodyObj),
        });
        if (res.ok) {
          const j = await res.json();
          if (j && j.record && j.record.id) state.harvestCursor.recId = j.record.id;
        }
      }
    } catch (_) {}
  }

  async function persistLeadsBatch(leads) {
    const CONCURRENCY = 10;
    for (let i = 0; i < leads.length; i += CONCURRENCY) {
      const slice = leads.slice(i, i + CONCURRENCY);
      await Promise.allSettled(slice.map((l) => persistLeadToSiteData(l)));
    }
  }

  function buildFeedBatch(cursorObj) {
    const specs = [];
    const cBase = cursorObj.city_cursor || 0;
    const rBase = cursorObj.cat_cursor || 0;
    const pageBase = Math.max(1, cursorObj.cat_page || 1);

    // 1) 2 свежие городские ленты для перехвата самых новых 7-значных ID (-61XXXXX / -62XXXXX)
    for (let k = 0; k < 2; k++) {
      const [cSlug, rCode, rName] = EDGE_CITY_FEEDS[(cBase + k) % EDGE_CITY_FEEDS.length];
      specs.push({
        url: `./api/orgpage/${cSlug}/`,
        reg: { code: rCode, name: rName },
        cat: "",
        okved: "",
      });
    }

    // 2) 4 регионально-отраслевые пагинированные ленты (город × рубрика × страница — по ~29 карточек каждая)
    for (let k = 0; k < 4; k++) {
      const [cSlug, rCode, rName] = EDGE_CITY_FEEDS[(cBase + 2 + k * 3) % EDGE_CITY_FEEDS.length];
      const [catSlug, catOkved, catName] = EDGE_CATEGORY_FEEDS[(rBase + k) % EDGE_CATEGORY_FEEDS.length];
      const pg = ((pageBase + k - 1) % 35) + 1;
      const encCat = encodeURIComponent(catSlug);
      specs.push({
        url: pg <= 1 ? `./api/orgpage/${cSlug}/${encCat}/` : `./api/orgpage/${cSlug}/${encCat}/${pg}/`,
        reg: { code: rCode, name: rName },
        cat: catName,
        okved: catOkved,
      });
    }

    // 3) 2 общероссийские пагинированные отраслевые ленты
    for (let k = 0; k < 2; k++) {
      const [catSlug, catOkved, catName] = EDGE_CATEGORY_FEEDS[(rBase + 4 + k) % EDGE_CATEGORY_FEEDS.length];
      const pg = ((pageBase + k) % 45) + 1;
      const encCat = encodeURIComponent(catSlug);
      specs.push({
        url: pg <= 1 ? `./api/orgpage/rossiya/${encCat}/` : `./api/orgpage/rossiya/${encCat}/${pg}/`,
        reg: null,
        cat: catName,
        okved: catOkved,
      });
    }

    return specs;
  }

  function advanceCursorLocal(cursorObj) {
    const nextCat = (cursorObj.cat_cursor || 0) + 6;
    const wrapped = nextCat >= EDGE_CATEGORY_FEEDS.length;
    return {
      ...cursorObj,
      city_cursor: ((cursorObj.city_cursor || 0) + 5) % EDGE_CITY_FEEDS.length,
      cat_cursor: nextCat % EDGE_CATEGORY_FEEDS.length,
      cat_page: wrapped ? ((cursorObj.cat_page || 1) % 45) + 1 : cursorObj.cat_page || 1,
    };
  }

  function extractCandidatesFromFeedHtml(html, feedSpec, existingIds, seenPaths) {
    const out = [];
    const cardRx = /https?:\/\/www\.orgpage\.ru(\/[a-z0-9_\-]+\/[a-z0-9_\-]+-(\d{6,8})\.html)/gi;
    let m;
    while ((m = cardRx.exec(html)) !== null) {
      const pathPart = m[1];
      const compId = m[2];
      const leadKey = `orgpage-${compId}`;
      if (existingIds.has(leadKey) || seenPaths.has(pathPart)) continue;
      seenPaths.add(pathPart);

      // Проверяем окно разметки после заголовка карточки: есть ли уже опубликованный телефон в листинге
      const snippet = html.slice(m.index, m.index + 1350);
      const hasListingPhone = /class=["'][^"']*phone[^"']*["'][\s\S]{0,180}?(?:\+7|8)[\s\-()]*\d{3}/i.test(snippet);
      const numId = Number(compId) || 0;
      const isFreshId = numId >= 6100000;
      const priority = (hasListingPhone ? 4 : 0) + (isFreshId ? 2 : 0) + (numId >= 5300000 ? 1 : 0);

      out.push({
        pathPart,
        leadKey,
        compId: numId,
        priority,
        hasListingPhone,
        reg: feedSpec.reg,
        cat: feedSpec.cat,
        okved: feedSpec.okved,
      });
    }
    return out;
  }

  function updateTurboButtonUI() {
    const tBtn = document.getElementById("btn-turbo-harvest");
    if (!tBtn) return;
    tBtn.classList.toggle("btn-turbo-active", state.turboActive);
    tBtn.setAttribute("aria-pressed", state.turboActive ? "true" : "false");
    const labelSpan = tBtn.querySelector("span");
    if (labelSpan) {
      labelSpan.textContent = state.turboActive
        ? `Турбо: ВКЛ (+${state.turboAddedCount})`
        : "Турбо-поток";
    }
  }

  function toggleTurboHarvest() {
    state.turboActive = !state.turboActive;
    if (state.turboActive) {
      state.turboAddedCount = 0;
      updateTurboButtonUI();
      showToast("Турбо-поток запущен: параллельная подкачка ИП и ООО");
      const loop = async () => {
        if (!state.turboActive) return;
        await runEdgeAutoHarvest(false, true);
        if (state.turboActive) {
          state.turboTimer = setTimeout(loop, 1800);
        }
      };
      loop();
    } else {
      clearTimeout(state.turboTimer);
      state.turboTimer = null;
      updateTurboButtonUI();
      showToast(`Турбо-поток остановлен (добавлено: +${state.turboAddedCount})`);
    }
  }

  async function runEdgeAutoHarvest(isManual, isTurboWave) {
    if (state.harvestRunning) {
      if (isManual) showToast("Параллельный сбор уже выполняется…");
      return;
    }
    state.harvestRunning = true;
    const btn = document.getElementById("btn-edge-harvest");
    const origBtnHtml = btn ? btn.innerHTML : "";
    const targetBatch = isManual ? 36 : isTurboWave ? 28 : 18;
    const CONCURRENCY = 14;

    if (btn && (isManual || isTurboWave)) {
      btn.disabled = isManual;
      btn.textContent = "Сбор: 0…";
    }

    try {
      const existingIds = new Set(state.mergedLeads.map((l) => String(l.id)));
      for (const l of state.mergedLeads) {
        if (l.inn) existingIds.add(`inn-${l.inn}`);
      }
      const seenPaths = new Set();
      let candidateCards = [];
      let proxyAvailable = false;
      let workingCursor = { ...state.harvestCursor };

      if (isManual) {
        const [ , , regName1] = EDGE_CITY_FEEDS[workingCursor.city_cursor % EDGE_CITY_FEEDS.length];
        showToast(`Параллельное сканирование 8 лент (${regName1} и ещё 5 регионов)…`);
      }

      // До 2 волн параллельного опроса 8 лент, чтобы гарантировать полный пакет свежих кандидатов с телефонами
      for (let wave = 0; wave < 2; wave++) {
        const feedSpecs = buildFeedBatch(workingCursor);
        workingCursor = advanceCursorLocal(workingCursor);

        const feedResponses = await Promise.allSettled(
          feedSpecs.map((f) => fetch(f.url, { cache: "no-store" }))
        );

        for (let i = 0; i < feedResponses.length; i++) {
          const fr = feedResponses[i];
          if (fr.status !== "fulfilled" || !fr.value.ok) continue;
          proxyAvailable = true;
          const html = await fr.value.text();
          const extracted = extractCandidatesFromFeedHtml(html, feedSpecs[i], existingIds, seenPaths);
          candidateCards.push(...extracted);
        }

        const withPhoneCount = candidateCards.filter((c) => c.hasListingPhone || c.priority >= 2).length;
        if (!proxyAvailable || withPhoneCount >= targetBatch + 8) break;
      }

      if (!proxyAvailable) {
        if (isManual) {
          showToast("Серверный Edge-прокси активен на домене .here.now");
        }
        return;
      }

      // Приоритет: карточки с уже подтверждённым в листинге телефоном и самыми свежими ID
      candidateCards.sort((a, b) => b.priority - a.priority || b.compId - a.compId);

      // Берём с небольшим запасом, чтобы компенсировать отсев ЗАО/ГБУ и дублей
      const toFetch = candidateCards.slice(0, Math.min(candidateCards.length, Math.round(targetBatch * 1.25)));
      const newlyDiscovered = [];
      const pendingCloudWrites = [];

      for (let offset = 0; offset < toFetch.length && newlyDiscovered.length < targetBatch; offset += CONCURRENCY) {
        const chunk = toFetch.slice(offset, offset + CONCURRENCY);
        const cardRes = await Promise.allSettled(
          chunk.map((c) => fetch(`./api/orgpage${c.pathPart}`, { cache: "no-store" }))
        );

        const waveAdded = [];
        for (let j = 0; j < cardRes.length; j++) {
          const cr = cardRes[j];
          if (cr.status !== "fulfilled" || !cr.value.ok) continue;
          const cardHtml = await cr.value.text();
          const parsed = parseOrgpageCardHtml(
            cardHtml,
            chunk[j].pathPart,
            chunk[j].reg,
            chunk[j].cat,
            chunk[j].okved
          );
          if (parsed && !existingIds.has(parsed.id)) {
            existingIds.add(parsed.id);
            newlyDiscovered.push(parsed);
            waveAdded.push(parsed);
            if (newlyDiscovered.length >= targetBatch) break;
          }
        }

        // Живой стриминг: сразу отрисовываем каждую волну в таблице и KPI без ожидания конца пакета!
        if (waveAdded.length > 0) {
          state.siteDataLeads = [...waveAdded, ...state.siteDataLeads];
          state.edgeLocalLeads = [...waveAdded, ...state.edgeLocalLeads].slice(0, 1500);
          if (state.turboActive) {
            state.turboAddedCount += waveAdded.length;
            updateTurboButtonUI();
          }
          if (btn && (isManual || isTurboWave)) {
            btn.textContent = `Сбор: +${newlyDiscovered.length}…`;
          }
          mergeAllLeads();
          populateDynamicSelects();
          renderKPIsAndAnalytics();
          applyFiltersAndRender(false);

          // Параллельная запись волны в облачную БД без блокировки следующей сетевой волны
          pendingCloudWrites.push(persistLeadsBatch(waveAdded));
        }
      }

      if (newlyDiscovered.length > 0) {
        try {
          localStorage.setItem(LS_EDGE_LEADS_KEY, JSON.stringify(state.edgeLocalLeads));
        } catch (_) {}
      }

      await Promise.allSettled([
        ...pendingCloudWrites,
        saveHarvestCursor({
          city_cursor: workingCursor.city_cursor,
          cat_cursor: workingCursor.cat_cursor,
          cat_page: workingCursor.cat_page,
          last_harvest_iso: new Date().toISOString(),
        }),
      ]);

      if (newlyDiscovered.length > 0) {
        const ipCnt = newlyDiscovered.filter((x) => x.entity_type === "ИП").length;
        const oooCnt = newlyDiscovered.length - ipCnt;
        if (isManual || !state.turboActive) {
          showToast(`Добавлено +${newlyDiscovered.length} (ООО: ${oooCnt}, ИП: ${ipCnt})`);
        }
      } else if (isManual) {
        showToast("Лента прокручена вперёд — нажмите ещё раз");
      }
    } catch (err) {
      console.warn("Edge harvest error:", err);
      if (isManual) showToast("Ошибка сети при опросе прокси");
    } finally {
      state.harvestRunning = false;
      if (btn) {
        btn.disabled = false;
        if (origBtnHtml) btn.innerHTML = origBtnHtml;
        else btn.textContent = "Подтянуть свежие";
      }
    }
  }

  function mergeAllLeads() {
    const map = new Map();
    const all = [
      ...state.liveLeads,
      ...state.siteDataLeads,
      ...state.edgeLocalLeads,
      ...state.serverLeads,
    ];

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
        if (!cur.work_hours && item.work_hours) cur.work_hours = item.work_hours;
        if (!cur.telegram && item.telegram) cur.telegram = item.telegram;
        if (item.is_active === false) {
          cur.is_active = false;
          cur.status = item.status || "Закрыта / не работает";
        } else if (item.status && String(item.status).includes("ФНС")) {
          cur.status = item.status;
        }
        cur.has_phone = cur.phones.length > 0;
      }
    }

    state.mergedLeads = Array.from(map.values()).map((x) => {
      const tgInfo = computeTelegramFields(x);
      const stText = x.status && x.status !== "Действующее" ? x.status : "Действующая";
      const isClosed =
        x.is_active === false ||
        /ликвидир|закрыт|прекращ|не работает|не действует|банкрот/i.test(stText);
      return {
        ...x,
        status: stText,
        is_active: !isClosed,
        work_hours: x.work_hours || "",
        telegram: tgInfo.telegram,
        telegram_status: tgInfo.telegram_status,
        telegram_phone: tgInfo.telegram_phone,
        has_phone: Boolean(x.phones && x.phones.length > 0),
      };
    });
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
          showToast("Получены свежие данные от фонового парсера");
        }
      }

      if (leadsRes.ok) {
        const ld = await leadsRes.json();
        state.serverLeads = Array.isArray(ld.leads) ? ld.leads : Array.isArray(ld) ? ld : [];
      }
    } catch (err) {
      console.warn("Не удалось загрузить JSON:", err);
    }

    // Мгновенный первый рендер локальной и статической базы без ожидания всех страниц облачной БД
    if (!isSilentPoll && (state.serverLeads.length || state.edgeLocalLeads.length)) {
      mergeAllLeads();
      populateDynamicSelects();
      renderKPIsAndAnalytics();
      applyFiltersAndRender(false);
    }

    await fetchCloudSiteData(Boolean(isSilentPoll));
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
    const withTelegramHandle = all.filter((x) => Boolean(x.telegram)).length;
    const withTelegramAny = all.filter((x) => Boolean(x.telegram || x.telegram_phone)).length;
    const withWorkHours = all.filter((x) => Boolean(x.work_hours)).length;
    const activeOrgCount = all.filter((x) => x.is_active !== false).length;
    const closedOrgCount = total - activeOrgCount;
    const regs = new Set(all.map((x) => x.region_code).filter(Boolean)).size;
    const pct = total ? ((withPhone / total) * 100).toFixed(1) : "0.0";

    document.getElementById("nav-count-total").textContent = String(total);
    document.getElementById("kpi-total").textContent = String(total);
    document.getElementById("kpi-split").textContent =
      `ООО: ${oooCount} · ИП: ${ipCount} · Действующих: ${activeOrgCount}` +
      (closedOrgCount ? ` · Закрытых: ${closedOrgCount}` : "");
    document.getElementById("kpi-phones").textContent = String(withPhone);
    document.getElementById("kpi-phone-rate").textContent = `Покрытие номерами: ${pct}%`;
    document.getElementById("kpi-mobile").textContent = String(withTelegramAny);
    document.getElementById("kpi-email-site").textContent =
      `Прямой @ник: ${withTelegramHandle} · Моб. +79…: ${withMobile}`;
    document.getElementById("kpi-regions").textContent = `${regs} рег.`;

    const statsIso = (state.stats && state.stats.updated_at) || "";
    const bestIso =
      state.cloudHarvestIso && state.cloudHarvestIso > statsIso
        ? state.cloudHarvestIso
        : statsIso;

    if (bestIso) {
      const dt = new Date(bestIso);
      const timeStr = isNaN(dt.getTime())
        ? bestIso
        : dt.toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
      document.getElementById("last-updated-label").textContent = `Обновлено ${timeStr}`;
      document.getElementById("kpi-runs").textContent =
        `С часами работы: ${withWorkHours} · В облаке: ${state.siteDataLeads.length}`;
    } else {
      document.getElementById("last-updated-label").textContent = `База загружена (${total})`;
    }

    const edgeBox = document.getElementById("edge-harvest-status-box");
    if (edgeBox) {
      const nextCity =
        EDGE_CITY_FEEDS[state.harvestCursor.city_cursor % EDGE_CITY_FEEDS.length][2];
      const nextCat =
        EDGE_CATEGORY_FEEDS[state.harvestCursor.cat_cursor % EDGE_CATEGORY_FEEDS.length][2];
      edgeBox.textContent = [
        `Статус Edge-прокси Here.now : АКТИВЕН (/api/orgpage/* + /.herenow/data/leads)`,
        `Сохранено в облаке Site Data: ${state.siteDataLeads.length} карточек (всего в сводной витрине: ${total})`,
        `Следующий обход ротации     : ${nextCity} + «${nextCat}» (стр. ${state.harvestCursor.cat_page || 1})`,
        `Последний автосбор          : ${bestIso || "только что"}`,
      ].join("\n");
    }

    // Живые диаграммы аналитики по всей объединённой базе (сервер + облако Site Data)
    const regMap = {};
    const catMap = {};
    const srcMap = {};
    for (const item of all) {
      const rl = item.region_name
        ? `${item.region_code || ""} ${item.region_name}`.trim()
        : "Не указан";
      regMap[rl] = (regMap[rl] || 0) + 1;
      const cl = item.okved_category || "Прочие виды деятельности";
      catMap[cl] = (catMap[cl] || 0) + 1;
      (item.sources || ["Открытый каталог РФ"]).forEach((s) => {
        srcMap[s] = (srcMap[s] || 0) + 1;
      });
    }
    const toSortedBars = (m, lim) =>
      Object.entries(m)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, lim);

    renderBarChart("chart-regions", toSortedBars(regMap, 12));
    renderBarChart("chart-categories", toSortedBars(catMap, 10));
    renderBarChart("chart-sources", toSortedBars(srcMap, 8));

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
    const sumVal = Math.max(items.reduce((acc, x) => acc + (x.count || 0), 0), 1);
    el.innerHTML = items
      .map((item) => {
        const w = Math.max(2, Math.round(((item.count || 0) / maxVal) * 100));
        const sharePct = Math.round(((item.count || 0) / sumVal) * 100);
        return `
          <div class="bar-row">
            <div class="bar-row-top">
              <span>${esc(item.label)}</span>
              <strong>${esc(item.count)} <span style="color:var(--text-dim); font-size:11px; font-weight:400;">(${sharePct}%)</span></strong>
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
      if (f.orgStatus === "active" && l.is_active === false) return false;
      if (f.orgStatus === "closed" && l.is_active !== false) return false;

      if (f.contactMode === "phone" && !(l.phones && l.phones.length)) return false;
      if (f.contactMode === "telegram" && !l.telegram) return false;
      if (f.contactMode === "mobile" && !(l.telegram || l.telegram_phone)) return false;
      if (f.contactMode === "hours" && !l.work_hours) return false;
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
          l.status,
          l.work_hours,
          l.telegram,
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
      list.sort(
        (a, b) =>
          String(b.reg_date || "").localeCompare(String(a.reg_date || "")) ||
          String(b.created_at || "").localeCompare(String(a.created_at || ""))
      );
    } else if (f.sort === "phones_desc") {
      list.sort((a, b) => (b.phones || []).length - (a.phones || []).length);
    } else if (f.sort === "region_asc") {
      list.sort((a, b) => String(a.region_code || "99").localeCompare(String(b.region_code || "99")));
    } else {
      list.sort((a, b) => {
        const pa = a.phones && a.phones.length ? 1 : 0;
        const pb = b.phones && b.phones.length ? 1 : 0;
        if (pb !== pa) return pb - pa;
        const cmpDate = String(b.reg_date || "").localeCompare(String(a.reg_date || ""));
        if (cmpDate !== 0) return cmpDate;
        return String(b.created_at || "").localeCompare(String(a.created_at || ""));
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
            По выбранным фильтрам записей не найдено. Сбросьте фильтры или откройте вкладку «Живой API-поиск».
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
                      <button type="button" class="mini-action js-copy" data-copy="${esc(ph)}" title="Скопировать номер">Копия</button>
                      ${waBtn}
                    </div>
                  `;
                })
                .join("") +
              (l.phones.length > 2
                ? `<span style="font-size:11px; color:var(--text-dim);">+ ещё ${l.phones.length - 2} ном.</span>`
                : "") +
              `</div>`
            : `<span class="no-phone-tag">—</span>`;

        const extraContacts = [];
        if (l.telegram) {
          const cleanSlug = l.telegram.replace(/^@/, "");
          extraContacts.push(
            `<div onclick="event.stopPropagation()" style="display:flex; align-items:center; gap:4px; margin-bottom:2px;">
              <span class="tg-tag-verified" style="user-select:text;">TG ${esc(l.telegram)}</span>
              <button type="button" class="mini-action js-copy" data-copy="${esc(l.telegram)}" title="Скопировать ник Telegram">Копия</button>
              <a href="https://t.me/${esc(cleanSlug)}" target="_blank" rel="noopener" class="mini-action" title="Открыть профиль в Telegram">↗</a>
            </div>`
          );
        } else if (l.telegram_phone) {
          extraContacts.push(
            `<div onclick="event.stopPropagation()" style="display:flex; align-items:center; gap:4px; margin-bottom:2px;">
              <span class="tg-tag-phone" title="Мобильный номер владельца/ИП для поиска чата в Telegram">TG ${esc(l.telegram_phone)}</span>
              <a href="https://t.me/${esc(l.telegram_phone)}" target="_blank" rel="noopener" class="mini-action" title="Открыть чат в Telegram по номеру телефона">↗</a>
            </div>`
          );
        } else {
          extraContacts.push(
            `<span style="font-size:11px; color:var(--text-dim);">TG: —</span>`
          );
        }

        if (l.emails && l.emails[0]) {
          extraContacts.push(
            `<span onclick="event.stopPropagation()" style="font-family:var(--font-mono); font-size:11.5px; color:var(--text); user-select:text;">${esc(l.emails[0])}</span>`
          );
        }
        if (l.websites && l.websites[0]) {
          const shortHost = l.websites[0].replace(/^https?:\/\//, "");
          extraContacts.push(
            `<a href="${esc(l.websites[0])}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:11.5px;">${esc(shortHost)} ↗</a>`
          );
        }

        const statusBadgeHtml =
          l.is_active === false
            ? `<span class="status-pill-closed">● ${esc(l.status || "Закрыта / не работает")}</span>`
            : `<span class="status-pill-active">● ${esc(l.status || "Действующая")}</span>`;

        const codesHtml = [
          statusBadgeHtml,
          l.inn ? `<span class="code-chip" title="ИНН">ИНН ${esc(l.inn)}</span>` : "",
          l.ogrn ? `<span class="code-chip" title="ОГРН / ОГРНИП">ОГРН ${esc(l.ogrn)}</span>` : "",
        ]
          .filter(Boolean)
          .join(" ");

        const hoursHtml = l.work_hours
          ? `<div class="work-hours-line">${esc(l.work_hours)}</div>`
          : `<div style="font-size:11px; color:var(--text-dim); margin-top:4px;">График: —</div>`;

        return `
          <tr class="js-lead-row ${stageClass}" data-id="${esc(l.id)}">
            <td style="min-width: 240px;">
              <div class="lead-title">
                <span class="type-badge ${isIp ? "type-ip" : "type-ooo"}">${esc(l.entity_type)}</span>
                <span>${esc(l.name)}</span>
              </div>
              <div class="lead-codes">${codesHtml}</div>
            </td>
            <td style="white-space: nowrap; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums;">
              ${esc(formatDateRu(l.reg_date))}
            </td>
            <td style="max-width: 250px;">
              <div style="font-weight: 500; font-size: 12.5px;">${esc(l.region_code)} — ${esc(l.region_name)}</div>
              <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">${esc((l.address || "").slice(0, 85))}</div>
              ${hoursHtml}
            </td>
            <td style="max-width: 210px;">
              <div style="font-size: 12px; font-weight: 500;">
                ${l.okved_code ? `<span class="code-chip">${esc(l.okved_code)}</span> ` : ""}${esc(l.okved_category)}
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">${esc((l.okved_name || "").slice(0, 75))}</div>
            </td>
            <td style="max-width: 180px;">
              <div style="font-size: 12.5px; font-weight: 500;">${esc(l.person_name || "—")}</div>
              <div style="font-size: 11px; color: var(--text-dim);">${esc(l.person_role || "")}</div>
            </td>
            <td style="min-width: 215px;">
              ${phonesHtml}
              ${extraContacts.length ? `<div style="margin-top:6px; display:flex; flex-direction:column; gap:3px;">${extraContacts.join("")}</div>` : ""}
            </td>
            <td>
              ${(l.sources || []).map((s) => `<span class="source-pill">${esc(s)}</span>`).join("")}
            </td>
            <td onclick="event.stopPropagation()">
              <select class="crm-select js-crm-stage" data-id="${esc(l.id)}" aria-label="Статус CRM">
                <option value="new" ${crm.stage === "new" ? "selected" : ""}>Новый</option>
                <option value="work" ${crm.stage === "work" ? "selected" : ""}>В работе</option>
                <option value="callback" ${crm.stage === "callback" ? "selected" : ""}>Перезвон</option>
                <option value="won" ${crm.stage === "won" ? "selected" : ""}>Клиент</option>
                <option value="lost" ${crm.stage === "lost" ? "selected" : ""}>Отказ</option>
              </select>
              ${crm.note ? `<div style="font-size:11px; color:var(--warning); margin-top:4px; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(crm.note)}">${esc(crm.note)}</div>` : ""}
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
    const drawerStatusPill =
      lead.is_active === false
        ? `<span class="status-pill-closed">● ${esc(lead.status || "Закрыта / не работает")}</span>`
        : `<span class="status-pill-active">● ${esc(lead.status || "Действующая")}</span>`;

    document.getElementById("d-badges").innerHTML = `
      <span class="type-badge ${isIp ? "type-ip" : "type-ooo"}">${esc(lead.entity_type)}</span>
      ${drawerStatusPill}
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
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 12px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; margin-bottom:6px; flex-wrap:wrap;">
                  <a href="tel:+${dg}" class="phone-link" style="font-size:14.5px;">${esc(ph)}</a>
                  <div style="display:flex; gap:6px;">
                    <a href="tel:+${dg}" class="btn btn-sm btn-emerald">Позвонить</a>
                    ${isMobilePhone(ph) ? `<a href="https://wa.me/${dg}" target="_blank" rel="noopener" class="btn btn-sm">WhatsApp</a>` : ""}
                    <button type="button" class="btn btn-sm js-copy" data-copy="${esc(ph)}">Копировать</button>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div style="color:var(--text-muted); font-size:13px;">Публичный телефон не указан в карточке. Проверьте компанию во внешних справочниках ниже.</div>`;

    const checkQuery = encodeURIComponent(lead.inn || lead.ogrn || lead.name);
    const body = document.getElementById("drawer-body");
    body.innerHTML = `
      <div>
        <div style="font-size:12px; font-weight:600; color:var(--text-muted); margin-bottom:8px;">Телефоны и каналы связи</div>
        ${phonesBlock}
        ${
          lead.telegram
            ? `<div style="margin-top:8px;"><strong>Telegram:</strong> <span style="font-family:var(--font-mono); user-select:text; font-weight:600; color:var(--accent);">${esc(lead.telegram)}</span> <button type="button" class="mini-action js-copy" data-copy="${esc(lead.telegram)}">Копия</button> <a href="https://t.me/${esc(lead.telegram.replace(/^@/, ""))}" target="_blank" rel="noopener" class="btn btn-sm" style="margin-left:6px;">Открыть в Telegram ↗</a></div>`
            : lead.telegram_phone
            ? `<div style="margin-top:8px;"><strong>Telegram по номеру:</strong> <span style="font-family:var(--font-mono); user-select:text;">${esc(lead.telegram_phone)}</span> <a href="https://t.me/${esc(lead.telegram_phone)}" target="_blank" rel="noopener" class="btn btn-sm" style="margin-left:6px;">Проверить в Telegram ↗</a></div>`
            : `<div style="margin-top:8px; color:var(--text-muted);"><strong>Telegram:</strong> прямой аккаунт не найден</div>`
        }
        ${
          lead.emails && lead.emails.length
            ? `<div style="margin-top:8px;"><strong>Email:</strong> ${lead.emails
                .map((e) => `<span style="font-family:var(--font-mono); user-select:text;">${esc(e)}</span>`)
                .join(", ")}</div>`
            : ""
        }
        ${
          lead.websites && lead.websites.length
            ? `<div style="margin-top:6px;"><strong>Сайт:</strong> ${lead.websites
                .map((w) => `<a href="${esc(w)}" target="_blank" rel="noopener">${esc(w)} ↗</a>`)
                .join(", ")}</div>`
            : ""
        }
      </div>

      <div class="detail-grid">
        <div class="detail-box">
          <div class="lbl">Статус организации</div>
          <div class="val" id="drawer-status-val">${drawerStatusPill}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">Часы работы</div>
          <div class="val">${esc(lead.work_hours || "Не указаны")}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">ИНН</div>
          <div class="val" style="font-family:var(--font-mono);">${lead.inn ? `${esc(lead.inn)} <button class="mini-action js-copy" data-copy="${esc(lead.inn)}">Копия</button>` : "—"}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">ОГРН / ОГРНИП</div>
          <div class="val" style="font-family:var(--font-mono);">${lead.ogrn ? `${esc(lead.ogrn)} <button class="mini-action js-copy" data-copy="${esc(lead.ogrn)}">Копия</button>` : "—"}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">Дата регистрации</div>
          <div class="val" style="font-family:var(--font-mono);">${esc(formatDateRu(lead.reg_date))}</div>
        </div>
        <div class="detail-box">
          <div class="lbl">Регион РФ</div>
          <div class="val">${esc(lead.region_code)} — ${esc(lead.region_name)}</div>
        </div>
        <div class="detail-box" style="grid-column: span 2;">
          <div class="lbl">${esc(lead.person_role || "Руководитель / ИП")}</div>
          <div class="val">${esc(lead.person_name || "—")}</div>
        </div>
        <div class="detail-box" style="grid-column: span 2;">
          <div class="lbl">Юридический адрес / локация</div>
          <div class="val">${esc(lead.address || "—")}</div>
        </div>
        <div class="detail-box" style="grid-column: span 2;">
          <div class="lbl">Основной ОКВЭД и сфера деятельности</div>
          <div class="val">${lead.okved_code ? `<span class="code-chip">${esc(lead.okved_code)}</span> ` : ""}${esc(lead.okved_name || lead.okved_category)}</div>
        </div>
      </div>

      <div class="detail-box">
        <div class="lbl" style="margin-bottom:8px;">Проверка закрытия в ФНС и внешних реестрах</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${
            lead.inn
              ? `<button type="button" class="btn btn-sm btn-emerald" id="btn-live-fns-check" data-id="${esc(lead.id)}" data-inn="${esc(lead.inn)}">Проверить статус по ИНН (ФНС/Saby)</button>`
              : ""
          }
          <a class="btn btn-sm" href="https://sbis.ru/contragents/${encodeURIComponent(lead.inn || "")}" target="_blank" rel="noopener">Saby (СБИС) ↗</a>
          <a class="btn btn-sm" href="https://checko.ru/search?query=${checkQuery}" target="_blank" rel="noopener">Checko.ru ↗</a>
          <a class="btn btn-sm" href="https://www.rusprofile.ru/search?query=${checkQuery}" target="_blank" rel="noopener">Rusprofile ↗</a>
          <a class="btn btn-sm" href="https://2gis.ru/search/${encodeURIComponent(lead.name + " " + (lead.region_name || ""))}" target="_blank" rel="noopener">2ГИС ↗</a>
        </div>
      </div>

      <div class="detail-box">
        <div class="lbl" style="margin-bottom:8px; font-weight:600; color:var(--text);">CRM-статус и заметка менеджера</div>
        <div class="form-group">
          <label for="drawer-crm-stage">Этап работы с контрагентом</label>
          <select id="drawer-crm-stage" class="select-control">
            <option value="new" ${crm.stage === "new" ? "selected" : ""}>Новый (не звонили)</option>
            <option value="work" ${crm.stage === "work" ? "selected" : ""}>В работе</option>
            <option value="callback" ${crm.stage === "callback" ? "selected" : ""}>Перезвонить позже</option>
            <option value="won" ${crm.stage === "won" ? "selected" : ""}>Клиент / передан в отдел продаж</option>
            <option value="lost" ${crm.stage === "lost" ? "selected" : ""}>Отказ / неактуально</option>
          </select>
        </div>
        <div class="form-group">
          <label for="drawer-crm-note">Комментарий по звонку</label>
          <textarea id="drawer-crm-note" rows="3" class="input-control" placeholder="Например: ЛПР выходит в понедельник, отправить КП…">${esc(crm.note || "")}</textarea>
        </div>
        <button type="button" class="btn btn-primary" id="btn-save-drawer-crm" data-id="${esc(lead.id)}">
          Сохранить заметку
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
      "Статус_организации",
      "Часы_работы",
      "Telegram",
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
      const tgOut = l.telegram || (l.telegram_phone ? `По номеру ${l.telegram_phone}` : "");
      lines.push(
        [
          l.entity_type,
          l.name,
          l.status || (l.is_active === false ? "Закрыта" : "Действующая"),
          l.work_hours || "",
          tgOut,
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
      ["Наименование ИП / ООО", 230],
      ["Статус организации", 145],
      ["Часы работы", 175],
      ["Telegram", 150],
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
        const tgOut = l.telegram || (l.telegram_phone ? `По номеру ${l.telegram_phone}` : "");
        const vals = [
          l.entity_type,
          l.name,
          l.status || (l.is_active === false ? "Закрыта" : "Действующая"),
          l.work_hours || "",
          tgOut,
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
        "[!] Укажите бесплатный API-ключ DaData.ru (выдаётся сразу после подтверждения почты на dadata.ru/profile — 10 000 запросов в день бесплатно).";
      showToast("Введите API-ключ DaData");
      return;
    }

    const queries = rawQueries
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!queries.length) {
      logEl.textContent = "[!] Введите хотя бы одно ключевое слово или префикс ОГРН.";
      return;
    }

    const minTimestamp = Date.now() - maxDays * 86400 * 1000;
    const partyTypes = entityMode === "BOTH" ? ["INDIVIDUAL", "LEGAL"] : [entityMode];
    const discovered = [];

    logEl.textContent = `[RUN] Запуск живого поиска (${queries.length} запросов, возраст <= ${maxDays} дн.)…\n`;

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
            logEl.textContent += `[ERR] Ошибка DaData HTTP ${res.status} на запросе "${q}"\n`;
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
          logEl.textContent += `[OK] Запрос "${q}" (${ptype === "INDIVIDUAL" ? "ИП" : "ООО"}): найдено свежих новорегов — ${matchedHere}\n`;
        } catch (err) {
          logEl.textContent += `[ERR] Сбой сети на "${q}": ${err.message}\n`;
        }
      }
    }

    // Опциональное дообогащение телефонов через 2ГИС API прямо в браузере
    if (twogisKey && discovered.length) {
      logEl.textContent += `[2GIS] Дообогащение телефонов через 2ГИС API…\n`;
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
      logEl.textContent += `[2GIS] Дообогащено номерами из 2ГИС: +${enriched}\n`;
    }

    state.liveLeads = [...discovered, ...state.liveLeads].slice(0, 1000);
    try {
      localStorage.setItem(LS_LIVE_LEADS_KEY, JSON.stringify(state.liveLeads));
    } catch (_) {}

    mergeAllLeads();
    populateDynamicSelects();
    renderKPIsAndAnalytics();
    applyFiltersAndRender(true);

    logEl.textContent += `\n[DONE] Добавлено в таблицу: ${discovered.length} свежих записей. Перейдите во вкладку «Реестр» для фильтрации и выгрузки в Excel.`;
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

    const edgeBtn = document.getElementById("btn-edge-harvest");
    if (edgeBtn) {
      edgeBtn.addEventListener("click", () => {
        runEdgeAutoHarvest(true, false);
      });
    }

    const turboBtn = document.getElementById("btn-turbo-harvest");
    if (turboBtn) {
      turboBtn.addEventListener("click", () => {
        toggleTurboHarvest();
      });
    }

    document.getElementById("btn-refresh").addEventListener("click", async () => {
      showToast("Синхронизация с облаком…");
      await loadServerData(false);
      runEdgeAutoHarvest(true);
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
    const orgStSel = document.getElementById("f-org-status");
    if (orgStSel) {
      orgStSel.addEventListener("change", (e) => {
        state.filters.orgStatus = e.target.value;
        applyFiltersAndRender(true);
      });
    }
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
        orgStatus: "",
        crm: "",
        sort: "smart",
      };
      document.getElementById("f-search").value = "";
      document.getElementById("f-region").value = "";
      document.getElementById("f-category").value = "";
      const orgStEl = document.getElementById("f-org-status");
      if (orgStEl) orgStEl.value = "";
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

      const liveFnsBtn = e.target.closest("#btn-live-fns-check");
      if (liveFnsBtn) {
        const lid = liveFnsBtn.dataset.id;
        const inn = liveFnsBtn.dataset.inn;
        liveFnsBtn.disabled = true;
        liveFnsBtn.textContent = "Проверка в ФНС/Saby…";
        checkSabyFnsOnline(inn).then((res) => {
          liveFnsBtn.disabled = false;
          liveFnsBtn.textContent = "Проверить статус по ИНН (ФНС/Saby)";
          if (!res) {
            showToast("Не удалось получить ответ прокси Saby");
            return;
          }
          const target = state.mergedLeads.find((x) => x.id === lid);
          if (target) {
            target.is_active = res.isActive;
            target.status = res.status;
            if (res.personName && !target.person_name) target.person_name = res.personName;
            if (res.ogrn && !target.ogrn) target.ogrn = res.ogrn;
            openLeadDrawer(lid);
            renderKPIsAndAnalytics();
            applyFiltersAndRender(false);
          }
          showToast(`ФНС/Saby: ${res.status}`);
        });
        return;
      }

      const saveDrawerBtn = e.target.closest("#btn-save-drawer-crm");
      if (saveDrawerBtn) {
        const lid = saveDrawerBtn.dataset.id;
        const stg = document.getElementById("drawer-crm-stage").value;
        const note = document.getElementById("drawer-crm-note").value;
        saveCrm(lid, stg, note);
        showToast("Статус и заметка сохранены");
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
      showToast("Ключи сохранены в вашем браузере");
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
  loadServerData(false).then(() => {
    const todayIso = getTodayIsoDate();
    const lastIso = state.harvestCursor.last_harvest_iso || state.lastUpdatedIso || "";
    const lastMs = lastIso ? Date.parse(lastIso) : 0;
    const isStaleDay = !lastIso.startsWith(todayIso);
    const isOlderThan2m = !lastMs || Date.now() - lastMs > 2 * 60 * 1000;
    if (isStaleDay || isOlderThan2m) {
      setTimeout(() => runEdgeAutoHarvest(false, false), 450);
    }
  });

  // Ускоренный авто-пуллинг свежих данных из облака Site Data каждые 30 секунд
  setInterval(() => {
    loadServerData(true);
  }, 30000);

  // Ускоренный автономный фоновый сбор свежих ИП/ООО через Edge-прокси каждые 35 секунд
  setInterval(() => {
    if (!state.turboActive) {
      runEdgeAutoHarvest(false, false);
    }
  }, 35000);
})();
