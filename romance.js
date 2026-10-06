// Hearthtide — romance.js
// {{char}} и {{user}}: дружба и романтика; свидания: приглашение → намечено → идёт → итог.
// Шаги свидания живые: открыто не больше трёх, сделанный или сорвавшийся сменяется новым из ролплея.

/** Как идут дела у {{char}} и {{user}} по умолчанию — пока ИИ не скажет иначе */
export const PAIR_DEFAULT = { f: 0, r: 0, note: null, scale: 2 };   // дружба и романтика: −100…100, 0 — ровно

// Сложность свиданий: сколько дают шаг, срыв, «лучше/хуже» и цель; сколько шагов и успеха нужно, чтобы цель открылась
export const DATE_LEVELS = {
    easy: { step: 8, fail: -7, up: 3, down: -5, goal: 12, goalSteps: 3, goalScore: 40 },
    hard: { step: 6, fail: -10, up: 2, down: -7, goal: 10, goalSteps: 5, goalScore: 55 },
};
export const levelOf = (k) => DATE_LEVELS[k] || DATE_LEVELS.easy;
/** Сколько шагов открыто одновременно */
export const DATE_OPEN = 3;
// Итоги свидания: порог успеха → что меняется в отношениях
export const DATE_RESULTS = [
    { key: 'great', min: 75, f: 6, r: 15 },
    { key: 'good', min: 50, f: 3, r: 8 },
    { key: 'awkward', min: 25, f: 0, r: 0 },
    { key: 'bad', min: 10, f: -4, r: -8 },
    { key: 'terrible', min: 0, f: -8, r: -15 },
];
// Шанс, что {{char}} позовёт на свидание после ответа (%) и пауза между свиданиями (ответов)
export const DATE_CHANCE = { base: 6 };   // по умолчанию; меняется в настройках
export const DATE_COOLDOWN = 10;
/** Намеченное свидание не началось через столько часов после срока — не состоялось */
export const DATE_MISS_HOURS = 12;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const idOf = (t) => { let h = 0; for (const ch of String(t || '')) h = (h * 31 + ch.codePointAt(0)) | 0; return (h >>> 0).toString(36); };
const normT = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\d]+/gu, ' ').trim();

/** Предложенное ИИ или начатое историей свидание → в состояние. at: { day, clock } — на когда назначено */
export function newDate(d, turn, started) {
    const date = {
        v: 2,
        // одно и то же свидание при повторной обработке ответа — тот же id (уведомление и анимация — один раз)
        id: `d-${turn}-${idOf(d.title)}`,
        title: d.title, goal: d.goal || null, hook: d.hook || null, where: d.where || null, at: d.at || null,
        steps: [], nextN: 1, score: 0, goalDone: false, thought: null, vibe: null, notes: [],
        status: started ? 'active' : 'offered',
        turn, startTurn: started ? turn : null, lastUpdate: turn, result: null,
    };
    if (started) for (const s of d.steps || []) addStep(date, s.t, s.who, turn);
    return date;
}

/** Свидание началось: шкала с нуля, шаги появятся в ближайшем ответе */
export function startDate(d, turn) {
    d.status = 'active';
    d.startTurn = turn;
    d.lastUpdate = turn;
    d.score = 0;
}

export const openSteps = (d) => (d?.steps || []).filter(s => s.state === 'open').sort((a, b) => a.slot - b.slot);
export const doneCount = (d) => (d?.steps || []).filter(s => s.state === 'done').length;
export const failCount = (d) => (d?.steps || []).filter(s => s.state === 'failed').length;
/** Цель открыта: сделано достаточно шагов и свидание идёт неплохо */
export const goalOpen = (d, level) => !!d && !d.goalDone && doneCount(d) >= levelOf(level).goalSteps && d.score >= levelOf(level).goalScore;

function freeSlot(d) {
    const used = new Set(openSteps(d).map(s => s.slot));
    for (let i = 0; i < DATE_OPEN; i++) if (!used.has(i)) return i;
    return -1;
}
function addStep(d, t, who, turn) {
    if (!t) return false;
    const slot = freeSlot(d);
    if (slot < 0) return false;
    if (d.steps.some(s => s.state === 'open' && normT(s.t) === normT(t))) return false;
    d.steps.push({ n: d.nextN++, t, who: who || 'both', state: 'open', slot, turn, note: null });
    return true;
}

/**
 * Обновление идущего свидания от модели:
 * up = { done: [{n, note}], fail: [{n, note}], add: [{t, who}], mood, vibe, thought, goal, end, recap, best }
 * Возвращает { moved, ended, ignoredGoal }
 */
