// Hearthtide — tag.js
// Разбор скрытых тегов из ответа ИИ.
//   Каждый ответ:   <!-- HT date=1151-02-05 | time=09:30 | when=5 февраля, утро | place=деревня -->
//   По запросу:     <!-- HT-CAL … -->   <!-- HT-PREP … -->   <!-- HT-DAY … -->   <!-- HT-RECAP … -->

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

/** Маленький тег каждого ответа */
export function parseSmall(text) {
    const inner = findBlock(text, 'HT');
    if (inner == null) return null;
    const f = fields(inner);
    return {
        inner,
        date: parseDate(f.date),
        when: clean(f.when, 80),
        clock: parseClock(f.time),
        place: clean(f.place, 60),
    };
}

/** Календарь: S | эпоха | вера | место  ·  H | дата | дней | название | смысл | тип  ·  B | user/char | ММ-ДД */
export function parseCalendar(text) {
    const inner = findBlock(text, 'HT-CAL');
    if (inner == null) return null;
    const res = { setting: null, holidays: [], birthdays: {} };
    for (const raw of inner.split(/\n+/)) {
        const cols = raw.split('|').map(x => x.trim());
        const kind = (cols[0] || '').toUpperCase();
        if (kind === 'S') {
            res.setting = { era: clean(cols[1], 120), faith: clean(cols[2], 120), place: clean(cols[3], 60) };
        } else if (kind === 'H') {
            const start = parseDate(cols[1]);
            const days = Math.max(1, Math.min(14, parseInt(cols[2]) || 1));
            const name = clean(cols[3], 80);
            if (start == null || !name) continue;
            res.holidays.push({ start, days, name, meaning: clean(cols[4], 240), type: normType(cols[5]) });
        } else if (kind === 'B') {
            const who = /char|bot|{{char}}/i.test(cols[1] || '') ? 'char' : 'user';
            const md = parseMonthDay(cols[2]);
            if (md) res.birthdays[who] = md;
        }
    }
    return res;
}

const TYPES = ['religious', 'folk', 'seasonal', 'state', 'personal', 'family', 'supernatural', 'fast', 'memorial'];
function normType(v) {
    const x = String(v || '').toLowerCase();
    return TYPES.find(t => x.startsWith(t.slice(0, 4))) || 'folk';
}

/** Подготовка: people / mood / char */
export function parsePrep(text) {
    const inner = findBlock(text, 'HT-PREP');
    if (inner == null) return null;
    const f = fields(inner);
    const r = { people: clean(f.people), mood: clean(f.mood), char: clean(f.char) };
    return r.people || r.mood || r.char ? r : null;
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
    t = t.replace(/\s*<!--\s*HT-(?:CAL|PREP|DAY|RECAP|EVENT)\b[\s\S]*?-->/gi, '');
    t = t.replace(/\s*<!--\s*HT-(?:CAL|PREP|DAY|RECAP|EVENT)\b(?![\s\S]*-->)[\s\S]*$/i, '');
    t = t.replace(/^\s*HT(?:-[A-Z]+)?\b[\s:]+[^\n]*$/gim, '');
    return t.replace(/\s+$/, '');
}
