// Hearthtide — cast.js
// Люди истории: кто кому кем приходится, дни рождения, отношения с {{user}} и {{char}}.
// ИИ вносит каждого один раз; игрок может поправить или убрать — тогда ИИ его не вернёт.

import { dayNum, fromDayNum, nextOccurrence } from './dates.js';

export const CAST_GROUPS = ['relative', 'friend', 'acquaintance', 'other'];

const norm = (n) => String(n || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Один и тот же человек: то же имя или одно имя целиком входит в другое («Млада» и «Млада Гордеевна») */
export function samePerson(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const wx = x.split(' '), wy = y.split(' ');
    return wx[0].length >= 3 && wx[0] === wy[0] && (wx.length === 1 || wy.length === 1);
}

export const findCast = (state, name) => (state.cast || []).find(c => samePerson(c.name, name)) || null;
export const castBanned = (state, name) => (state.castNo || []).some(n => samePerson(n, name));

/** «21.12», «21.12.1123», «1123-12-21» → { d, m, y? } */
export function parseBday(v) {
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](-?\d{1,5}))?$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return { d: +m[1], m: +m[2], y: m[3] != null ? +m[3] : null };
    m = s.match(/^(-?\d{1,5})-(\d{1,2})-(\d{1,2})$/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return { d: +m[3], m: +m[2], y: +m[1] };
    return null;
}
export const bdayText = (b) => b ? `${String(b.d).padStart(2, '0')}.${String(b.m).padStart(2, '0')}${b.y != null ? `.${b.y}` : ''}` : '';

/** Через сколько дней день рождения (0 — сегодня) */
export function bdayIn(c, today) {
    if (!c?.bday || today == null) return null;
    return nextOccurrence({ m: c.bday.m, d: c.bday.d }, today) - today;
}
/** Возраст на сегодня, если известен год */
export function ageOf(c, today) {
    if (!c?.bday || c.bday.y == null || today == null) return null;
    const { y, m, d } = fromDayNum(today);
    const age = y - c.bday.y - ((m < c.bday.m || (m === c.bday.m && d < c.bday.d)) ? 1 : 0);
    return age >= 0 && age < 200 ? age : null;
}

/** Отношения 0–100 → ступень для подписи */
export function relLevel(n) {
    if (n == null) return null;
    if (n <= 15) return 'enmity';
    if (n <= 35) return 'conflict';
    if (n <= 50) return 'tolerate';
    if (n <= 65) return 'neutral';
    if (n <= 82) return 'warm';
    return 'close';
}
const clampRel = (v) => { const n = parseInt(v); return isNaN(n) ? null : Math.max(0, Math.min(100, n)); };
export { clampRel };

/** Романтика −100…100 → ступень */
export function romLevel(n) {
    if (n == null) return null;
    if (n <= -50) return 'hate';
    if (n < 0) return 'cold';
    if (n === 0) return 'none';
    if (n <= 30) return 'spark';
    if (n <= 65) return 'love';
    return 'deep';
}

/** Разобранный HT-CAST → в состояние. Новых — добавить, известных — только обновить отношения. */
export function mergeCast(state, parsed, langOk, turn) {
    if (!parsed) return false;
    let slip = false;
    state.cast = state.cast || [];
    for (const c of parsed.add) {
        if (![c.name, c.who].every(langOk)) { slip = true; continue; }
        if (castBanned(state, c.name)) continue;
        const ex = findCast(state, c.name);
        if (ex) {
            // уже есть: дополняем только пустое, правки игрока не трогаем
            if (!ex.edited) {
                if (!ex.who && c.who) ex.who = c.who;
                if (!ex.bday && c.bday) ex.bday = c.bday;
            }
            continue;
        }
        state.cast.push({
            id: `c-${turn}-${state.cast.length}-${Math.random().toString(36).slice(2, 6)}`,
            name: c.name, group: c.group, who: c.who, bday: c.bday,
            rel: { user: c.relU ?? 50, char: c.relC ?? 50 },
            // романтика — только не у родни: −100 ненависть/бывшие … 0 нет … 100 любовь
            rom: c.group === 'relative' ? null : { user: c.romU ?? 0, char: c.romC ?? 0 }, turn,
        });
    }
    for (const u of parsed.upd) {
        const ex = findCast(state, u.name);
        if (!ex || ex.relLock) continue;
        if (u.relU != null) ex.rel.user = u.relU;
        if (u.relC != null) ex.rel.char = u.relC;
        if (ex.group !== 'relative' && (u.romU != null || u.romC != null)) {
            ex.rom = ex.rom || { user: 0, char: 0 };
            if (u.romU != null) ex.rom.user = u.romU;
            if (u.romC != null) ex.rom.char = u.romC;
        }
        ex.relTurn = turn;
    }
    if (state.cast.length > 40) state.cast = state.cast.slice(-40);
    return slip;
}