export function applyDateUp(d, up, turn, level) {
    if (!d || d.status !== 'active' || !up) return { moved: false, ended: false };
    const L = levelOf(level);
    let moved = false, ignoredGoal = false;
    const close = (x, st, delta) => {
        const s = d.steps.find(y => y.n === x.n && y.state === 'open');
        if (!s) return;
        s.state = st; s.note = x.note || null; s.endTurn = turn;
        d.score += delta;
        if (x.note) d.notes.push({ t: x.note, ok: st === 'done', turn });
        moved = true;
    };
    for (const x of up.done || []) close(x, 'done', L.step);
    for (const x of up.fail || []) close(x, 'failed', L.fail);
    for (const a of up.add || []) if (addStep(d, a.t, a.who, turn)) moved = true;
    if (up.mood > 0) { d.score += L.up; moved = true; }
    if (up.mood < 0) { d.score += L.down; moved = true; }
    if (up.vibe) d.vibe = up.vibe;
    if (up.thought) d.thought = up.thought;
    if (up.goal && !d.goalDone) {
        // цель достигается только после нескольких шагов и при неплохом ходе свидания
        if (goalOpen(d, level)) { d.goalDone = true; d.goalTurn = turn; d.score += L.goal; moved = true; }
        else ignoredGoal = true;
    }
    if (up.recap) d.recap = up.recap;
    if (up.best) d.best = up.best;
    d.score = clamp(d.score, 0, 100);
    if (moved) d.lastUpdate = turn;
    if (d.notes.length > 10) d.notes = d.notes.slice(-10);
    // старые закрытые шаги не копим
    const closed = d.steps.filter(s => s.state !== 'open');
    if (closed.length > 16) d.steps = [...closed.slice(-16), ...openSteps(d)];
    return { moved, ended: !!up.end, ignoredGoal };
}

/** Шаг отмечен игроком вручную */
export function toggleStep(date, n, turn, level) {
    const s = date?.steps?.find(x => x.n === n);
    if (!s || date.status !== 'active' || s.state !== 'open') return;
    s.state = 'done'; s.endTurn = turn; s.manual = true;
    date.score = clamp(date.score + levelOf(level).step, 0, 100);
    date.lastUpdate = turn;
}

/** Итог: по шкале успеха; если срывов больше, чем удач, и успеха мало — ужасно */
export function resultOf(d) {
    const score = typeof d === 'number' ? d : d.score;
    if (typeof d === 'object' && failCount(d) >= 2 && failCount(d) > doneCount(d) && score < 25) return DATE_RESULTS[DATE_RESULTS.length - 1];
    return DATE_RESULTS.find(r => score >= r.min) || DATE_RESULTS[DATE_RESULTS.length - 1];
}

/** Завершить свидание: итог, перемены в отношениях */
export function finishDate(state, turn) {
    const d = state.date;
    if (!d || d.status !== 'active') return null;
    const res = resultOf(d);
    d.status = 'ended';
    d.result = res.key;
    d.endTurn = turn;
    const p = state.pair || (state.pair = { ...PAIR_DEFAULT });
    const before = { f: p.f, r: p.r };
    p.f = clamp(p.f + res.f, -100, 100);
    p.r = clamp(p.r + res.r, -100, 100);
    d.delta = { f: p.f - before.f, r: p.r - before.r };
    state.lastDateEnd = turn;
    state.datesDone = [...(state.datesDone || []), { id: d.id, title: d.title, result: res.key, score: d.score }].slice(-20);
    return d;
}

/** Романтика пары, с которой {{char}} уже может позвать: любая искра выше нуля */
export const DATE_ROM_MIN = 1;

/**
 * Шанс, что {{char}} позовёт на свидание после этого ответа, и почему он такой.
 * why: off · nopair · norom · active · offered · scheduled · cooldown (left) · quarrel · ok
 */
export function dateChanceInfo(state, turn, base = DATE_CHANCE.base) {
    if (!base) return { chance: 0, why: 'off' };
    const p = state.pair;
    if (!p) return { chance: 0, why: 'nopair' };
    if (p.r < DATE_ROM_MIN) return { chance: 0, why: 'norom', r: p.r };
    if (['active', 'offered', 'scheduled'].includes(state.date?.status)) return { chance: 0, why: state.date.status };
    const left = DATE_COOLDOWN - (turn - (state.lastDateEnd ?? -99));
    if (left > 0) return { chance: 0, why: 'cooldown', left };
    // дружба заметно упала за последние ответы — помириться: шанс в 2,5 раза выше
    if ((state.pairDrop ?? -99) >= turn - 6) return { chance: Math.min(100, Math.round(base * 2.5)), why: 'quarrel' };
    return { chance: base, why: 'ok' };
}
export const dateChance = (state, turn, base) => dateChanceInfo(state, turn, base).chance;

/** Свидание из старой версии (шаги разом, шкала с 35 %) → новый вид */
export function migrateDate(state) {
    const d = state.date;
    if (!d || d.v === 2) return;
    d.v = 2;
    d.nextN = 1;
    const old = d.steps || [];
    d.steps = [];
    d.notes = d.notes || [];
    for (const s of old) {
        const st = { n: d.nextN++, t: String(s.t || '').replace(/\s*\((?:user|char|both)\)\s*/gi, ' ').trim(), who: s.who || 'both', state: s.done ? 'done' : 'open', slot: -1, turn: d.turn, note: null };
        d.steps.push(st);
    }
    let slot = 0;
    for (const s of d.steps) if (s.state === 'open') { if (slot < DATE_OPEN) s.slot = slot++; else s.state = 'dropped'; }
    d.goalDone = d.goalDone || false;
    d.at = d.at || null;
    if (d.status === 'active' && d.score === 35 && !doneCount(d)) d.score = 0;   // старый стартовый бонус
}
