(() => {
  'use strict';
  if (document.getElementById('tt-panel')) return;

  const ORIGIN = location.origin;
  const MODS = { assign: 'Tarea', quiz: 'Cuestionario', forum: 'Foro' };
  const EVENT_TYPES = ['due', 'close']; // vencimiento (tareas/foros) y cierre (cuestionarios)
  const MONTHS_BACK = 3;
  const MONTHS_AHEAD = 2;
  const FALSE_TTL = 10 * 60 * 1000; // no re-consultar "no entregada" antes de 10 min
  const STORE = 'tt_v1';

  const TABS = [
    { id: 'proximas', label: 'Próximas' },
    { id: 'atrasadas', label: 'Atrasadas' },
    { id: 'entregadas', label: 'Entregadas' },
    { id: 'pendientes', label: 'Pendientes' },
  ];

  const state = {
    items: [],
    tab: 'proximas',
    course: 'all',
    loading: true,
    progress: '',
    error: '',
    store: { auto: {}, manual: {} },
  };

  /* ---------- utilidades ---------- */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const loadStore = async () => {
    try {
      const r = await chrome.storage.local.get(STORE);
      if (r[STORE]) state.store = { auto: {}, manual: {}, ...r[STORE] };
    } catch (_) {}
  };
  const saveStore = () => {
    try { chrome.storage.local.set({ [STORE]: state.store }); } catch (_) {}
  };

  function getPageInfo() {
    let sesskey = document.querySelector('input[name="sesskey"]')?.value;

    if (!sesskey) {
      const logoutLink = document.querySelector('a[href*="logout.php?sesskey="], a[href*="sesskey="]');
      if (logoutLink) {
        try {
          sesskey = new URL(logoutLink.href, ORIGIN).searchParams.get('sesskey');
        } catch (_) {}
      }
    }

    let userId = null;
    for (const script of document.scripts) {
      const text = script.textContent;
      if (!sesskey) {
        const sm = text.match(/"sesskey":"([A-Za-z0-9]+)"/);
        if (sm) sesskey = sm[1];
      }
      if (!userId) {
        const um = text.match(/"userId":(\d+)/);
        if (um) userId = um[1];
      }
      if (sesskey && userId) break;
    }

    return { sesskey: sesskey || '', userId };
  }
  const { sesskey, userId } = getPageInfo();

  async function ajax(methodname, args) {
    const r = await fetch(
      `${ORIGIN}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${encodeURIComponent(methodname)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ index: 0, methodname, args }]),
      }
    );
    const j = await r.json();
    if (j[0] && j[0].error) throw new Error((j[0].exception && j[0].exception.message) || 'Error en la API de Moodle');
    return j[0].data;
  }

  async function pool(list, n, fn) {
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, list.length) }, async () => {
        while (i < list.length) {
          const item = list[i++];
          await fn(item);
          await new Promise((r) => setTimeout(r, 150));
        }
      })
    );
  }

  /* ---------- obtención de eventos ---------- */

  async function fetchMonth(year, month) {
    const d = await ajax('core_calendar_get_calendar_monthly_view', {
      year, month, courseid: 1, categoryid: 0, includenavigation: false, mini: false, day: 1,
    });
    return d.weeks.flatMap((w) => w.days.flatMap((day) => day.events || []));
  }

  function toItem(ev) {
    if (!MODS[ev.modulename] || !EVENT_TYPES.includes(ev.eventtype)) return null;
    let cmid = null;
    try { cmid = new URL(ev.url, ORIGIN).searchParams.get('id'); } catch (_) {}
    if (!cmid) return null;
    const course = ev.course || {};
    return {
      id: String(ev.id),
      name: ev.name,
      mod: ev.modulename,
      cmid,
      url: `${ORIGIN}/mod/${ev.modulename}/view.php?id=${cmid}`,
      due: ev.timesort || ev.timestart,
      courseId: course.id || 0,
      course: course.fullnamedisplay || course.fullname || 'Sin curso',
    };
  }

  /* ---------- ¿ya la entregué? ---------- */

  async function checkDone(item) {
    const res = await fetch(item.url, { credentials: 'same-origin' });
    const html = await res.text();

    if (item.mod === 'assign') {
      return html.includes('submissionstatussubmitted') || /Enviado para calificar|Submitted for grading/i.test(html);
    }
    if (item.mod === 'quiz') {
      const match = html.match(/<table[^>]*quizattemptsummary[\s\S]*?<\/table>/i);
      return Boolean(match && /Finalizado|Finished/i.test(match[0]));
    }
    if (item.mod === 'forum') {
      if (!userId) return false;
      return new RegExp(`user/view\\.php\\?id=${userId}(?!\\d)`).test(html);
    }
    return false;
  }

  async function resolveStatus(items) {
    const now = Date.now();
    const todo = items.filter((it) => {
      const c = state.store.auto[it.id];
      if (c && c.done) return false; // entregada = permanente
      if (c && now - c.t < FALSE_TTL) return false;
      return true;
    });
    let n = 0;
    await pool(todo, 3, async (it) => {
      try {
        state.store.auto[it.id] = { done: await checkDone(it), t: Date.now() };
      } catch (_) {}
      state.progress = `Revisando estado de entrega… ${++n}/${todo.length}`;
      if (n % 5 === 0) render();
    });
    saveStore();
  }

  async function load() {
    state.loading = true;
    state.error = '';
    state.progress = 'Cargando calendario…';
    render();
    try {
      if (!sesskey) throw new Error('No se pudo leer la sesión de Moodle. Recarga la página.');
      const now = new Date();
      const months = [];
      for (let o = -MONTHS_BACK; o <= MONTHS_AHEAD; o++) {
        const d = new Date(now.getFullYear(), now.getMonth() + o, 1);
        months.push([d.getFullYear(), d.getMonth() + 1]);
      }
      const events = (await Promise.all(months.map(([y, m]) => fetchMonth(y, m)))).flat();
      const map = new Map();
      events.forEach((ev) => {
        const it = toItem(ev);
        if (it && !map.has(it.id)) map.set(it.id, it);
      });
      state.items = [...map.values()];
      render();
      await resolveStatus(state.items);
    } catch (e) {
      state.error = e.message || String(e);
    }
    state.loading = false;
    state.progress = '';
    render();
  }

  /* ---------- clasificación ---------- */

  const isDone = (it) => {
    const m = state.store.manual[it.id];
    if (m !== undefined) return m;
    return !!(state.store.auto[it.id] && state.store.auto[it.id].done);
  };

  const bucket = (it) => {
    if (isDone(it)) return 'entregadas';
    return it.due * 1000 < Date.now() ? 'atrasadas' : 'proximas';
  };

  function visible() {
    return state.items
      .filter((it) => state.course === 'all' || String(it.courseId) === state.course)
      .map((it) => ({ it, b: bucket(it) }));
  }

  function listFor(tab, rows) {
    const out = rows.filter(({ it, b }) => (tab === 'pendientes' ? b !== 'entregadas' : b === tab)).map((r) => r.it);
    const asc = tab === 'proximas' || tab === 'pendientes';
    return out.sort((a, b) => (asc ? a.due - b.due : b.due - a.due));
  }

  /* ---------- presentación ---------- */

  function rel(ts) {
    const diff = ts * 1000 - Date.now();
    const m = Math.floor(Math.abs(diff) / 60000);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    const t = d >= 1 ? `${d} d ${h % 24} h` : h >= 1 ? `${h} h ${m % 60} min` : `${m} min`;
    return diff < 0 ? `venció hace ${t}` : `vence en ${t}`;
  }

  const fmtDate = (ts) =>
    new Date(ts * 1000).toLocaleString('es-EC', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });

  function itemHtml(it) {
    const done = isDone(it);
    const late = !done && it.due * 1000 < Date.now();
    const soon = !done && !late && it.due * 1000 - Date.now() < 24 * 3600 * 1000;
    const cls = done ? 'tt-done' : late ? 'tt-late' : soon ? 'tt-soon' : '';
    return `
      <li class="tt-item ${cls}">
        <span class="tt-badge tt-${it.mod}">${MODS[it.mod]}</span>
        <div class="tt-main">
          <a href="${esc(it.url)}">${esc(it.name)}</a>
          <div class="tt-course">${esc(it.course)}</div>
        </div>
        <div class="tt-when">
          <div>${esc(fmtDate(it.due))}</div>
          ${done ? '<div class="tt-rel">Entregada</div>' : `<div class="tt-rel">${esc(rel(it.due))}</div>`}
        </div>
        <button class="tt-toggle" data-toggle="${esc(it.id)}"
          title="${done ? 'Marcar como no entregada' : 'Marcar como entregada'}"
          aria-label="${done ? 'Marcar como no entregada' : 'Marcar como entregada'}">${done ? '↺' : '✓'}</button>
      </li>`;
  }

  function render() {
    const panel = document.getElementById('tt-panel');
    if (!panel) return;

    const rows = visible();
    const counts = { proximas: 0, atrasadas: 0, entregadas: 0, pendientes: 0 };
    for (const { b } of rows) {
      if (b === 'proximas') {
        counts.proximas++;
        counts.pendientes++;
      } else if (b === 'atrasadas') {
        counts.atrasadas++;
        counts.pendientes++;
      } else if (b === 'entregadas') {
        counts.entregadas++;
      }
    }
    const list = listFor(state.tab, rows);

    const refreshBtn = panel.querySelector('[data-refresh]');
    if (refreshBtn) refreshBtn.disabled = state.loading;

    const select = panel.querySelector('select[data-course]');
    if (select) {
      const courses = [...new Map(state.items.map((i) => [String(i.courseId), i.course])).entries()];
      const currentSignature = select.dataset.signature || '';
      const nextSignature = courses.map(([id]) => id).join(',');
      if (currentSignature !== nextSignature) {
        select.dataset.signature = nextSignature;
        select.innerHTML = `<option value="all">Todos los cursos</option>${courses
          .map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`)
          .join('')}`;
      }
      if (select.value !== state.course) select.value = state.course;
    }

    const tabButtons = panel.querySelectorAll('.tt-tabs [data-tab]');
    for (const btn of tabButtons) {
      const tid = btn.dataset.tab;
      btn.classList.toggle('active', state.tab === tid);
      const countEl = btn.querySelector('.tt-count');
      if (countEl) countEl.textContent = counts[tid] ?? 0;
    }

    const statusEl = panel.querySelector('.tt-status');
    if (statusEl) {
      if (state.progress) {
        statusEl.innerHTML = `<div class="tt-note">${esc(state.progress)}</div>`;
      } else if (state.error) {
        statusEl.innerHTML = `<div class="tt-note tt-error">${esc(state.error)}</div>`;
      } else {
        statusEl.textContent = '';
      }
    }

    const contentEl = panel.querySelector('.tt-content');
    if (contentEl) {
      if (list.length) {
        const existingList = contentEl.querySelector('.tt-list');
        const itemsHtml = list.map(itemHtml).join('');
        if (existingList) {
          existingList.innerHTML = itemsHtml;
        } else {
          contentEl.innerHTML = `<ul class="tt-list">${itemsHtml}</ul>`;
        }
      } else {
        contentEl.innerHTML = `<div class="tt-empty">${state.loading ? 'Cargando…' : 'Nada por aquí.'}</div>`;
      }
    }
  }

  function mount() {
    const panel = document.createElement('section');
    panel.id = 'tt-panel';
    panel.className = 'tt-panel';
    panel.innerHTML = `
      <div class="tt-head">
        <h3>Mis actividades</h3>
        <div class="tt-tools">
          <select data-course aria-label="Filtrar por curso">
            <option value="all">Todos los cursos</option>
          </select>
          <button data-refresh>Actualizar</button>
        </div>
      </div>
      <div class="tt-tabs" role="tablist">
        ${TABS.map((t) => `
          <button role="tab" class="${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
            ${t.label} <span class="tt-count tt-count-${t.id}">0</span>
          </button>`).join('')}
      </div>
      <div class="tt-status"></div>
      <div class="tt-content"></div>
      <div class="tt-foot">Los foros se detectan como entregados si participaste en ellos; usa ✓ para corregir manualmente.</div>
    `;

    panel.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { state.tab = tab.dataset.tab; render(); return; }
      if (e.target.closest('[data-refresh]')) {
        state.store.auto = {};
        saveStore();
        load();
        return;
      }
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        const it = state.items.find((i) => i.id === tg.dataset.toggle);
        if (it) {
          state.store.manual[it.id] = !isDone(it);
          saveStore();
          render();
        }
      }
    });
    panel.addEventListener('change', (e) => {
      if (e.target.matches('[data-course]')) { state.course = e.target.value; render(); }
    });

    const ref = document.querySelector('[data-block="calendar_upcoming"], .block_calendar_upcoming');
    if (ref && ref.parentNode) ref.parentNode.insertBefore(panel, ref);
    else (document.querySelector('#region-main') || document.querySelector('main') || document.body).prepend(panel);
  }

  (async () => {
    await loadStore();
    mount();
    await load();
    setInterval(() => { if (!state.loading) render(); }, 60000);
  })();
})();
