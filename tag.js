// Hearthtide — tag.js
// Разбор скрытых тегов из ответа ИИ.
//   Каждый ответ:   <!-- HT date=1151-02-05 | time=09:30 | when=5 февраля, утро | place=деревня -->
//   По запросу:     <!-- HT-CAL … -->   <!-- HT-PREP … -->   <!-- HT-DAY … -->   <!-- HT-RECAP … -->
//   Повод из истории: <!-- HT-NEW … -->

import { parseDate, parseMonthDay, parseClock } from './dates.js';

const clean = (v, max = 400) => {
    const x = String(v ?? '').replace(/\s+/g, ' ').trim();
    return x && !/^(none|null|нет|-|—|n\/a)$/i.test(x) ? x.slice(0, max) : null;
};

function fields(inner) {
    const out = {};
    for (const part of String(inner).split('|')) {
        const m = part.match(/^\s*([a-z_]+)\s*[=:]\s*([\s\S]*?)\s*$/i);
        if (m) out[m[1].toLowerCase()] = m[2];
    }
    return out;
}

// Блок по имени: строго (комментарий) или «прощающе» (в ```-блоке, без <!--, без -->)
function findBlock(text, name, loose = true) {
    const t = String(text ?? '');
    const strict = new RegExp(`<!--\\s*${name}(?![\\w-])[\\s:]*([\\s\\S]*?)-->`, 'gi');
    let m, last = null;
    while ((m = strict.exec(t)) !== null) last = m[1];
    if (last != null || !loose) return last;
    const noFence = t.replace(/```[a-z]*|```/gi, '');
    const open = noFence.match(new RegExp(`(?:<!--\\s*)?${name}(?![\\w-])[\\s:]*([\\s\\S]*?)(?:-->|$)`, 'i'));
    return open && open[1].trim() ? open[1] : null;
}

/** Маленький тег каждого ответа (HT); у отдельного запроса — тот же набор полей в HT-S */
export function parseSmall(text, name = 'HT') {
    const inner = findBlock(text, name);
    if (inner == null) return null;
    const f = fields(inner);
    return {
        inner,
        date: parseDate(f.date),
        when: clean(f.when, 80),
        clock: parseClock(f.time),
        place: clean(f.place, 60),
        char: clean(f.char, 160),                                   // мысль или действие персонажа сейчас
        gift: clean(f.gift, 160),                                   // мысль персонажа о подарке
        ev: (() => {                                                // статус текущего ивента
            const v = String(f.ev || '').trim().toLowerCase();
            return ['done', 'skipped', 'joined', 'declined'].find(x => v.startsWith(x.slice(0, 4))) || null;
        })(),
        evNote: clean(f.ev_note, 300),
        mean: clean(f.mean, 240),                                   // смысл праздника, который игрок переименовал
        giftDone: /^(true|yes|1|да)$/i.test(String(f.gift_done || '').trim()),
        giftTo: clean(f.gift_to, 60),
    };
}

/** Календарь: S | эпоха | вера | место  ·  H | дата | дней | название | смысл | тип  ·  B | user/char | ММ-ДД  ·  X | дата | название | тип (прошёл во время скипа) */
export function parseCalendar(text) {
    const inner = findBlock(text, 'HT-CAL');
    if (inner == null) return null;
    const res = { setting: null, holidays: [], birthdays: {}, passed: [] };
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        const kind = (cols[0] || '').toUpperCase();
        if (kind === 'S') {
            const mode = String(cols[4] || '').toLowerCase();
            res.setting = { era: clean(cols[1], 120), faith: clean(cols[2], 120), place: clean(cols[3], 60),
                mode: /^pres|^modern|^совр|^наш/.test(mode) ? 'modern' : /^past|^anc|^hist|^fant|^прош|^древ/.test(mode) ? 'ancient' : null };
        } else if (kind === 'H') {
            const start = parseDate(cols[1]);
            const days = Math.max(1, Math.min(14, parseInt(cols[2]) || 1));
            const name = clean(cols[3], 80);
            if (start == null || !name) continue;
            const prep = parseInt(cols[6]);
            res.holidays.push({ start, days, name, meaning: clean(cols[4], 240), type: normType(cols[5]),
                prep: isNaN(prep) ? null : Math.max(0, Math.min(45, prep)) });
        } else if (kind === 'X') {
            // праздник, который время перепрыгнуло (скип): X | дата | название | тип
            const start = parseDate(cols[1]);
            const name = clean(cols[2], 80);
            if (start != null && name) res.passed.push({ start, name, type: normType(cols[3]) });
        } else if (kind === 'B') {
            const who = /char|bot|{{char}}/i.test(cols[1] || '') ? 'char' : 'user';
            const md = parseMonthDay(cols[2]);
            const prep = parseInt(cols[3]);
            if (md) res.birthdays[who] = { ...md, prep: isNaN(prep) ? null : Math.max(0, Math.min(14, prep)) };
        }
    }
    return res;
}

