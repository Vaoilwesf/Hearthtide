// Hearthtide — calendar.js
// Фазы праздника и что попросить у ИИ в следующем ответе.

import { nextOccurrence, dayPart, fromDayNum } from './dates.js';
import { isKin, castBanned } from './cast.js';

// За сколько дней начинается подготовка: ИИ указывает сам для каждого праздника,
// это — запасные значения, если не указал
export const PREP_DEFAULT = { personal: 2, family: 3, fast: 1, memorial: 1 };
export const PREP_DEFAULT_OTHER = 5;
export function prepWindow(state, h) {
    if (!h) return 0;
    if (h.npc) return h.prep ?? 1;
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
    if (h.npc) return `bday-npc-${h.cid}@${h.start}`;
    if (h.birthday) return `bday-${h.who}-${h.start}`;
    return `${String(h.name).toLowerCase().replace(/\s+/g, '-').slice(0, 40)}@${h.start}`;
}

// ─── День рождения человека из истории — свой, небольшой праздник ───
// Родня любого из двоих и близкие (отношения от 40) — сами; остальные — только если позвали и игрок принял.
// Отказ или «убрать» в инфоблоке — этот день рождения больше не показываем.
export const NPC_BD_AHEAD = 30;          // дальше месяца вперёд не показываем — список «Дальше» не засоряется
export const NPC_BD_CLOSE = 40;
export const npcBdKey = (cid, start) => `${cid}@${start}`;
export function npcBdOn(state, c, start) {
    if (!c?.id || !c.bday || c.off || (c.name && castBanned(state, c.name))) return false;
    const dec = state.bdDecisions?.[npcBdKey(c.id, start)];
    if (dec === 'declined') return false;
    if (dec === 'accepted') return true;
    return isKin(c.group) || (c.rel?.user ?? 0) >= NPC_BD_CLOSE || (c.rel?.char ?? 0) >= NPC_BD_CLOSE;
}
export function npcHoliday(c, start) {
    const h = { start, days: 1, name: c.name || c.toU || c.toC || '?', who: `npc:${c.id}`, npc: true, cid: c.id,
        birthday: true, type: 'personal', prep: isKin(c.group) ? 2 : 1 };
    h.id = holidayId(h);
    return h;
}
/**
 * Подарок имениннику от {{char}} и {{user}}: общий или каждый свой.
 * Выбрал игрок — так и есть; иначе общий, если они пара (романтика от 30) или это их общая семья.
 */
export const GIFT_JOINT_ROM = 30;
export function giftJoint(state, h) {
    if (!h?.npc) return false;
    const m = state.giftMode?.[h.id];
    if (m) return m === 'joint';
    const c = (state.cast || []).find(x => x.id === h.cid);
    return (state.pair?.r ?? 0) >= GIFT_JOINT_ROM || c?.group === 'kin_both';
}

/** Дни рождения людей истории, которые отмечаются: вчерашний (для «после») и ближайший */
export function npcBirthdays(state) {
    if (state.today == null) return [];
    const out = [];
    for (const c of state.cast || []) {
        if (!c?.bday) continue;
        for (const from of [state.today - 1, state.today]) {
            const start = nextOccurrence({ m: c.bday.m, d: c.bday.d }, from);
            if (start - state.today > NPC_BD_AHEAD || !npcBdOn(state, c, start)) continue;
            const h = npcHoliday(c, start);
            if (!out.some(x => x.id === h.id)) out.push(h);
        }
    }
    return out;
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
        for (const h of npcBirthdays(state)) if (!list.some(x => x.id === h.id)) list.push(h);
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
    // готовятся к тому, чьё окно подготовки уже открыто — даже если раньше него стоит чей-то день рождения
    const inPrep = upcoming.find(x => x.start - today <= prepWindow(state, x));
    const next = inPrep || upcoming[0] || null;
    const daysTo = next ? next.start - today : null;
    const base = { h: next, daysTo, upcoming, ended: ended || null };
    if (ended) return { kind: 'after', ...base };
    if (!next) return { kind: 'none', ...base };
    return { kind: inPrep ? 'prep' : 'far', ...base };
}

/** Этот праздник в текущем году уже прошёл — повторно не предлагаем; в следующем году — снова можно */
export function passedThisYear(state, name, start) {
    const log = state.yearLog;
    if (!log || !name) return false;
    const { y } = fromDayNum(start);
    return y === log.y && (log.items || []).some(i => !i.birthday && i.name && namesMatch(i.name, name));
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
    // Ивенты: выпал шанс — предложить случайное событие; на мероприятии — новые моменты
    if (phase.kind === 'today' && phase.h) {
        const ev = openEvent(state, phase.h.id);
        if (ev?.kind === 'party' && ev.status === 'joined' && (state.turn || 0) - (ev.lastMoment ?? ev.turn) >= 3) { if (ok('moment')) return 'moment'; }
    }
    // Люди праздника: текущее состояние каждого обновляется по ходу ролплея
    if ((phase.kind === 'prep' || phase.kind === 'today') && phase.h) {
        const every = (state.people || []).length ? (phase.kind === 'today' ? 2 : 4) : 5;
        if ((state.turn || 0) - (state.lastPeopleTurn ?? -99) >= every) { if (ok('people')) return 'people'; }
    }
    // Люди истории (кто кому кем, отношения) — изредка, если ничего важнее не нужно
    if ((state.turn || 0) - (state.lastCastTurn ?? -99) >= 8) { if (ok('cast')) return 'cast'; }
    return null;
}

