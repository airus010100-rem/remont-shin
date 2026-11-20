// Учёт ремонта шин — правила движения шины (версия 1.0, 20.11.2026).
// Этот файл один и тот же в телефоне (logic.js) и на сервере (вставлен в Code.gs).
// Телефон применяет действие сразу (работает без интернета), сервер — когда действие до него дошло.
var L = (function () {
  var S = {
    NEW: 'Принята — ждёт осмотра',
    AGREE: 'Осмотрена — ждёт согласования',
    UTIL: 'Утиль — сообщить клиенту',
    QUEUE: 'Согласовано — в очереди',
    REPAIR: 'В ремонте',
    CHECK: 'На проверке',
    PAY: 'Готова — ждёт оплаты',
    ISSUE: 'К выдаче',
    DONE: 'Выдана',
    UTILIZED: 'Утилизирована'
  };
  var FINAL = [S.DONE, S.UTILIZED];
  var ROLES = ['Менеджер', 'Мастер', 'Шиномонтажник', 'Кладовщик', 'Руководитель', 'Администратор'];
  var PAY = ['не оплачено', 'предоплата', 'оплачено', 'без оплаты'];
  var METHODS = ['наличные', 'перевод', 'безнал'];

  function has(p, role) { return !!p && (p.roles || []).indexOf(role) >= 0; }
  function anyRole(p, roles) { for (var i = 0; i < roles.length; i++) if (has(p, roles[i])) return true; return false; }
  function num(x) { var n = Number(String(x == null ? '' : x).replace(',', '.').replace(/\s/g, '')); return isFinite(n) ? n : 0; }
  function sumWorks(ws) { var s = 0; (ws || []).forEach(function (w) { s += num(w.price) * (num(w.qty) || 1); }); return s; }
  function montSum(ws) { return sumWorks((ws || []).filter(function (w) { return w.kind === 'шиномонтаж'; })); }
  function toPay(c) { return c.toPay != null ? num(c.toPay) : sumWorks(c.works); }
  function paidOk(c) { return c.pay === 'оплачено' || c.pay === 'без оплаты'; }
  function isFinal(c) { return FINAL.indexOf(c.status) >= 0; }
  function cleanWorks(ws) {
    return (ws || []).map(function (w) {
      return { id: String(w.id || ''), name: String(w.name || ''), kind: String(w.kind || ''),
        qty: Math.max(1, Math.round(num(w.qty) || 1)), price: Math.max(0, num(w.price)), wedge: !!w.wedge };
    }).filter(function (w) { return w.name; });
  }
  function str(x, max) { return String(x == null ? '' : x).trim().slice(0, max || 300); }

  // Кто какие действия может делать и из какого статуса.
  var RULES = {
    client: { roles: ['Менеджер', 'Мастер', 'Шиномонтажник', 'Руководитель'] },
    create: { roles: ['Мастер', 'Менеджер', 'Руководитель'] },
    inspect: { roles: ['Мастер'], from: [S.NEW] },
    agree: { roles: ['Менеджер', 'Руководитель'], from: [S.AGREE] },
    util: { roles: ['Менеджер', 'Руководитель'], from: [S.UTIL] },
    start: { roles: ['Мастер'], from: [S.QUEUE] },
    hidden: { roles: ['Мастер'], from: [S.REPAIR] },
    done: { roles: ['Мастер'], from: [S.REPAIR] },
    check: { roles: ['Мастер'], from: [S.CHECK] },
    pay: { roles: ['Менеджер', 'Руководитель'] },
    issue: { roles: ['Мастер'], from: [S.ISSUE] },
    reassign: { roles: ['Руководитель'] },
    comment: { roles: ROLES }
  };
  var NAMES = {
    client: 'Клиент', create: 'Приёмка', inspect: 'Осмотр', agree: 'Согласование', util: 'Утиль — решение клиента',
    start: 'Начат ремонт', hidden: 'Скрытое повреждение', done: 'Ремонт закончен', check: 'Проверка',
    pay: 'Оплата', issue: 'Выдача', reassign: 'Передана другому менеджеру', comment: 'Комментарий'
  };

  function setStatus(c, st, a, who) {
    c.status = st; c.since = a.t; c.statusBy = who.name;
  }
  function log(c, a, who, what) {
    c.hist = c.hist || [];
    c.hist.push({ t: a.t, by: who.name, what: what });
  }
  function afterPayCheck(c, a, who) {
    if (c.status === S.PAY && paidOk(c)) setStatus(c, c.outcome === 'утиль — оставляет' ? S.UTILIZED : S.ISSUE, a, who);
  }

  // state = { people: {id: человек}, clients: {id: клиент}, cards: {uid: шина} }
  // a = { aid, t (время нажатия), by (id человека), type, uid, p (данные) }
  // Возвращает '' если принято, иначе текст причины. state меняется на месте.
  function apply(state, a) {
    var who = state.people[a.by];
    if (!who || who.active === false) return 'Человек не найден или ссылка отключена';
    var rule = RULES[a.type];
    if (!rule) return 'Неизвестное действие';
    if (!anyRole(who, rule.roles)) return 'Нет прав: «' + NAMES[a.type] + '» делает ' + rule.roles.join(' / ');
    var p = a.p || {};

    if (a.type === 'client') {
      var id = str(p.id, 60);
      if (!id || !str(p.name)) return 'У клиента нет названия';
      var old = state.clients[id];
      var mgr = state.people[p.mgr] ? p.mgr : (old ? old.mgr : '');
      state.clients[id] = { id: id, name: str(p.name, 200), phone: str(p.phone, 100), mgr: mgr,
        created: old ? old.created : a.t, by: old ? old.by : who.name };
      return '';
    }

    if (a.type === 'create') {
      if (!a.uid) return 'Нет номера карточки';
      if (state.cards[a.uid]) return '';  // уже есть (повторная отправка)
      var cl = state.clients[p.client];
      if (!cl) return 'Клиент не найден';
      var c = {
        uid: a.uid, num: '', kind: 'клиентская', client: cl.id, mgr: cl.mgr || (has(who, 'Менеджер') ? who.id : ''),
        size: str(p.size, 80), group: str(p.group, 200), tire: str(p.tire, 200), serial: str(p.serial, 80),
        disk: !!p.disk, wait: !!p.wait, approx: str(p.approx, 40), note: str(p.note, 1000),
        works: [], toPay: null, pay: 'не оплачено', method: '', outcome: '', again: false,
        created: a.t, people: { accepted: who.name }, photos: [], hist: []
      };
      state.cards[a.uid] = c;
      setStatus(c, S.NEW, a, who);
      log(c, a, who, 'Приёмка' + (c.disk ? ', на диске' : '') + (c.wait ? ', машина ждёт' : '') + (c.approx ? ', примерно ' + c.approx : ''));
      return '';
    }

    var card = state.cards[a.uid];
    if (!card) return 'Шина не найдена';
    if (rule.from && rule.from.indexOf(card.status) < 0) {
      return 'Уже «' + card.status + '»' + (card.statusBy ? ' — сделал(а) ' + card.statusBy : '');
    }
    if (isFinal(card) && a.type !== 'comment') return 'Шина уже закрыта: «' + card.status + '»';
    var ppl = card.people = card.people || {};

    switch (a.type) {
      case 'inspect':
        card.works = cleanWorks(p.works);
        card.toPay = null;
        ppl.inspected = who.name;
        if (p.decision === 'утиль') {
          setStatus(card, S.UTIL, a, who);
          log(card, a, who, 'Осмотр: утиль' + (str(p.note) ? ' — ' + str(p.note) : ''));
        } else {
          setStatus(card, S.AGREE, a, who);
          log(card, a, who, 'Осмотр: ремонт на ' + sumWorks(card.works) + ' ₽' + (str(p.note) ? ' — ' + str(p.note) : ''));
        }
        return '';
      case 'agree':
        if (p.yes) {
          if (p.works) card.works = cleanWorks(p.works);
          card.toPay = null; card.outcome = '';
          ppl.agreed = who.name;
          setStatus(card, S.QUEUE, a, who);
          log(card, a, who, 'Клиент согласен: ' + sumWorks(card.works) + ' ₽');
        } else {
          card.outcome = 'отказ';
          card.toPay = Math.max(0, num(p.sum));
          if (card.toPay === 0) card.pay = 'без оплаты'; else if (card.pay === 'без оплаты') card.pay = 'не оплачено';
          setStatus(card, card.toPay === 0 || paidOk(card) ? S.ISSUE : S.PAY, a, who);
          log(card, a, who, 'Клиент отказался от ремонта' + (card.toPay ? ', к оплате ' + card.toPay + ' ₽' : ', без оплаты'));
        }
        return '';
      case 'util':
        card.toPay = Math.max(0, num(p.sum));
        if (p.leave) {
          card.outcome = 'утиль — оставляет';
          if (card.toPay === 0) card.pay = 'без оплаты';
          setStatus(card, card.toPay === 0 ? S.UTILIZED : S.PAY, a, who);
          log(card, a, who, 'Клиент оставляет шину в утиль' + (card.toPay ? ', платит ' + card.toPay + ' ₽' : ''));
        } else {
          card.outcome = 'утиль — забирает';
          if (card.toPay === 0) card.pay = 'без оплаты';
          setStatus(card, card.toPay === 0 || paidOk(card) ? S.ISSUE : S.PAY, a, who);
          log(card, a, who, 'Клиент забирает шину (утиль)' + (card.toPay ? ', к оплате ' + card.toPay + ' ₽' : ', бесплатно'));
        }
        afterPayCheck(card, a, who);
        return '';
      case 'start':
        ppl.repaired = who.name;
        setStatus(card, S.REPAIR, a, who);
        log(card, a, who, 'Начат ремонт');
        return '';
      case 'hidden':
        var add = cleanWorks(p.works);
        card.works = (card.works || []).concat(add);
        card.again = true;
        setStatus(card, S.AGREE, a, who);
        log(card, a, who, 'Скрытое повреждение: +' + sumWorks(add) + ' ₽, нужно новое согласование' + (str(p.note) ? ' — ' + str(p.note) : ''));
        return '';
      case 'done':
        ppl.repaired = who.name;
        setStatus(card, S.CHECK, a, who);
        log(card, a, who, 'Ремонт закончен — на проверку');
        return '';
      case 'check':
        ppl.checked = who.name;
        if (p.ok) {
          setStatus(card, paidOk(card) ? S.ISSUE : S.PAY, a, who);
          log(card, a, who, 'Проверка пройдена — шина готова');
        } else {
          setStatus(card, S.REPAIR, a, who);
          log(card, a, who, 'Проверка не пройдена — обратно в ремонт' + (str(p.note) ? ' — ' + str(p.note) : ''));
        }
        return '';
      case 'pay':
        if (PAY.indexOf(p.pay) < 0) return 'Неизвестная отметка оплаты';
        card.pay = p.pay;
        card.method = METHODS.indexOf(p.method) >= 0 ? p.method : '';
        ppl.paid = who.name;
        log(card, a, who, 'Оплата: ' + p.pay + (card.method ? ' (' + card.method + ')' : '') + ', сумма ' + toPay(card) + ' ₽');
        afterPayCheck(card, a, who);
        return '';
      case 'issue':
        if (!paidOk(card)) return 'Выдача только при «оплачено» или «без оплаты»';
        ppl.issued = who.name;
        setStatus(card, S.DONE, a, who);
        log(card, a, who, 'Выдана клиенту');
        return '';
      case 'reassign':
        if (!state.people[p.mgr]) return 'Менеджер не найден';
        card.mgr = p.mgr;
        log(card, a, who, 'Передана менеджеру ' + state.people[p.mgr].name);
        return '';
      case 'comment':
        if (!str(p.text)) return 'Пустой комментарий';
        log(card, a, who, '💬 ' + str(p.text, 1000));
        return '';
    }
    return 'Неизвестное действие';
  }

  // Какие кнопки показать человеку для этой шины.
  function actionsFor(p, c) {
    var out = [];
    Object.keys(RULES).forEach(function (t) {
      var r = RULES[t];
      if (t === 'client' || t === 'create' || t === 'comment') return;
      if (!anyRole(p, r.roles)) return;
      if (isFinal(c)) return;
      if (r.from && r.from.indexOf(c.status) < 0) return;
      if (t === 'issue' && !paidOk(c)) return;
      out.push(t);
    });
    return out;
  }

  // Разбор цены из прайса: точная / «от N» / «A–B» / бесплатно / «-» (нет такой работы) / пусто (вручную).
  function parsePrice(s) {
    s = String(s == null ? '' : s).trim();
    if (s === '-' || s === '—') return { none: true };
    if (!s) return { manual: true, min: 0, price: 0, text: 'цена вручную' };
    if (/бесплатно/i.test(s)) return { fixed: true, price: 0, text: 'бесплатно' };
    var m = s.match(/^от\s*(\d[\d\s]*)/i);
    if (m) { var v = num(m[1]); return { min: v, price: v, text: 'от ' + v }; }
    m = s.match(/(\d[\d\s]*)\s*[-–]\s*(\d[\d\s]*)/);
    if (m) return { min: num(m[1]), max: num(m[2]), price: num(m[1]), text: num(m[1]) + '–' + num(m[2]) };
    m = s.match(/^(\d[\d\s]*)$/);
    if (m) return { fixed: true, price: num(m[1]), text: String(num(m[1])) };
    m = s.match(/(\d[\d\s]*)/);
    if (m) return { min: num(m[1]), price: num(m[1]), text: s };
    return { manual: true, min: 0, price: 0, text: s };
  }

  // Подсказка группы прайса по размеру (выбирает всё равно человек).
  function guessGroup(size, groups) {
    var s = String(size || '').toUpperCase().replace(/\s/g, '').replace(',', '.');
    var pick = function (re) { for (var i = 0; i < groups.length; i++) if (re.test(groups[i])) return groups[i]; return ''; };
    if (!s) return '';
    if (/R3[35]|-3[35]$|18\.00-25/.test(s)) return /^(18|21|24)\.00/.test(s) || /R35/.test(s) ? pick(/R35/) : pick(/R33.*камерн/i);
    if (/^29\.5R29/.test(s)) return pick(/29\.5R29/);
    if (/R25|-25$/.test(s)) {
      if (/^(23\.5|18\.00)/.test(s)) return pick(/23\.5R25/);
      if (/^(17\.5|20\.5)/.test(s)) return pick(/17\.5/);
      if (/^(26\.5|29\.5|600|750|875)/.test(s)) return pick(/26\.5/);
      return pick(/Дорожн.*R25/i);
    }
    if (/^(21\.3|12\.00)R24/.test(s)) return pick(/Вездеход/i);
    if (/R2[468]|R30|-2[468]$|-30$/.test(s)) return pick(/задние/i);
    if (/R19\.5|R22\.5|-19\.5|-22\.5/.test(s)) return pick(/R19\.5/);
    if (/530|533/.test(s)) return pick(/Вездеход/i);
    if (/R18|-18$/.test(s)) return pick(/передние/i);
    if (/R2[01]|-2[01]$/.test(s)) return pick(/^Грузовые R20/);
    return '';
  }

  return { S: S, FINAL: FINAL, ROLES: ROLES, PAY: PAY, METHODS: METHODS, RULES: RULES, NAMES: NAMES,
    has: has, anyRole: anyRole, num: num, sumWorks: sumWorks, montSum: montSum, toPay: toPay, paidOk: paidOk,
    isFinal: isFinal, apply: apply, actionsFor: actionsFor, parsePrice: parsePrice, guessGroup: guessGroup };
})();