const TYPES = ['religious', 'folk', 'seasonal', 'state', 'personal', 'family', 'supernatural', 'fast', 'memorial'];
function normType(v) {
    const x = String(v || '').toLowerCase();
    return TYPES.find(t => x.startsWith(t.slice(0, 4))) || 'folk';
}

/**
 * Новый повод из истории — предложение, которое игрок принимает или отклоняет:
 *   <!-- HT-NEW ЧТО_СЛУЧИЛОСЬ | YYYY-MM-DD | ДНЕЙ | НАЗВАНИЕ | СМЫСЛ | ТИП | PREP -->
 */
export function parseOffers(text) {
    const inner = findBlock(text, 'HT-NEW');
    if (inner == null) return [];
    const out = [];
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        if (/^H$/i.test(cols[0] || '')) cols.shift();               // вдруг пришло в формате строки H
        const start = parseDate(cols[1]);
        const name = clean(cols[3], 80);
        if (start == null || !name) continue;
        const prep = parseInt(cols[6]);
        out.push({
            cause: clean(cols[0], 120), start, name,
            days: Math.max(1, Math.min(14, parseInt(cols[2]) || 1)),
            meaning: clean(cols[4], 240), type: normType(cols[5]),
            prep: isNaN(prep) ? null : Math.max(0, Math.min(45, prep)),
        });
    }
    return out.slice(0, 2);
}

/** Подготовка: people / mood / char */
export function parsePrep(text) {
    const inner = findBlock(text, 'HT-PREP');
    if (inner == null) return null;
    const f = fields(inner);
    const g = String(f.gifts || '').trim().toLowerCase();
    const c = String(f.care || '').trim().toLowerCase();
    const r = {
        people: clean(f.people), mood: clean(f.mood),
        giftTo: clean(f.gift_to, 60),                               // кому по обычаю дарят
        gifts: /^(yes|true|да|1)/.test(g) ? true : /^(no|false|нет|0)/.test(g) ? false : null,
        care: /^(high|важ|выс)/.test(c) ? 'high' : /^(low|низ|мал|прох)/.test(c) ? 'low' : /^(norm|mid|обыч|сред)/.test(c) ? 'normal' : null,
    };
    return r.people || r.mood ? r : null;
}

/** День праздника: title / morning / day / evening / night */
export function parseDay(text) {
    const inner = findBlock(text, 'HT-DAY');
    if (inner == null) return null;
    const f = fields(inner);
    const r = { title: clean(f.title, 120), morning: clean(f.morning), day: clean(f.day), evening: clean(f.evening), night: clean(f.night) };
    return r.morning || r.day || r.evening || r.night ? r : null;
}

