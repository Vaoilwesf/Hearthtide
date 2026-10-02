// Hearthtide — calendar.js
// Фазы праздника и что попросить у ИИ в следующем ответе.

import { nextOccurrence, dayPart } from './dates.js';

// За сколько дней начинается подготовка: ИИ указывает сам для каждого праздника,
// это — запасные значения, если не указал
export const PREP_DEFAULT = { personal: 2, family: 3, fast: 1, memorial: 1 };
export const PREP_DEFAULT_OTHER = 5;
export function prepWindow(state, h) {
    if (!h) return 0;
    if (h.birthday) return state.birthdays?.[h.who]?.prep ?? PREP_DEFAULT.personal;
    if (h.prep != null) return h.prep;
    return PREP_DEFAULT[h.type] ?? PREP_DEFAULT_OTHER;
}

/** Камерный праздник (личный, семейный) или общий — от этого зависит масштаб подготовки */
export function isIntimate(h) {
    return !!h && (h.birthday || h.type === 'personal' || h.type === 'family');
}

/** Ключи названия для запрета: основное название и то, что в скобках */
export function banKeys(name) {
    const n = String(name || '').toLowerCase().replace(/ё/g, 'е');
    const main = n.replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\d]+/gu, ' ').trim();
    const alts = [...n.matchAll(/\(([^)]*)\)/g)].map(m => m[1].replace(/[^\p{L}\d]+/gu, ' ').trim());
    return [main, ...alts].filter(k => k.length >= 3);
}

/** Запрещён ли праздник (пользователь удалил его из списка) */
export function isBanned(state, name) {
    const banned = state.banned || [];
    if (!banned.length) return false;
    const keys = banKeys(name);
    return keys.some(k => banned.some(b => b === k || (k.length >= 5 && b.length >= 5 && (k.includes(b) || b.includes(k)))));
}

/** Один и тот же праздник под чуть другим названием (опечатка, скобки) — или уже другой */
export function namesMatch(a, b) {
    const A = banKeys(a), B = banKeys(b);
    if (!A.length || !B.length) return false;
    if (A[0].length >= 6 && B[0].length >= 6 && A[0].slice(0, 6) === B[0].slice(0, 6)) return true;
    return A.some(k => B.some(x => x === k || (k.length >= 5 && x.length >= 5 && (k.includes(x) || x.includes(k)))));
}

export function holidayId(h) {
    if (h.birthday) return `bday-${h.who}-${h.start}`;
    return `${String(h.name).toLowerCase().replace(/\s+/g, '-').slice(0, 40)}@${h.start}`;
}

/** Праздники из календаря + ближайшие дни рождения, по порядку */
export function allHolidays(state) {
    const list = (state.holidays || []).filter(h => !isBanned(state, h.name)).map(h => ({ ...h, id: holidayId(h) }));
    if (state.today != null) {
        for (const who of ['user', 'char']) {
            const md = state.birthdays?.[who];
            if (!md || state.birthdayOff?.[who]) continue;
            // и прошедший вчера (для «после»), и ближайший
            for (const from of [state.today - 1, state.today]) {
                const start = nextOccurrence(md, from);
                const h = { start, days: 1, name: null, who, birthday: true, type: 'personal' };
                h.id = holidayId(h);
                if (!list.some(x => x.id === h.id)) list.push(h);
            }
        }
    }
    return list.sort((a, b) => a.start - b.start);
}

const endOf = (h) => h.start + h.days - 1;

/**
 * Что сейчас в календаре.
 * kind: none | far | prep | today | after
 */
export function phaseOf(state) {
    const today = state.today;
    if (today == null) return { kind: 'none', upcoming: [] };
    const list = allHolidays(state);
    const upcoming = list.filter(h => h.start > today);
    const active = list.find(h => today >= h.start && today <= endOf(h));
    const ended = list.find(h => endOf(h) === today - 1 && !state.recapDone?.[h.id]);

    if (active) {
        return { kind: 'today', h: active, dayIndex: today - active.start + 1, upcoming, ended: null };
    }
    const next = upcoming[0] || null;
    const daysTo = next ? next.start - today : null;
    const window = prepWindow(state, next);
    const base = { h: next, daysTo, upcoming, ended: ended || null };
    if (ended) return { kind: 'after', ...base };
    if (!next) return { kind: 'none', ...base };
    return { kind: daysTo <= window ? 'prep' : 'far', ...base };
}