// ═══ Отдельный запрос (API) ═══
// Основная модель пишет только дату и время; всё остальное собирает отдельный запрос
// по истории. Здесь — что в нём спросить и когда его отправлять.

/** Что спросить в отдельном запросе после этого ответа.
 *  Шаг персонажа, подарок и статус ивента пишет основная модель в своём теге — это почти бесплатно. */
export function sideNeeds(state, phase) {
    const n = new Set();
    const turn = state.turn || 0;
    if (phase.kind === 'after' && phase.ended && !state.recapDone?.[phase.ended.id]) n.add('recap');
    if (needsCalendar(state)) n.add('cal');
    const h = phase.h;
    const active = (phase.kind === 'prep' || phase.kind === 'today') && h;
    if (phase.kind === 'prep' && h) {
        const p = state.prep;
        if (!p || p.hid !== h.id || p.day !== state.today || turn - (p.turn ?? -99) >= SIDE_EVERY.prep) n.add('prep');
        n.add('people');
    }
    if (phase.kind === 'today' && h) {
        const key = `${h.id}#${phase.dayIndex}`;
        const part = dayPart(state.clock);
        if (!state.days?.[key]) n.add('day');
        else if (part && state.planPart?.[key] && state.planPart[key] !== part) n.add('replan');
        else n.add('plancheck');       // история могла уйти от плана раньше смены части суток
        n.add('people');
        const ev = openEvent(state, h.id);
        if (ev?.kind === 'party' && ev.status === 'joined') n.add('moments');
    }
    if (active && !h.birthday && !state.giftTo?.[h.id] && state.gifts?.[h.id]) n.add('giftto');
    if (active || (phase.kind === 'far' && h && phase.daysTo <= 14)) n.add('beat');
    if ((state.holidays || []).some(x => x.needMeaning && !isBanned(state, x.name))) n.add('mean');
    n.add('new');   // поводы из истории ищем при каждом запросе — это почти ничего не стоит
    n.add('cast');  // новые люди истории и перемены в отношениях — тоже
    // перепись: изредка — по большому окну сообщений, сначала родня обеих сторон и те, кого чаще называют
    const sinceCensus = turn - (state.lastCensusTurn ?? -99);
    if (sinceCensus >= CENSUS_EVERY || ((state.cast || []).length < 3 && sinceCensus >= 6)) n.add('census');
    // пара {{char}} и {{user}} ещё не ясна — начальные значения по карточке и персоне
    if (!state.pair) n.add('bond');
    // свидание: заметить, если история сама к нему пришла (предлагает его основная модель — прямо в ответе)
    const ds = state.date?.status;
    if (!state.dateRoll && (!state.date || ds === 'ended' || ds === 'missed')) n.add('datewatch');
    // ход свидания, его начало и итог — отдельным коротким запросом каждый ответ (runDateSide), не здесь
    // приглашение пришло от основной модели — помощник проверяет, что позвали вслух, а не только подумали
    // кубик выпал — план свидания составляет помощник: по карточке, персоне, лорбуку и истории
    if (state.dateRoll && !state.datePlan && !['active', 'offered', 'scheduled', 'pending'].includes(ds)) n.add('dateplan');
    return n;
}

/** Как часто ходит отдельный запрос (в ответах бота): в праздник чаще, издали реже */
export const SIDE_EVERY = { prep: 3, today: 2, far: 5 };
/** Перепись людей истории — раз в столько ответов; сколько сообщений она читает */
export const CENSUS_EVERY = 15;
export const CENSUS_DEPTH = 30;

/** Отправлять ли отдельный запрос после этого ответа */
export function sideDue(state, phase, needs) {
    // то, без чего инфоблок пустой или неверный, — сразу
    if (['recap', 'cal', 'mean', 'day', 'replan', 'census', 'date', 'daterecap', 'dateplan'].some(k => needs.has(k))) return true;
    // пара ещё не ясна — спросить сразу, но не чаще раза в 5 ответов, если помощник её не дал
    if (needs.has('bond') && (state.turn || 0) - (state.bondSide ?? -99) >= 5) return true;
    const since = (state.turn || 0) - (state.lastSideTurn ?? -99);
    if (phase.kind === 'prep') return needs.has('prep') || since >= SIDE_EVERY.prep;   // новый день — тоже
    if (phase.kind === 'today') return since >= SIDE_EVERY.today;
    return since >= SIDE_EVERY.far;
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
/** Ивент, предложенный игроку и ждущий решения (кнопки «Принять» / «Отклонить») */
export function offeredEvent(state) {
    return (state.evts || []).find(e => e.status === 'offered') || null;
}
/** Шанс случайного ивента после ответа, в процентах: в праздник чаще, в подготовке реже */
export const EVENT_CHANCE = { today: 35, prep: 15 };
export const EVENT_COOLDOWN = 3;

/** Сколько часов до намеченного свидания (отрицательное — срок прошёл); null — неизвестно */
export function dateHoursLeft(state) {
    const at = state.date?.at;
    if (!at || state.today == null) return null;
    const day = at.day ?? state.today;
    return (day - state.today) * 24 + (at.clock ?? 18) - (state.clock ?? 12);
}
