// Hearthtide — romance.js
// {{char}} и {{user}}: дружба и романтика; свидания со шкалой успеха и шагами.

/** Как идут дела у {{char}} и {{user}} по умолчанию — пока ИИ не скажет иначе */
export const PAIR_DEFAULT = { f: 0, r: 0, note: null, scale: 2 };   // дружба и романтика: −100…100, 0 — ровно

// Свидание: старт, шаг, «лучше/хуже»
export const DATE_SCORE = { start: 35, step: 15, up: 8, down: -10 };
// Итоги свидания: порог успеха → что меняется в отношениях
export const DATE_RESULTS = [
    { key: 'great', min: 80, f: 6, r: 15 },
    { key: 'good', min: 55, f: 3, r: 8 },
    { key: 'awkward', min: 30, f: 0, r: 0 },
    { key: 'bad', min: 0, f: -5, r: -10 },
];
// Шанс, что {{char}} позовёт на свидание после ответа (%) и пауза между свиданиями (ответов)
export const DATE_CHANCE = { base: 6 };   // по умолчанию; меняется в настройках
export const DATE_COOLDOWN = 10;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const idOf = (t) => { let h = 0; for (const ch of String(t || '')) h = (h * 31 + ch.codePointAt(0)) | 0; return (h >>> 0).toString(36); };

/** Предложенное ИИ или начатое историей свидание → в состояние */
export function newDate(d, turn, started) {
    return {
        // одно и то же свидание при повторной обработке ответа — тот же id (уведомление и анимация — один раз)
        id: `d-${turn}-${idOf(d.title)}`,
        title: d.title, goal: d.goal || null, hook: d.hook || null,
        steps: (d.steps || []).slice(0, 5).map(s => ({ t: s.t, who: s.who, done: false })),
        score: DATE_SCORE.start, status: started ? 'active' : 'offered',
        turn, startTurn: started ? turn : null, lastUpdate: turn, result: null,
    };
}

/** Отметки основной модели во время свидания: шаги, «лучше/хуже»; true — свидание закончилось */
export function trackDate(date, sm, turn) {
    if (!date || date.status !== 'active' || !sm) return false;
    let moved = false;
    for (const n of sm.dateStep || []) {
        const s = date.steps[n - 1];
        if (s && !s.done) { s.done = true; date.score += DATE_SCORE.step; moved = true; }
    }
    if (sm.dateMood > 0) { date.score += DATE_SCORE.up; moved = true; }
    if (sm.dateMood < 0) { date.score += DATE_SCORE.down; moved = true; }
    date.score = clamp(date.score, 0, 100);
    if (moved) date.lastUpdate = turn;
    return !!sm.dateEnd;
}

/** Шаг отмечен игроком вручную */
export function toggleStep(date, i) {
    const s = date?.steps?.[i];
    if (!s || date.status !== 'active') return;
    s.done = !s.done;
    date.score = clamp(date.score + (s.done ? DATE_SCORE.step : -DATE_SCORE.step), 0, 100);
}

/** Итог по шкале успеха */
export function resultOf(score) {
    return DATE_RESULTS.find(r => score >= r.min) || DATE_RESULTS[DATE_RESULTS.length - 1];
}

/** Завершить свидание: итог, перемены в отношениях */
export function finishDate(state, turn) {
    const d = state.date;
    if (!d || d.status !== 'active') return null;
    const res = resultOf(d.score);
    d.status = 'ended';
    d.result = res.key;
    d.endTurn = turn;
    const p = state.pair || (state.pair = { ...PAIR_DEFAULT });
    const before = { f: p.f, r: p.r };
    p.f = clamp(p.f + res.f, -100, 100);
    p.r = clamp(p.r + res.r, -100, 100);
    d.delta = { f: p.f - before.f, r: p.r - before.r };
    state.lastDateEnd = turn;
    state.datesDone = [...(state.datesDone || []), { title: d.title, result: res.key, score: d.score }].slice(-20);
    return d;
}

/** Романтика пары, с которой {{char}} уже может позвать: любая искра выше нуля */
export const DATE_ROM_MIN = 1;

/**
 * Шанс, что {{char}} позовёт на свидание после этого ответа, и почему он такой.
 * why: off — выключено в настройках · nopair — пара ещё не ясна · norom — романтики нет ·
 *      active / offered — свидание уже идёт или ждёт ответа · cooldown — пауза после прошлого (left — сколько ответов) ·
 *      quarrel — после ссоры шанс выше · ok
 */
export function dateChanceInfo(state, turn, base = DATE_CHANCE.base) {
    if (!base) return { chance: 0, why: 'off' };
    const p = state.pair;
    if (!p) return { chance: 0, why: 'nopair' };
    if (p.r < DATE_ROM_MIN) return { chance: 0, why: 'norom', r: p.r };
    if (state.date?.status === 'active') return { chance: 0, why: 'active' };
    if (state.date?.status === 'offered') return { chance: 0, why: 'offered' };
    const left = DATE_COOLDOWN - (turn - (state.lastDateEnd ?? -99));
    if (left > 0) return { chance: 0, why: 'cooldown', left };
    // дружба заметно упала за последние ответы — помириться: шанс в 2,5 раза выше
    if ((state.pairDrop ?? -99) >= turn - 6) return { chance: Math.min(100, Math.round(base * 2.5)), why: 'quarrel' };
    return { chance: base, why: 'ok' };
}
export const dateChance = (state, turn, base) => dateChanceInfo(state, turn, base).chance;