/** Событие праздника: кто, что за событие, одна фраза */
const EVENT_KINDS = ['gift', 'wish', 'rumor', 'prep', 'family', 'custom', 'mishap', 'thought'];
export function parseEvent(text) {
    const inner = findBlock(text, 'HT-EVENT');
    if (inner == null) return null;
    const f = fields(inner);
    const txt = clean(f.text, 300);
    if (!txt) return null;
    const k = String(f.kind || '').toLowerCase();
    return { who: clean(f.who, 60), kind: EVENT_KINDS.find(x => k.startsWith(x.slice(0, 4))) || 'custom', text: txt };
}

/**
 * Люди вокруг:
 *   P | ИМЯ | relative|friend|acquaintance | ЧЕМ ЗАНЯТ | ПОДАРОК  — активные
 *   D | ИМЯ | ЧТО СДЕЛАЛ                                         — своё отыграли, уходят из списка, но помнятся
 */
const GROUPS = ['relative', 'friend', 'acquaintance'];
export function parsePeople(text) {
    const inner = findBlock(text, 'HT-PEOPLE');
    if (inner == null) return null;
    const out = [];
    const done = [];
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        const kind = (cols[0] || '').toUpperCase();
        if (kind === 'D') {
            const name = clean(cols[1], 60), text = clean(cols[2], 160);
            if (name && text) done.push({ name, text });
            continue;
        }
        if (kind !== 'P') continue;
        const name = clean(cols[1], 60);
        if (!name) continue;
        const g = String(cols[2] || '').toLowerCase();
        out.push({
            name,
            group: GROUPS.find(x => g.startsWith(x.slice(0, 4))) || (/(род|сем|famil|kin)/.test(g) ? 'relative' : /(друг|подруг)/.test(g) ? 'friend' : 'acquaintance'),
            now: clean(cols[3], 160),
            gift: clean(cols[4], 120),
        });
    }
    if (!out.length && !done.length) return null;
    return { active: out.slice(0, 8), done: done.slice(0, 8) };
}

/**
 * Ивенты: <!-- HT-EV kind=event|party|moment | title=… | who=… -->
 * event — небольшое событие в сцене; party — мероприятие (сначала приглашение); moment — что-то на мероприятии
 */
export function parseEvents(text) {
    const t = String(text ?? '');
    const out = [];
    const re = /<!--\s*HT-EV(?![\w-])[\s:]*([\s\S]*?)-->/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
        const f = fields(m[1]);
        const title = clean(f.title, 160);
        if (!title) continue;
        const k = String(f.kind || '').toLowerCase();
        out.push({ kind: k.startsWith('part') ? 'party' : k.startsWith('mom') ? 'moment' : 'event', title, who: clean(f.who, 80) });
    }
    return out;
}

/** Подсказка основной модели на следующий ответ (от отдельного запроса); «none» — ничего */
export function parseBeat(text) {
    const inner = findBlock(text, 'HT-BEAT', false);
    return inner == null ? null : clean(inner, 300);
}

/** Итог прошедшего праздника — одна строка */
export function parseRecap(text) {
    const inner = findBlock(text, 'HT-RECAP');
    return inner == null ? null : clean(inner, 300);
}

/**
 * Убирает из текста сообщения крупные блоки (они уже разобраны и сохранены)
 * и «неправильные» формы маленького тега. Правильный скрытый <!-- HT … --> остаётся
 * как образец формата.
 */
export function stripBlocks(text) {
    let t = String(text ?? '');
    t = t.replace(/```[a-z]*\s*(?:<!--\s*)?HT(?:-[A-Z]+)?\b[\s\S]*?```/gi, '');
    t = t.replace(/\s*<!--\s*HT-(?:CAL|PREP|DAY|RECAP|EVENT|PEOPLE|EV|NEW|S|BEAT)\b[\s\S]*?-->/gi, '');
    t = t.replace(/\s*<!--\s*HT-(?:CAL|PREP|DAY|RECAP|EVENT|PEOPLE|EV|NEW|S|BEAT)\b(?![\s\S]*-->)[\s\S]*$/i, '');
    t = t.replace(/^\s*HT(?:-[A-Z]+)?\b[\s:]+[^\n]*$/gim, '');
    return t.replace(/\s+$/, '');
}