/** Нужен ли календарь: нет эпохи, нет даты или впереди меньше двух праздников */
export function needsCalendar(state) {
    if (state.forceCal || !state.setting?.era || state.today == null) return true;
    // Эпоха без единого слова («6658, 1150-12-05») — просим описать её словами
    if (!/\p{L}{3,}/u.test(state.setting.era)) return true;
    const ahead = (state.holidays || []).filter(h => h.start + h.days - 1 >= state.today && !isBanned(state, h.name));
    return ahead.length < 2;
}

/** Какой дополнительный блок попросить у ИИ в этот ответ (не больше одного за раз) */
export function requestFor(state, phase) {
    const r = requestForRaw(state, phase);
    return r && (state.backoff?.[r] ?? -1) > (state.turn || 0) ? requestForRaw(state, phase, r) : r;
}

// skip — тип запроса на паузе (ИИ его проигнорировал), берём следующий по важности
function requestForRaw(state, phase, skip = null) {
    const ok = (t) => t !== skip && !((state.backoff?.[t] ?? -1) > (state.turn || 0));
    // Итог — первым: окно у него один день, а календарь подождёт до следующего ответа
    if (phase.kind === 'after' && phase.ended && !state.recapDone?.[phase.ended.id]) { if (ok('recap')) return 'recap'; }
    if (needsCalendar(state)) { if (ok('cal')) return 'cal'; }
    if (phase.kind === 'today' && !state.days?.[`${phase.h.id}#${phase.dayIndex}`]) { if (ok('day')) return 'day'; }
    // Началась следующая часть дня — переписать оставшиеся части по тому, что уже произошло
    if (phase.kind === 'today') {
        const key = `${phase.h.id}#${phase.dayIndex}`;
        const part = dayPart(state.clock);
        if (part && state.planPart?.[key] && state.planPart[key] !== part) { if (ok('replan')) return 'replan'; }
    }
    if (phase.kind === 'after' && phase.ended && !state.recapDone?.[phase.ended.id]) { if (ok('recap')) return 'recap'; }
    if (phase.kind === 'prep') {
        const p = state.prep;
        if (!p || p.hid !== phase.h.id || p.day !== state.today || (state.turn || 0) - (p.turn ?? -99) >= 5) { if (ok('prep')) return 'prep'; }
    }
    // Ивенты праздничного дня: новый — когда сейчас ничего не идёт; на мероприятии — новые моменты
    if (phase.kind === 'today' && phase.h && state.days?.[`${phase.h.id}#${phase.dayIndex}`]) {
        const ev = openEvent(state, phase.h.id);
        if (ev?.kind === 'party' && ev.status === 'joined' && (state.turn || 0) - (ev.lastMoment ?? ev.turn) >= 3) { if (ok('moment')) return 'moment'; }
        if (!ev && (state.turn || 0) - (state.lastEventEnd ?? -99) >= 4) { if (ok('event')) return 'event'; }
    }
    // Люди праздника: текущее состояние каждого обновляется по ходу ролплея
    if ((phase.kind === 'prep' || phase.kind === 'today') && phase.h) {
        const every = (state.people || []).length ? (phase.kind === 'today' ? 2 : 4) : 5;
        if ((state.turn || 0) - (state.lastPeopleTurn ?? -99) >= every) { if (ok('people')) return 'people'; }
    }
    return null;
}

/** Как часто упоминать подготовку: чем ближе праздник, тем чаще (в ответах) */
export function mentionEvery(daysTo) {
    if (daysTo == null) return 99;
    if (daysTo >= 14) return 7;      // долгая подготовка (Новый год за месяц) — изредка
    if (daysTo >= 5) return 4;
    if (daysTo >= 2) return 3;
    return 2;
}

/** Предполагает ли праздник подарки: день рождения — всегда, остальное отмечает ИИ */
export function hasGifts(state, h) {
    if (!h) return false;
    if (h.birthday) return true;
    return state.gifts?.[h.id] === true;
}

/** Нужно ли в этом ответе обновить мысль/действие персонажа: зависит от важности праздника для него */
export function charDue(state, phase) {
    if (!phase.h || (phase.kind !== 'prep' && phase.kind !== 'today')) return false;
    const care = state.care?.[phase.h.id];
    if (care === 'high') return true;
    if (care === 'normal') {
        const cur = state.charNow?.hid === phase.h.id ? state.charNow : null;
        return !cur || (state.turn || 0) - (cur.turn || 0) >= 3;
    }
    return false;
}

/** Ивент, который сейчас в игре (или приглашение, на которое ещё не ответили) */
export const OPEN_STATUSES = ['active', 'invited', 'joined'];
export function openEvent(state, hid) {
    return (state.evts || []).find(e => e.hid === hid && OPEN_STATUSES.includes(e.status)) || null;
}
