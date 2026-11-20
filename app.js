// Учёт ремонта шин — телефон (версия 1.0, 20.11.2026). Этап 1: клиентские шины.
// Всё хранится в телефоне; действия копятся в очереди и уходят на сервер сами, когда есть интернет.
(function () {
  'use strict';
  const S = L.S;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const clone = o => JSON.parse(JSON.stringify(o));
  const rub = n => L.num(n).toLocaleString('ru-RU') + ' ₽';
  const hm = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dt = t => t ? new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  function age(t) {
    if (!t) return '';
    const h = (Date.now() - t) / 3600000;
    if (h < 1) return 'меньше часа';
    if (h < 24) return Math.floor(h) + ' ч';
    return Math.floor(h / 24) + ' дн';
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.k); toast.k = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- личная ссылка (адрес сервера и код) ----------
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem('remont-cfg') || '{}'); } catch (e) {}
  let relinked = false;
  (function () {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('api') && h.get('t')) {
      relinked = !!cfg.t && cfg.t !== h.get('t');
      cfg = { api: h.get('api'), t: h.get('t') };
      try { localStorage.setItem('remont-cfg', JSON.stringify(cfg)); } catch (e) {}
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();

  async function api(action, data) {
    if (!cfg.api || !cfg.t) throw new Error('откройте свою личную ссылку');
    let r;
    try {
      r = await fetch(cfg.api, { method: 'POST', body: JSON.stringify(Object.assign({ action: action, t: cfg.t }, data || {})) });
    } catch (e) { throw new Error('нет интернета'); }
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('сервер ответил непонятно (код ' + r.status + ')'); }
    if (!j.ok) { const er = new Error(j.error); er.server = true; throw er; }
    return j.data;
  }

  // ---------- хранилище в телефоне (IndexedDB) ----------
  const dbp = new Promise((res, rej) => {
    const q = indexedDB.open('remont', 1);
    q.onupgradeneeded = () => { const d = q.result; d.createObjectStore('kv'); d.createObjectStore('photos', { keyPath: 'pid' }); };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  function tx(store, mode, fn) {
    return dbp.then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    }));
  }
  const kvGet = k => tx('kv', 'readonly', s => s.get(k));
  const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
  const photoAll = () => tx('photos', 'readonly', s => s.getAll());
  const photoPut = o => tx('photos', 'readwrite', s => s.put(o));
  const photoDel = k => tx('photos', 'readwrite', s => s.delete(k));

  // ---------- состояние ----------
  let snap = null;      // последнее, что прислал сервер
  let queue = [];       // действия, которые ещё не дошли до сервера
  let rejects = [];     // что сервер не принял (показать человеку)
  let pend = [];        // фото, которые ещё не отправлены
  let st = null;        // snap + действия из очереди = то, что видит человек
  let lastSync = 0, busy = false, netErr = '', srvErr = '';

  function rebuild() {
    st = snap ? clone(snap) : null;
    if (st) queue.forEach(a => { try { L.apply(st, a); } catch (e) {} });
  }
  function me() { return st && st.people[snap.me]; }
  async function saveAll() {
    await kvSet('snap', snap); await kvSet('queue', queue); await kvSet('rejects', rejects); await kvSet('lastSync', lastSync);
  }

  function act(type, uid, p) {
    const a = { aid: uuid(), t: Date.now(), by: snap.me, type: type, uid: uid || '', p: p || {} };
    let err;
    try { err = L.apply(st, a); } catch (e) { err = e.message; }
    if (err) { alert('Не получилось: ' + err); return false; }
    queue.push(a);
    kvSet('queue', queue);
    return true;
  }

  // ---------- отправка на сервер ----------
  async function sync() {
    if (busy || !cfg.t) return;
    busy = true; bar();
    try {
      const sent = queue.slice();
      const d = await api('sync', { actions: sent });
      const ids = new Set(sent.map(a => a.aid));
      sent.forEach(a => {
        const e = d.results && d.results[a.aid];
        if (e) {
          const c = (d.cards && d.cards[a.uid]) || (st && st.cards[a.uid]) || {};
          rejects.push({ t: a.t, what: L.NAMES[a.type] || a.type, num: c.num || '', size: c.size || '', err: e });
        }
      });
      queue = queue.filter(a => !ids.has(a.aid));
      delete d.results;
      snap = d; lastSync = Date.now(); netErr = ''; srvErr = '';
      await saveAll();
      rebuild();
      busy = false;
      refresh();
      await uploadPhotos();
    } catch (e) {
      if (e.server) srvErr = e.message; else netErr = e.message;
    } finally {
      busy = false; bar();
    }
  }
  async function uploadPhotos() {
    let done = 0;
    for (const p of pend.slice().sort((a, b) => a.t - b.t)) {
      const c = snap && snap.cards[p.uid];
      if (!c || !c.num) continue;  // шина ещё не дошла до сервера
      busy = true; bar();
      try {
        const r = await api('photo', { uid: p.uid, kind: p.kind, pid: p.pid, b64: p.data.split(',')[1] });
        c.photos = c.photos || [];
        if (!c.photos.some(x => x.pid === r.pid)) c.photos.push(r);
        await photoDel(p.pid);
        pend = pend.filter(x => x.pid !== p.pid);
        done++;
      } catch (e) {
        if (e.server) srvErr = e.message; else netErr = e.message;
        break;
      } finally { busy = false; }
    }
    if (done) { await kvSet('snap', snap); rebuild(); refresh(); }
  }

  // ---------- верхняя строка ----------
  function bar() {
    const n = queue.length, ph = pend.length;
    let t, cls = 'ok';
    if (busy) { t = 'Отправка…'; cls = 'wait'; }
    else if (srvErr) { t = '⚠ ' + srvErr; cls = 'err'; }
    else if (n || ph) {
      t = (netErr ? 'Нет сети · ' : '') + [n ? n + ' действ. ждут отправки' : '', ph ? ph + ' фото ждут отправки' : ''].filter(Boolean).join(', ');
      cls = netErr ? 'off' : 'wait';
    } else if (netErr) { t = 'Нет сети · всё сохранено в телефоне' + (lastSync ? ' · обновлено ' + hm(lastSync) : ''); cls = 'off'; }
    else t = 'Всё отправлено' + (lastSync ? ' · ' + hm(lastSync) : '');
    $('bar').textContent = t;
    $('bar').className = 'bar ' + cls;
    $('notice').hidden = !rejects.length;
    $('notice').textContent = rejects.length ? '⚠ Не принято действий: ' + rejects.length + ' — нажмите, чтобы посмотреть' : '';
  }

  // ---------- переходы между экранами ----------
  let stack = [{ v: 'home' }];
  let tab = '';
  try { tab = localStorage.getItem('remont-tab') || ''; } catch (e) {}
  function go(v, prm) {
    stack.push(Object.assign({ v: v }, prm || {}));
    history.pushState({ d: stack.length }, '');
    render(); window.scrollTo(0, 0);
  }
  function openForm(title, build) {
    stack.push({ v: 'form' });
    history.pushState({ d: stack.length }, '');
    const m = $('main');
    m.innerHTML = '<div class="top"><button class="back" data-back>‹ Назад</button><h2>' + esc(title) + '</h2></div><div id="fbody"></div>';
    window.scrollTo(0, 0);
    build($('fbody'));
  }
  function back() { history.back(); }
  window.addEventListener('popstate', () => { if (stack.length > 1) stack.pop(); render(); });
  function refresh() { const top = stack[stack.length - 1]; if (top.v !== 'form') render(); else bar(); }

  function render() {
    bar();
    const m = $('main');
    const top = stack[stack.length - 1];
    if (top.v === 'form') return;
    if (!cfg.t) {
      m.innerHTML = '<div class="empty"><h2>Учёт ремонта шин</h2><p>Откройте на этом телефоне <b>свою личную ссылку</b> — её даёт администратор.</p></div>';
      return;
    }
    if (!st) {
      m.innerHTML = '<div class="empty"><p>Первая загрузка — нужен интернет один раз.</p>' +
        (srvErr ? '<p class="bad">' + esc(srvErr) + '</p>' : netErr ? '<p class="bad">Сейчас: ' + esc(netErr) + '</p>' : '') +
        '<button class="btn" data-sync>Повторить</button></div>';
      return;
    }
    if (!me()) { m.innerHTML = '<div class="empty"><p class="bad">Вас нет в списке людей. Обратитесь к администратору.</p></div>'; return; }
    if (top.v === 'card') return cardView(m, top.uid);
    home(m);
  }

  // ---------- главный экран ----------
  function tabsFor(p) {
    const t = [];
    if (L.has(p, 'Мастер')) t.push(['ceh', 'Цех']);
    if (L.has(p, 'Менеджер')) { t.push(['dela', 'Мои дела']); t.push(['my', 'Мои шины']); }
    if (L.has(p, 'Руководитель')) t.push(['all', 'Все шины']);
    if (L.has(p, 'Администратор')) t.push(['people', 'Люди']);
    if (!t.length) t.push(['none', 'Дела']);
    return t;
  }
  const canAccept = p => L.anyRole(p, ['Мастер', 'Менеджер', 'Руководитель']);
  const cards = () => Object.keys(st.cards).map(k => st.cards[k]);
  const sortQ = (a, b) => (Number(!!b.wait) - Number(!!a.wait)) || ((a.since || 0) - (b.since || 0));
  const STATUSES = Object.keys(S).map(k => S[k]);
  const stCls = s => 'st st' + STATUSES.indexOf(s);

  function rowHtml(c) {
    const cl = st.clients[c.client] || {};
    const pn = queue.filter(a => a.uid === c.uid).length + pend.filter(x => x.uid === c.uid).length;
    return '<div class="row" data-uid="' + esc(c.uid) + '">' +
      '<div class="r1"><b>' + esc(c.num || 'новая') + '</b> ' + esc(c.size) + ' <span class="cl">' + esc(cl.name || '') + '</span></div>' +
      '<div class="r2"><span class="' + stCls(c.status) + '">' + esc(c.status) + '</span> · ' + age(c.since) +
      (c.wait && !L.isFinal(c) ? ' · <span class="warn">🚗 машина ждёт</span>' : '') +
      (c.again && c.status === S.AGREE ? ' · <span class="warn">повторно</span>' : '') +
      (pn ? ' · <span class="pend">⏳ не отправлено</span>' : '') + '</div></div>';
  }
  function section(title, list, hint) {
    if (!list.length) return '';
    return '<h3>' + esc(title) + ' <span class="cnt">' + list.length + '</span></h3>' + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') +
      list.map(rowHtml).join('');
  }

  function home(m) {
    const p = me();
    const tabs = tabsFor(p);
    if (!tabs.some(t => t[0] === tab)) tab = tabs[0][0];
    let h = '<div class="who">' + esc(p.name) + ' <small>' + esc(p.roles.join(', ')) + '</small></div>';
    if (tabs.length > 1) h += '<div class="tabs">' + tabs.map(t => '<button data-tab="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</div>';
    if (canAccept(p) && tab !== 'people') h += '<button class="btn big" data-accept>＋ Приёмка шины</button>';
    const all = cards();
    let body = '';
    if (tab === 'ceh') {
      const q = s => all.filter(c => c.status === s).sort(sortQ);
      body = section('Осмотреть', q(S.NEW)) + section('Начать ремонт', q(S.QUEUE)) + section('В ремонте', q(S.REPAIR)) +
        section('Проверить', q(S.CHECK)) + section('Выдать клиенту', q(S.ISSUE), 'Оплачено или без оплаты');
      const wait = all.filter(c => [S.AGREE, S.UTIL, S.PAY].indexOf(c.status) >= 0).sort(sortQ);
      if (wait.length) body += '<details class="more"><summary>Ждут менеджера (' + wait.length + ')</summary>' + wait.map(rowHtml).join('') + '</details>';
      if (!body) body = '<div class="empty">Дел нет. Новые шины появятся здесь.</div>';
    } else if (tab === 'dela') {
      const mine = all.filter(c => c.mgr === p.id);
      const q = s => mine.filter(c => c.status === s).sort(sortQ);
      const nomgr = all.filter(c => !c.mgr && !L.isFinal(c)).sort(sortQ);
      body = section('Согласовать с клиентом', q(S.AGREE), 'Позвоните клиенту: цена ремонта') +
        section('Утиль — сообщить клиенту', q(S.UTIL), 'Забирает или оставляет (платит за утиль)') +
        section('Готова — сообщить клиенту и отметить оплату', q(S.PAY)) +
        section('Без менеджера', nomgr, 'У клиента не выбран менеджер — руководитель может передать');
      if (!body) body = '<div class="empty">Дел нет 👍</div>';
    } else if (tab === 'my') {
      const mine = all.filter(c => c.mgr === p.id);
      const open = mine.filter(c => !L.isFinal(c)).sort((a, b) => (a.since || 0) - (b.since || 0));
      const closed = mine.filter(c => L.isFinal(c)).sort((a, b) => b.since - a.since);
      body = section('В работе', open) + (closed.length ? '<details class="more"><summary>Закрытые за 30 дней (' + closed.length + ')</summary>' + closed.map(rowHtml).join('') + '</details>' : '');
      if (!body) body = '<div class="empty">Ваших шин пока нет.</div>';
    } else if (tab === 'all') {
      body = allView(all);
    } else if (tab === 'people') {
      body = '<div id="people"><div class="muted">Загрузка… (нужен интернет)</div></div>';
    } else {
      body = '<div class="empty">Для ваших ролей (' + esc(p.roles.join(', ')) + ') дела появятся на следующих этапах.</div>';
    }
    m.innerHTML = h + body;
    if (tab === 'people') peopleView();
    if (tab === 'all') bindAllFilters();
  }

  // ---------- руководитель: все шины ----------
  let flt = { st: '', mgr: '', q: '', closed: false };
  function allView(all) {
    const mgrs = Object.keys(st.people).map(k => st.people[k]).filter(x => L.has(x, 'Менеджер'));
    let list = all.filter(c => flt.closed ? true : !L.isFinal(c));
    if (flt.st) list = list.filter(c => c.status === flt.st);
    if (flt.mgr) list = list.filter(c => (c.mgr || '-') === flt.mgr);
    if (flt.q) {
      const q = flt.q.toLowerCase();
      list = list.filter(c => ((c.num || '') + ' ' + c.size + ' ' + c.tire + ' ' + ((st.clients[c.client] || {}).name || '')).toLowerCase().indexOf(q) >= 0);
    }
    list.sort((a, b) => (a.since || 0) - (b.since || 0));
    return '<div class="flt">' +
      '<input id="fq" placeholder="Поиск: Р-номер, размер, клиент" value="' + esc(flt.q) + '">' +
      '<select id="fst"><option value="">Все статусы</option>' + STATUSES.map(s => '<option' + (flt.st === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>' +
      '<select id="fmgr"><option value="">Все менеджеры</option><option value="-"' + (flt.mgr === '-' ? ' selected' : '') + '>Без менеджера</option>' +
      mgrs.map(x => '<option value="' + esc(x.id) + '"' + (flt.mgr === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>' +
      '<label class="chk"><input type="checkbox" id="fcl"' + (flt.closed ? ' checked' : '') + '> показать закрытые</label></div>' +
      '<div class="hint">Сверху — те, что дольше всех на своём этапе. Найдено: ' + list.length + '</div>' +
      (list.length ? list.map(rowHtml).join('') : '<div class="empty">Ничего не найдено</div>');
  }
  function bindAllFilters() {
    const upd = () => { flt = { q: $('fq').value.trim(), st: $('fst').value, mgr: $('fmgr').value, closed: $('fcl').checked }; render(); };
    $('fst').onchange = upd; $('fmgr').onchange = upd; $('fcl').onchange = upd;
    $('fq').onchange = upd;
  }

  // ---------- администратор: люди и ссылки ----------
  async function peopleView() {
    const box = $('people');
    let list;
    try { list = await api('adminList'); } catch (e) { box.innerHTML = '<div class="bad">Не загрузилось: ' + esc(e.message) + '. Экран «Люди» работает только при интернете.</div>'; return; }
    drawPeople(list);
  }
  function drawPeople(list) {
    const box = $('people');
    if (!box) return;
    box.innerHTML = '<button class="btn" data-padd>＋ Добавить человека</button>' + list.map(x =>
      '<div class="person' + (x.active ? '' : ' off') + '"><div><b>' + esc(x.name) + '</b> ' + (x.active ? '' : '<span class="bad">отключён</span>') +
      '<br><small>' + esc(x.roles.join(', ')) + '</small></div><div class="pbtn">' +
      (x.active ? '<button data-pcopy="' + esc(x.id) + '">Ссылка</button>' : '') +
      '<button data-pedit="' + esc(x.id) + '">Изменить</button>' +
      '<button data-pnew="' + esc(x.id) + '">Новая ссылка</button>' +
      '<button data-poff="' + esc(x.id) + '">' + (x.active ? 'Отключить' : 'Включить') + '</button></div></div>').join('');
    box.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const find = id => list.find(x => x.id === id);
      try {
        if (b.dataset.padd != null) return personForm(null, l => { list = l; });
        if (b.dataset.pedit) return personForm(find(b.dataset.pedit), l => { list = l; });
        if (b.dataset.pcopy) return shareLink(find(b.dataset.pcopy));
        if (b.dataset.pnew) {
          const x = find(b.dataset.pnew);
          if (!confirm('Выдать ' + x.name + ' новую ссылку? Старая сразу перестанет работать.')) return;
          list = await api('adminLink', { id: x.id }); drawPeople(list);
          shareLink(list.find(y => y.id === x.id));
          return;
        }
        if (b.dataset.poff) {
          const x = find(b.dataset.poff);
          if (x.active && !confirm('Отключить ' + x.name + '? Его ссылка сразу перестанет работать. История останется с его именем.')) return;
          list = await api('adminSave', { id: x.id, name: x.name, roles: x.roles, active: !x.active }); drawPeople(list);
          toast(x.active ? 'Отключён' : 'Включён');
        }
      } catch (er) { alert('Не получилось: ' + er.message); }
    };
  }
  async function shareLink(x) {
    if (!x) return;
    const text = 'Учёт ремонта шин — личная ссылка для ' + x.name + ' (никому не пересылать): ' + x.link;
    if (navigator.share) { try { await navigator.share({ title: 'Учёт ремонта шин', text: text }); return; } catch (e) {} }
    try { await navigator.clipboard.writeText(x.link); toast('Ссылка скопирована'); } catch (e) { prompt('Скопируйте ссылку:', x.link); }
  }
  function personForm(x, onList) {
    openForm(x ? 'Изменить: ' + x.name : 'Новый человек', f => {
      f.innerHTML = '<label>Имя<input id="pn" value="' + esc(x ? x.name : '') + '"></label><div class="lbl">Роли</div>' +
        L.ROLES.map(r => '<label class="chk"><input type="checkbox" value="' + esc(r) + '"' + (x && x.roles.indexOf(r) >= 0 ? ' checked' : '') + '> ' + esc(r) + '</label>').join('') +
        '<button class="btn big" id="psave">Сохранить</button>';
      $('psave').onclick = async () => {
        const roles = Array.from(f.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
        try {
          const l = await api('adminSave', { id: x ? x.id : '', name: $('pn').value.trim(), roles: roles, active: x ? x.active : true });
          onList(l); toast('Сохранено'); back();
          if (!x) { const nx = l[l.length - 1]; setTimeout(() => shareLink(nx), 400); }
        } catch (e) { alert('Не получилось: ' + e.message); }
      };
    });
  }

  // ---------- карточка шины ----------
  const ACT_LABEL = {
    inspect: '🔍 Осмотр', agree: '📞 Согласование с клиентом', util: '📞 Утиль — решение клиента', start: '🔧 Начать ремонт',
    hidden: '⚠ Скрытое повреждение', done: '✅ Ремонт закончен', check: '🔎 Проверка', pay: '💳 Отметить оплату',
    issue: '📦 Выдать клиенту', reassign: '👤 Передать другому менеджеру'
  };
  const thumb = id => 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w400';
  function photosOf(c, kind) {
    const a = (c.photos || []).filter(x => x.kind === kind).map(x => ({ src: thumb(x.id), big: 'https://drive.google.com/file/d/' + x.id + '/view' }));
    return a.concat(pend.filter(x => x.uid === c.uid && x.kind === kind).map(x => ({ src: x.data, big: '', local: true })));
  }
  function photoStrip(c, kind) {
    const a = photosOf(c, kind);
    if (!a.length) return '';
    return '<div class="lbl">Фото «' + kind + '»</div><div class="ph">' + a.map(x =>
      (x.big ? '<a href="' + esc(x.big) + '" target="_blank" rel="noopener">' : '<span>') + '<img src="' + esc(x.src) + '" alt="">' +
      (x.local ? '<i>⏳</i>' : '') + (x.big ? '</a>' : '</span>')).join('') + '</div>';
  }
  function worksTable(c) {
    if (!(c.works || []).length) return '';
    return '<div class="lbl">Работы</div><table class="wt">' + c.works.map(w => '<tr><td>' + esc(w.name) + (w.wedge ? ' <small>(клинья)</small>' : '') +
      (w.qty > 1 ? ' ×' + w.qty : '') + '</td><td>' + rub(L.num(w.price) * (w.qty || 1)) + '</td></tr>').join('') +
      '<tr class="tot"><td>Итого по работам</td><td>' + rub(L.sumWorks(c.works)) + '</td></tr></table>';
  }

  function cardView(m, uid) {
    const c = st.cards[uid];
    if (!c) { m.innerHTML = '<div class="top"><button class="back" data-back>‹ Назад</button></div><div class="empty">Шина не найдена</div>'; return; }
    const p = me();
    const cl = st.clients[c.client] || {};
    const mg = st.people[c.mgr];
    const acts = L.actionsFor(p, c);
    const pp = c.people || {};
    const tel = cl.phone ? '<a href="tel:' + esc(cl.phone.replace(/[^\d+]/g, '')) + '">' + esc(cl.phone) + '</a>' : '';
    let h = '<div class="top"><button class="back" data-back>‹ Назад</button><h2>' + esc(c.num || 'Новая шина') + ' · ' + esc(c.size) + '</h2></div>';
    if (!c.num) h += '<div class="hint">Номер Р-… появится, когда карточка дойдёт до сервера.</div>';
    h += '<div class="card"><div class="' + stCls(c.status) + ' stbig">' + esc(c.status) + '</div>' +
      '<div class="muted">' + age(c.since) + ' на этапе · ' + esc(c.statusBy || '') + ', ' + dt(c.since) + '</div>' +
      (c.wait && !L.isFinal(c) ? '<div class="warn">🚗 Машина ждёт — в первую очередь</div>' : '') +
      (c.again && c.status === S.AGREE ? '<div class="warn">Повторное согласование: скрытое повреждение</div>' : '') +
      '<dl>' +
      '<dt>Клиент</dt><dd>' + esc(cl.name || '—') + (tel ? '<br>' + tel : '') + '</dd>' +
      '<dt>Менеджер</dt><dd>' + esc(mg ? mg.name : 'не выбран') + '</dd>' +
      '<dt>Шина</dt><dd>' + esc([c.size, c.tire].filter(Boolean).join(' · ')) + (c.serial ? '<br>Сер. № ' + esc(c.serial) : '') + '</dd>' +
      '<dt>Группа прайса</dt><dd>' + esc(c.group || '—') + '</dd>' +
      (c.disk ? '<dt>На диске</dt><dd>да</dd>' : '') +
      (c.approx ? '<dt>Примерная цена</dt><dd>' + esc(c.approx) + '</dd>' : '') +
      (c.note ? '<dt>Заметка</dt><dd>' + esc(c.note) + '</dd>' : '') +
      '<dt>К оплате</dt><dd><b>' + rub(L.toPay(c)) + '</b> · ' + esc(c.pay) + (c.method ? ' (' + esc(c.method) + ')' : '') + '</dd>' +
      (c.outcome ? '<dt>Итог</dt><dd>' + esc(c.outcome) + '</dd>' : '') +
      '</dl>' + worksTable(c) + photoStrip(c, 'до') + photoStrip(c, 'после') + '</div>';
    if (acts.length) h += '<div class="acts">' + acts.map(t => '<button class="btn big" data-act="' + t + '">' + ACT_LABEL[t] + '</button>').join('') + '</div>';
    else if (!L.isFinal(c)) h += '<div class="hint">Сейчас шаг за другим человеком.</div>';
    h += '<div class="card"><div class="lbl">История</div><ul class="hist">' + (c.hist || []).slice().reverse().map(x =>
      '<li><span>' + dt(x.t) + '</span> <b>' + esc(x.by) + '</b>: ' + esc(x.what) + '</li>').join('') + '</ul>' +
      '<div class="cm"><input id="cmt" placeholder="Комментарий"><button class="btn" data-cmt>Добавить</button></div>' +
      '<div class="muted small">Принял: ' + esc(pp.accepted || '—') + ' · Осмотр: ' + esc(pp.inspected || '—') + ' · Ремонт: ' + esc(pp.repaired || '—') +
      ' · Проверка: ' + esc(pp.checked || '—') + ' · Выдал: ' + esc(pp.issued || '—') + '</div></div>';
    m.innerHTML = h;
  }

  function doAct(type, uid, p) {
    if (!act(type, uid, p)) return false;
    saveAll(); render(); sync();
    return true;
  }
  function submitForm(type, uid, p) {
    if (!act(type, uid, p)) return false;
    saveAll(); back(); sync();
    return true;
  }

  // ---------- выбор работ по прайсу ----------
  const WEDGE_RE = /^(Снятие колеса|Установка колеса|Разбортовка|Забортовка)/i;
  function worksEditor(box, groupName, init, opts) {
    opts = opts || {};
    const P = snap.price || { groups: [], works: [], wedge: [] };
    const gi = P.groups.indexOf(groupName);
    const items = P.works.map(w => ({ w: w, pr: gi >= 0 ? L.parsePrice(w.prices[gi]) : { manual: true, min: 0, price: 0, text: 'цена вручную' } }))
      .filter(x => !x.pr.none);
    const wp = gi >= 0 && P.wedge && P.wedge.length ? L.parsePrice(P.wedge[gi]) : { none: true };
    let rows = (init || []).map(w => Object.assign({}, w));
    let wedge = rows.some(w => w.wedge);
    const prOf = id => { const x = items.find(i => i.w.id === id); return x ? x.pr : { manual: true, min: 0, price: 0 }; };
    const locked = r => !opts.editAll && (r.wedge || prOf(r.id).fixed);
    const total = () => rows.reduce((s, r) => s + L.num(r.price) * (L.num(r.qty) || 1), 0);
    function hint(r) {
      const pr = prOf(r.id);
      if (r.wedge) return ' · клинья';
      if (pr.max) return ' · ' + pr.min + '–' + pr.max;
      if (pr.min && !pr.fixed) return ' · не меньше ' + pr.min;
      if (pr.manual) return ' · цена вручную';
      return '';
    }
    function draw() {
      box.innerHTML = (wp.none ? '' : '<label class="chk"><input type="checkbox" data-wedge' + (wedge ? ' checked' : '') + '> Диск под клинья (футорки): снятие, установка, разбортовка, забортовка — по ' + wp.price + ' ₽</label>') +
        '<div class="wrows">' + (rows.length ? rows.map((r, i) =>
          '<div class="wrow"><div class="wn">' + esc(r.name) + '<small>' + esc(r.kind) + esc(hint(r)) + '</small></div>' +
          '<div class="wq"><label>шт<input type="number" inputmode="numeric" min="1" value="' + r.qty + '" data-i="' + i + '" data-f="qty"></label>' +
          '<label>₽ за шт<input type="number" inputmode="numeric" min="0" value="' + r.price + '" data-i="' + i + '" data-f="price"' + (locked(r) ? ' readonly' : '') + '></label>' +
          '<button class="x" data-del="' + i + '">✕</button></div></div>').join('') : '<div class="muted">Работы не выбраны</div>') + '</div>' +
        '<div class="sum">Итого: <b data-total>' + rub(total()) + '</b></div>' +
        '<details class="pick"' + (rows.length ? '' : ' open') + '><summary>＋ Добавить работу</summary>' +
        (gi < 0 ? '<div class="muted">Группа прайса не выбрана — цены вводятся вручную</div>' : '') +
        items.map((x, k) => '<button class="pw" data-add="' + k + '"><span>' + esc(x.w.name) + '</span><b>' + esc(x.pr.text) + '</b></button>').join('') + '</details>';
    }
    box.oninput = e => {
      const i = e.target.dataset.i;
      if (i == null) return;
      rows[i][e.target.dataset.f] = e.target.value;
      box.querySelector('[data-total]').textContent = rub(total());
    };
    box.onclick = e => {
      const b = e.target.closest('[data-add],[data-del],[data-wedge]');
      if (!b) return;
      if (b.dataset.add != null) {
        e.preventDefault();
        const x = items[b.dataset.add];
        const isW = wedge && WEDGE_RE.test(x.w.name);
        rows.push({ id: x.w.id, name: x.w.name, kind: x.w.kind, qty: 1, price: isW ? wp.price : (x.pr.price || 0), wedge: isW });
        draw(); toast('Добавлено: ' + x.w.name);
      } else if (b.dataset.del != null) {
        rows.splice(Number(b.dataset.del), 1); draw();
      } else if (b.dataset.wedge != null) {
        wedge = b.checked;
        rows.forEach(r => {
          if (!WEDGE_RE.test(r.name)) return;
          r.wedge = wedge; r.price = wedge ? wp.price : (prOf(r.id).price || 0);
        });
        draw();
      }
    };
    draw();
    return {
      get() {
        rows.forEach(r => {
          const pr = prOf(r.id);
          if (!opts.editAll && !r.wedge && pr.min && L.num(r.price) < pr.min) throw new Error('«' + r.name + '»: цена не меньше ' + pr.min + ' ₽');
          if (L.num(r.qty) < 1) throw new Error('«' + r.name + '»: количество не меньше 1');
        });
        return rows.map(r => ({ id: r.id, name: r.name, kind: r.kind, qty: Math.round(L.num(r.qty)) || 1, price: L.num(r.price), wedge: !!r.wedge }));
      },
      rows: () => rows
    };
  }

  // ---------- фото ----------
  function compress(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const M = 1400, k = Math.min(1, M / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
        res(c.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => rej(new Error('не удалось открыть фото'));
      img.src = URL.createObjectURL(file);
    });
  }
  // Поле фото: arr — новые фото (dataURL), already — сколько уже есть у шины.
  function photoPicker(box, arr, already, max) {
    function draw() {
      const n = already + arr.length;
      box.innerHTML = '<div class="ph">' + arr.map((d, i) => '<span><img src="' + d + '" alt=""><button class="x" data-pdel="' + i + '">✕</button></span>').join('') + '</div>' +
        '<div class="muted">Фото: ' + n + ' из ' + max + (already ? ' (уже было ' + already + ')' : '') + '</div>' +
        (n < max ? '<div class="pbtns"><label class="btn">📷 Снять<input type="file" accept="image/*" capture="environment" hidden></label>' +
          '<label class="btn">🖼 Из галереи<input type="file" accept="image/*" multiple hidden></label></div>' : '');
      box.querySelectorAll('input[type=file]').forEach(inp => {
        inp.onchange = async () => {
          const files = Array.from(inp.files || []);  // сначала забрать файлы, потом очищать поле
          inp.value = '';
          for (const f of files) {
            if (already + arr.length >= max) { toast('Не больше ' + max + ' фото'); break; }
            try { arr.push(await compress(f)); } catch (e) { alert(e.message); }
          }
          draw();
        };
      });
    }
    box.onclick = e => { const b = e.target.closest('[data-pdel]'); if (b) { arr.splice(Number(b.dataset.pdel), 1); draw(); } };
    draw();
  }
  async function savePhotos(uid, kind, arr) {
    let t = Date.now();
    for (const d of arr) {
      const o = { pid: uuid(), uid: uid, kind: kind, data: d, t: t++ };
      await photoPut(o);
      pend.push(o);
    }
  }

  // ---------- справочник размеров и брендов (из приложения приёма шин) ----------
  let SPR = { size: [], brand: [] };
  fetch('spravochnik.json').then(r => r.json()).then(j => { SPR = j; }).catch(() => {});
  const dl = (id, arr) => '<datalist id="' + id + '">' + (arr || []).map(v => '<option value="' + esc(v) + '">').join('') + '</datalist>';

  // ---------- приёмка ----------
  function formAccept() {
    openForm('Приёмка шины', f => {
      const p = me();
      const P = snap.price || { groups: [] };
      const mgrs = Object.keys(st.people).map(k => st.people[k]).filter(x => x.active !== false && L.has(x, 'Менеджер'));
      let client = null, groupTouched = false;
      const photos = [];
      f.innerHTML =
        '<div class="lbl">Клиент</div><div id="csel"></div>' +
        '<div id="cfind"><input id="cq" placeholder="Название или телефон клиента" autocomplete="off"><div id="cres"></div>' +
        '<button class="btn" id="cnew">＋ Новый клиент</button></div>' +
        '<div id="cnewbox" hidden class="card"><label>Название / имя<input id="cn"></label><label>Телефон<input id="cp" type="tel"></label>' +
        '<label>Менеджер клиента<select id="cm"><option value="">— выберите —</option>' + mgrs.map(x => '<option value="' + esc(x.id) + '"' + (x.id === p.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></label></div>' +
        '<label>Размер<input id="sz" list="dlsz" placeholder="например 315/80R22.5" autocomplete="off"></label>' + dl('dlsz', SPR.size) +
        '<label>Группа прайса<select id="gr"><option value="">— выберите —</option>' + P.groups.map(g => '<option>' + esc(g) + '</option>').join('') + '</select></label>' +
        '<label>Шина: бренд, модель<input id="tr" list="dlbr" autocomplete="off"></label>' + dl('dlbr', SPR.brand) +
        '<label>Серийный номер (если есть)<input id="sn"></label>' +
        '<label class="chk"><input type="checkbox" id="dk"> На диске</label>' +
        '<label class="chk"><input type="checkbox" id="wt"> Машина ждёт (клиент на месте)</label>' +
        '<label>Примерная цена, если называли клиенту<input id="ap" inputmode="numeric"></label>' +
        '<label>Заметка<textarea id="nt" rows="2"></textarea></label>' +
        '<div class="lbl">Фото «до» (1–5, обязательно)</div><div id="phs"></div>' +
        '<button class="btn big" id="save">Принять шину</button>';
      photoPicker($('phs'), photos, 0, 5);
      const allClients = () => Object.keys(st.clients).map(k => st.clients[k]);
      function showSel() {
        $('csel').innerHTML = client ? '<div class="card sel"><b>' + esc(client.name) + '</b> ' + esc(client.phone || '') + '<br><small>Менеджер: ' +
          esc((st.people[client.mgr] || {}).name || 'не выбран') + '</small> <button class="link" id="cchg">изменить</button></div>' : '';
        $('cfind').hidden = !!client;
        if (client) { $('cnewbox').hidden = true; $('cchg').onclick = () => { client = null; showSel(); }; }
      }
      $('cq').oninput = () => {
        const q = $('cq').value.trim().toLowerCase();
        const res = q ? allClients().filter(c => (c.name + ' ' + c.phone).toLowerCase().indexOf(q) >= 0).slice(0, 8) : [];
        $('cres').innerHTML = res.map(c => '<button class="pw" data-cid="' + esc(c.id) + '"><span>' + esc(c.name) + '</span><b>' + esc(c.phone || '') + '</b></button>').join('');
      };
      $('cres').onclick = e => { const b = e.target.closest('[data-cid]'); if (b) { client = st.clients[b.dataset.cid]; showSel(); } };
      $('cnew').onclick = () => { $('cnewbox').hidden = false; $('cn').value = $('cq').value; $('cn').focus(); };
      $('sz').oninput = () => { if (!groupTouched) { const g = L.guessGroup($('sz').value, P.groups); $('gr').value = g; } };
      $('gr').onchange = () => { groupTouched = true; };
      $('save').onclick = async () => {
        let newClient = null;
        if (!client) {
          if ($('cnewbox').hidden) return alert('Выберите клиента или нажмите «Новый клиент»');
          const name = $('cn').value.trim();
          if (!name) return alert('Впишите название клиента');
          if (!$('cm').value) return alert('Выберите менеджера клиента');
          newClient = { id: 'c-' + uuid(), name: name, phone: $('cp').value.trim(), mgr: $('cm').value };
        }
        if (!$('sz').value.trim()) return alert('Впишите размер');
        if (!$('gr').value) return alert('Выберите группу прайса');
        if (!photos.length) return alert('Нужно хотя бы одно фото «до»');
        if (newClient && !act('client', '', newClient)) return;
        const uid = 'k-' + uuid();
        const ok = act('create', uid, {
          client: newClient ? newClient.id : client.id, size: $('sz').value.trim(), group: $('gr').value, tire: $('tr').value.trim(),
          serial: $('sn').value.trim(), disk: $('dk').checked, wait: $('wt').checked, approx: $('ap').value.trim(), note: $('nt').value.trim()
        });
        if (!ok) return;
        await savePhotos(uid, 'до', photos);
        await saveAll();
        toast('Шина принята');
        history.back();
        setTimeout(() => go('card', { uid: uid }), 50);
        sync();
      };
      showSel();
    });
  }

  // ---------- формы шагов ----------
  function formInspect(c) {
    openForm('Осмотр · ' + (c.num || c.size), f => {
      f.innerHTML = '<div class="seg"><label><input type="radio" name="dec" value="ремонт" checked> Ремонт возможен</label>' +
        '<label><input type="radio" name="dec" value="утиль"> Утиль</label></div>' +
        '<div class="hint" id="dh">Выберите работы — сумма уйдёт менеджеру на согласование.</div><div id="we"></div>' +
        '<label>Заметка (что нашли)<textarea id="nt" rows="2"></textarea></label><button class="btn big" id="save">Сохранить осмотр</button>';
      const ed = worksEditor($('we'), c.group, c.works);
      f.querySelectorAll('input[name=dec]').forEach(r => r.onchange = () => {
        $('dh').textContent = r.value === 'утиль' && r.checked ? 'Утиль: добавьте только уже сделанный шиномонтаж (если был) — его клиент оплатит.' : 'Выберите работы — сумма уйдёт менеджеру на согласование.';
      });
      $('save').onclick = () => {
        const dec = f.querySelector('input[name=dec]:checked').value;
        let works;
        try { works = ed.get(); } catch (e) { return alert(e.message); }
        if (dec === 'ремонт' && !works.length) return alert('Выберите хотя бы одну работу');
        submitForm('inspect', c.uid, { decision: dec, works: works, note: $('nt').value.trim() });
      };
    });
  }
  function formHidden(c) {
    openForm('Скрытое повреждение · ' + (c.num || ''), f => {
      f.innerHTML = '<div class="hint">Добавьте новые работы. Шина уйдёт менеджеру на повторное согласование.</div><div id="we"></div>' +
        '<label>Что нашли<textarea id="nt" rows="2"></textarea></label><button class="btn big" id="save">Отправить на согласование</button>';
      const ed = worksEditor($('we'), c.group, []);
      $('save').onclick = () => {
        let works;
        try { works = ed.get(); } catch (e) { return alert(e.message); }
        if (!works.length) return alert('Добавьте работы');
        submitForm('hidden', c.uid, { works: works, note: $('nt').value.trim() });
      };
    });
  }
  function clientLine(c) {
    const cl = st.clients[c.client] || {};
    return '<div class="card"><b>' + esc(cl.name || '') + '</b>' + (cl.phone ? ' · <a href="tel:' + esc(cl.phone.replace(/[^\d+]/g, '')) + '">' + esc(cl.phone) + '</a>' : '') + '</div>';
  }
  function formAgree(c) {
    openForm('Согласование · ' + (c.num || ''), f => {
      f.innerHTML = clientLine(c) + (c.again ? '<div class="warn">Повторное согласование: скрытое повреждение</div>' : '') +
        '<div class="hint">Можно поправить цены, если договорились с клиентом иначе.</div><div id="we"></div>' +
        '<button class="btn big ok" id="yes">✅ Клиент согласен</button>' +
        '<button class="btn big no" id="no">❌ Клиент отказался</button>' +
        '<div id="nobox" hidden class="card"><label>Сколько платит клиент (уже сделанный шиномонтаж), ₽<input id="sum" inputmode="numeric" value="' + L.montSum(c.works) + '"></label>' +
        '<div class="hint">0 — выдача бесплатно.</div><button class="btn big" id="nook">Подтвердить отказ</button></div>';
      const ed = worksEditor($('we'), c.group, c.works, { editAll: true });
      $('yes').onclick = () => {
        let works;
        try { works = ed.get(); } catch (e) { return alert(e.message); }
        if (!works.length) return alert('Нет работ');
        submitForm('agree', c.uid, { yes: true, works: works });
      };
      $('no').onclick = () => { $('nobox').hidden = false; $('sum').focus(); };
      $('nook').onclick = () => submitForm('agree', c.uid, { yes: false, sum: L.num($('sum').value) });
    });
  }
  function formUtil(c) {
    openForm('Утиль · ' + (c.num || ''), f => {
      const ms = L.montSum(c.works);
      f.innerHTML = clientLine(c) + '<div class="hint">Сообщите клиенту, что шина в утиль. Что решил клиент?</div>' +
        '<div class="card"><b>Забирает шину</b><label>К оплате (шиномонтаж, если был), ₽<input id="s1" inputmode="numeric" value="' + ms + '"></label>' +
        '<button class="btn big" id="take">Забирает</button></div>' +
        '<div class="card"><b>Оставляет — платит за утиль</b><label>Сумма за утиль (вместе с шиномонтажем), ₽<input id="s2" inputmode="numeric" value="' + ms + '"></label>' +
        '<button class="btn big" id="leave">Оставляет в утиль</button></div>';
      $('take').onclick = () => submitForm('util', c.uid, { leave: false, sum: L.num($('s1').value) });
      $('leave').onclick = () => submitForm('util', c.uid, { leave: true, sum: L.num($('s2').value) });
    });
  }
  function formDone(c) {
    openForm('Ремонт закончен · ' + (c.num || ''), f => {
      const already = photosOf(c, 'после').length;
      const photos = [];
      f.innerHTML = '<div class="lbl">Фото «после» (1–5, обязательно)</div><div id="phs"></div><button class="btn big" id="save">На проверку</button>';
      photoPicker($('phs'), photos, already, 5);
      $('save').onclick = async () => {
        if (!already && !photos.length) return alert('Нужно хотя бы одно фото «после»');
        if (!act('done', c.uid, {})) return;
        await savePhotos(c.uid, 'после', photos);
        await saveAll(); back(); sync();
      };
    });
  }
  function formCheck(c) {
    openForm('Проверка · ' + (c.num || ''), f => {
      f.innerHTML = photoStrip(c, 'после') + '<button class="btn big ok" id="ok">✅ Проверка пройдена</button>' +
        '<button class="btn big no" id="bad">↩ Не прошла — обратно в ремонт</button>' +
        '<div id="badbox" hidden class="card"><label>Что не так<textarea id="nt" rows="2"></textarea></label><button class="btn big" id="badok">Вернуть в ремонт</button></div>';
      $('ok').onclick = () => submitForm('check', c.uid, { ok: true });
      $('bad').onclick = () => { $('badbox').hidden = false; };
      $('badok').onclick = () => submitForm('check', c.uid, { ok: false, note: $('nt').value.trim() });
    });
  }
  function formPay(c) {
    openForm('Оплата · ' + (c.num || ''), f => {
      f.innerHTML = clientLine(c) + '<div class="card">К оплате: <b>' + rub(L.toPay(c)) + '</b></div><div class="lbl">Отметка</div>' +
        L.PAY.map(x => '<label class="chk"><input type="radio" name="pay" value="' + esc(x) + '"' + (c.pay === x ? ' checked' : '') + '> ' + esc(x) + '</label>').join('') +
        '<div class="lbl">Способ (если оплачено)</div>' +
        '<label class="chk"><input type="radio" name="mt" value=""' + (!c.method ? ' checked' : '') + '> не указан</label>' +
        L.METHODS.map(x => '<label class="chk"><input type="radio" name="mt" value="' + esc(x) + '"' + (c.method === x ? ' checked' : '') + '> ' + esc(x) + '</label>').join('') +
        '<button class="btn big" id="save">Сохранить</button>';
      $('save').onclick = () => submitForm('pay', c.uid, { pay: f.querySelector('input[name=pay]:checked').value, method: f.querySelector('input[name=mt]:checked').value });
    });
  }
  function formReassign(c) {
    openForm('Передать шину · ' + (c.num || ''), f => {
      const mgrs = Object.keys(st.people).map(k => st.people[k]).filter(x => x.active !== false && L.has(x, 'Менеджер'));
      f.innerHTML = '<label>Новый менеджер<select id="mg">' + mgrs.map(x => '<option value="' + esc(x.id) + '"' + (x.id === c.mgr ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></label>' +
        '<button class="btn big" id="save">Передать</button>';
      $('save').onclick = () => submitForm('reassign', c.uid, { mgr: $('mg').value });
    });
  }
  const HANDLERS = {
    inspect: formInspect, agree: formAgree, util: formUtil, hidden: formHidden, done: formDone, check: formCheck,
    pay: formPay, reassign: formReassign,
    start: c => { if (confirm('Начать ремонт ' + (c.num || c.size) + '?')) doAct('start', c.uid, {}); },
    issue: c => { if (confirm('Выдать шину ' + (c.num || c.size) + ' клиенту?')) doAct('issue', c.uid, {}); }
  };

  function rejectsView() {
    openForm('Не принято сервером', f => {
      f.innerHTML = '<div class="hint">Обычно это значит, что шаг уже сделал другой человек, пока у вас не было интернета.</div>' +
        rejects.map(r => '<div class="card"><b>' + esc(r.what) + '</b> · ' + esc(r.num || r.size || '') + ' · ' + dt(r.t) + '<br><span class="bad">' + esc(r.err) + '</span></div>').join('') +
        '<button class="btn big" id="ok">Понятно</button>';
      $('ok').onclick = async () => { rejects = []; await saveAll(); back(); };
    });
  }

  // ---------- нажатия ----------
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-uid],[data-tab],[data-accept],[data-act],[data-back],[data-sync],[data-cmt],#notice,#bar');
    if (!t) return;
    if (t.id === 'notice') return rejectsView();
    if (t.id === 'bar') return sync();
    if (t.dataset.back != null) return back();
    if (t.dataset.sync != null) return sync();
    if (t.dataset.tab) { tab = t.dataset.tab; try { localStorage.setItem('remont-tab', tab); } catch (er) {} return render(); }
    if (t.dataset.accept != null) return formAccept();
    if (t.dataset.uid) return go('card', { uid: t.dataset.uid });
    const top = stack[stack.length - 1];
    const c = top.uid && st.cards[top.uid];
    if (t.dataset.act && c) return HANDLERS[t.dataset.act](c);
    if (t.dataset.cmt != null && c) {
      const v = $('cmt').value.trim();
      if (v) doAct('comment', c.uid, { text: v });
    }
  });

  // ---------- запуск ----------
  (async function init() {
    try {
      snap = await kvGet('snap') || null;
      queue = await kvGet('queue') || [];
      rejects = await kvGet('rejects') || [];
      lastSync = await kvGet('lastSync') || 0;
      pend = await photoAll() || [];
    } catch (e) { alert('Память телефона недоступна: ' + e.message); }
    if (relinked) snap = null;  // открыли другую личную ссылку — загрузить заново
    rebuild();
    render();
    sync();
    setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
