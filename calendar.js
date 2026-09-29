// Hearthtide — calendar.js
// Фазы праздника и что попросить у ИИ в следующем ответе.

import { nextOccurrence } from './dates.js';

export const PREP_WINDOW = 7;          // за сколько дней начинается подготовка
export const PREP_WINDOW_BIRTHDAY = 3;

export function holidayId(h) {
    if (h.birthday) return `bday-${h.who}-${h.start}`;
    return `${String(h.name).toLowerCase().replace(/\s+/g, '-').slice(0, 40)}@${h.start}`;
}

/** Праздники из календаря + ближайшие дни рождения, по порядку */
export function allHolidays(state) {
    const list = (state.holidays || []).map(h => ({ ...h, id: holidayId(h) }));
    if (state.today != null) {
        for (const who of ['user', 'char']) {
            const md = state.birthdays?.[who];
            if (!md) continue;
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
    const window = next?.birthday ? PREP_WINDOW_BIRTHDAY : PREP_WINDOW;
    const base = { h: next, daysTo, upcoming, ended: ended || null };
    if (ended) return { kind: 'after', ...base };
    if (!next) return { kind: 'none', ...base };
    return { kind: daysTo <= window ? 'prep' : 'far', ...base };
}

/** Нужен ли календарь: нет эпохи, нет даты или впереди меньше двух праздников */
export function needsCalendar(state) {
    if (state.forceCal || !state.setting?.era || state.today == null) return true;
    const ahead = (state.holidays || []).filter(h => h.start + h.days - 1 >= state.today);
    return ahead.length < 2;
}

/** Какой дополнительный блок попросить у ИИ в этот ответ (не больше одного за раз) */
export function requestFor(state, phase) {
    if (needsCalendar(state)) return 'cal';
    if (phase.kind === 'today' && !state.days?.[`${phase.h.id}#${phase.dayIndex}`]) return 'day';
    if (phase.kind === 'after' && phase.ended && !state.recapDone?.[phase.ended.id]) return 'recap';
    if (phase.kind === 'prep') {
        const p = state.prep;
        if (!p || p.hid !== phase.h.id || p.day !== state.today) return 'prep';
    }
    return null;
}

/** Как часто упоминать подготовку: чем ближе праздник, тем чаще (в ответах) */
export function mentionEvery(daysTo) {
    if (daysTo == null) return 99;
    if (daysTo >= 5) return 4;
    if (daysTo >= 2) return 3;
    return 2;
}
