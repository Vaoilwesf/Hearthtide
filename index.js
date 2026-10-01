// Hearthtide — index.js
// Праздники, которые живут в ролплее: календарь эпохи, подготовка, сам праздник с утра до ночи.
// Всё через инджект: ИИ пишет скрытые теги, расширение считает дни и хранит память.

import {
    chat, chat_metadata, this_chid, characters,
    setExtensionPrompt, extension_prompt_types, extension_prompt_roles,
    saveChatDebounced, name1,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../../scripts/events.js';

import { dayPart, plural } from './dates.js';
import { parseSmall, parseCalendar, parsePrep, parseDay, parseRecap, parsePeople, stripBlocks } from './tag.js';
import { phaseOf, requestFor, mentionEvery, holidayId, allHolidays, banKeys, isBanned, hasGifts } from './calendar.js';
import { buildStatePrompt, buildTagPrompt } from './prompts.js';
import { strings } from './i18n.js';

// ═══════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ═══════════════════════════════════════════════════════════════
const META_KEY = 'hearthtide';
const PROMPT_STATE = 'hearthtide_state';
const PROMPT_TAG = 'hearthtide_tag';
const LS = {
    enabled: 'hearthtide_enabled',
    position: 'hearthtide_position',   // top | middle | bottom — внутри ответа бота
    showPrev: 'hearthtide_showPrev',   // показывать в предыдущих ответах
    era: 'hearthtide_era',             // ancient | modern — какие праздники подбирать
    faith: 'hearthtide_faith',         // faith | secular — только для современности
    lang: 'hearthtide_lang',           // ru | en — язык инфоблока
};
const lsGet = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v; };
const isEnabled = () => lsGet(LS.enabled, 'true') !== 'false';
const position = () => lsGet(LS.position, 'bottom');
const showPrev = () => lsGet(LS.showPrev, 'true') !== 'false';
const eraMode = () => lsGet(LS.era, 'ancient');
const faithMode = () => lsGet(LS.faith, 'faith');
const langMode = () => lsGet(LS.lang, 'ru');
const L = () => strings(langMode());

const KEEP_TAGS_IN_PROMPT = 3;

// Модуль таверны целиком — для main_api и updateMessageBlock (динамически, чтобы не падать)
let stModule = null;
import('../../../../script.js').then(m => { stModule = m; }).catch(() => {});
const isChatCompletion = () => stModule?.main_api === 'openai';

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ═══════════════════════════════════════════════════════════════
// СОСТОЯНИЕ ЧАТА
// ═══════════════════════════════════════════════════════════════
let state = null;

function defaultState() {
    return {
        version: 1,
        setting: null,          // { era, faith, place }
        place: null,            // текущее место (меняется по тегу place=)
        today: null,            // номер дня в календаре мира
        when: null,             // дата так, как её говорит история
        clock: null,            // часы
        holidays: [],           // { start, days, name, meaning, type }
        birthdays: {},          // { user: {m,d}, char: {m,d} }
        prep: null,             // { hid, day, people, mood, char }
        days: {},               // `${hid}#${n}` → { title, morning, day, evening, night }
        recaps: [],             // { hid, name, text }
        recapDone: {},
        people: [],             // [{ name, group, now, gift }] — текущий список, заменяется целиком
        lastPeopleTurn: -99,
        care: {},               // hid → high | normal | low — насколько праздник важен персонажу
        gifts: {},              // hid → true/false — предполагает ли праздник подарки
        charNow: null,          // { hid, text, turn } — мысль или действие персонажа сейчас
        charLog: {},            // hid → [{ text, turn }] — цепочка шагов персонажа, чтобы действия были последовательны
        charGift: null,         // { hid, text, done } — подарок персонажа игроку
        langSlip: false,        // в прошлом ответе значения пришли не на том языке
        forceCal: false,
        banned: [],             // ключи названий праздников, которые игрок удалил
        bannedNames: [],        // сами названия — для промпта
        birthdayOff: {},        // удалённые дни рождения { user: true }
        missed: 0,
        turn: 0,
        lastMention: -99,
        mentionNow: false,
        snapshots: [],          // состояние ДО обработки ответа — для свайпов и удалений
    };
}

function loadState() {
    if (!chat_metadata[META_KEY]) chat_metadata[META_KEY] = defaultState();
    state = chat_metadata[META_KEY];
    const def = defaultState();
    for (const k of Object.keys(def)) if (state[k] === undefined) state[k] = def[k];
}

function saveState() {
    chat_metadata[META_KEY] = state;
    saveChatDebounced();
}

const getUserName = () => name1 || 'User';
function getCharName() {
    const c = this_chid !== undefined ? characters[this_chid] : null;
    return c?.name || 'the characters';
}

// «деревня», «город», «village» без собственного имени — просим ИИ назвать место
const GENERIC_PLACES = /^(деревня|село|сельцо|город|городок|посад|слобода|усадьба|двор|монастырь|лагерь|стан|дорога|лес|поле|village|town|city|court|monastery|camp|road|wilds|forest|hamlet|estate|castle|замок|крепость|острог)$/i;

function ctxFor(request = null) {
    const phase = phaseOf(state);
    const placeName = state.place || state.setting?.place || null;
    return {
        state, phase, request,
        userName: getUserName(), charName: getCharName(),
        part: dayPart(state.clock),
        placeName,
        placeUnnamed: !!placeName && GENERIC_PLACES.test(String(placeName).trim()),
        // сохранённые раньше значения не на том языке — попросить переписать
        fixPlace: !!placeName && !langOk(placeName),
        fixSetting: !!state.setting && (!langOk(state.setting.era) || !langOk(state.setting.faith)),
        banned: state.bannedNames || [],
        eraMode: eraMode(),
        lang: L().promptLang,
        faithMode: faithMode(),
    };
}

// ─── Снимки: пересчёт при свайпе и правке, откат при удалении ───
function takeSnapshot(beforeMsg) {
    state.snapshots = state.snapshots.filter(s => s.beforeMsg < beforeMsg);
    const { snapshots, ...rest } = state;
    state.snapshots.push({ beforeMsg, data: clone(rest) });
    if (state.snapshots.length > 20) state.snapshots = state.snapshots.slice(-20);
}
// Решения игрока (удалённые праздники) переживают откаты
const USER_FIELDS = ['banned', 'bannedNames', 'birthdayOff', 'calIgnore'];

function restoreSnapshot(snap) {
    const keep = state.snapshots;
    const user = Object.fromEntries(USER_FIELDS.map(k => [k, clone(state[k] ?? null)]));
    Object.assign(state, clone(snap.data));
    for (const [k, v] of Object.entries(user)) if (v != null) state[k] = v;
    state.snapshots = keep;
    // удалённые игроком праздники не возвращаются вместе со старым снимком
    state.holidays = (state.holidays || []).filter(h => !isBanned(state, h.name));
}

// «Подобрать заново» — тоже решение игрока: применяем и к сохранённым снимкам,
// чтобы свайп не вернул старый календарь
function applyToSnapshots(fn) {
    for (const snap of state.snapshots) fn(snap.data);
}
const lastProcessedMsg = () => state.snapshots.reduce((m, s) => Math.max(m, s.beforeMsg), -1);

// ═══════════════════════════════════════════════════════════════
// ОБРАБОТКА ОТВЕТА ИИ
// ═══════════════════════════════════════════════════════════════
function hashText(t) {
    let h = 0;
    const s = String(t || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

// Значение на нужном языке? Для русского — есть кириллица (или вовсе нет букв), для английского — латиница
function langOk(v) {
    if (!v) return true;
    const s = String(v);
    const cyr = /[а-яё]/i.test(s), lat = /[a-z]/i.test(s);
    return langMode() === 'en' ? (lat || !cyr) : (cyr || !lat);
}

function processReply(N) {
    const msg = chat[N];
    if (!state || !msg || msg.is_user || msg.is_system || !msg.mes) return;

    const snap = state.snapshots.find(s => s.beforeMsg === N);
    if (snap) restoreSnapshot(snap);
    takeSnapshot(N);
    state.turn += 1;

    // Крупные блоки после первого разбора вырезаются из текста и живут в extra —
    // при свайпе назад или повторной обработке берём их оттуда
    let text = msg.mes;
    const saved = msg.extra?.ht_raw;
    const source = saved && saved.hash === hashText(text) ? saved.raw : text;

    const small = parseSmall(source);
    const cal = (state.calIgnore || []).includes(hashText(source)) ? null : parseCalendar(source);
    const prep = parsePrep(source);
    const day = parseDay(source);
    const recap = parseRecap(source);
    const people = parsePeople(source);

    // Чистим текст сообщения от крупных блоков и «неправильных» форм тега
    const cleaned = stripBlocks(text);
    if (cleaned !== text && cleaned.trim()) {
        msg.mes = cleaned;
        if (Array.isArray(msg.swipes) && msg.swipe_id != null) msg.swipes[msg.swipe_id] = cleaned;
        text = cleaned;
        try { stModule?.updateMessageBlock?.(N, msg); } catch (e) { /* пусто */ }
    }
    msg.extra = msg.extra || {};
    if (source !== text || !saved) msg.extra.ht_raw = { raw: source, hash: hashText(text) };

    // ── Дата, время, место ──
    let slip = false;
    if (small) {
        state.missed = 0;
        // Скип через несколько дней: праздники внутри скипа молча пропускаем (без итога)
        if (small.date != null && state.today != null && small.date - state.today > 1) {
            for (const h of allHolidays(state)) {
                const end = h.start + h.days - 1;
                if (end >= state.today && end < small.date) state.recapDone[h.id] = true;
            }
        }
        if (small.date != null) state.today = small.date;
        if (small.clock != null) state.clock = small.clock;
        slip = slip || !langOk(small.when) || !langOk(small.place);
        if (small.when && langOk(small.when)) state.when = small.when;
        if (small.place && langOk(small.place)) state.place = small.place;
    } else {
        state.missed = (state.missed || 0) + 1;
    }

    // ── Календарь ──
    if (cal) {
        const before = cal.holidays.length;
        cal.holidays = cal.holidays.filter(h => langOk(h.name));
        if (cal.holidays.length < before) slip = true;
        if (cal.setting) {
            for (const k of ['era', 'faith', 'place']) if (cal.setting[k] && !langOk(cal.setting[k])) { cal.setting[k] = null; slip = true; }
            state.setting = { ...(state.setting || {}), ...Object.fromEntries(Object.entries(cal.setting).filter(([, v]) => v)) };
            if (cal.setting.place) state.place = cal.setting.place;
        }
        mergeHolidays(cal.holidays);
        for (const [who, md] of Object.entries(cal.birthdays)) state.birthdays[who] = md;
        state.forceCal = false;
    }
    pruneHolidays();

    // ── Подготовка, день праздника, итог — привязываем к текущей фазе ──
    let phase = phaseOf(state);
    if (prep && phase.h && (phase.kind === 'prep' || phase.kind === 'far' || phase.kind === 'today')) {
        if (langOk(prep.people) && langOk(prep.mood)) {
            state.prep = { hid: phase.h.id, day: state.today, turn: state.turn, people: prep.people, mood: prep.mood };
        } else slip = true;
        if (prep.gifts != null) state.gifts[phase.h.id] = prep.gifts;
        if (prep.care) state.care[phase.h.id] = prep.care;
    }
    // Люди: список заменяется целиком — один человек, одна строка
    if (people && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        const ok = people.filter(p => langOk(p.now) && langOk(p.gift));
        if (ok.length < people.length) slip = true;
        if (ok.length) state.people = ok;
        state.lastPeopleTurn = state.turn;
    }
    // Мысль/действие персонажа и его подарок — из маленького тега
    if (small && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        if (small.char) {
            if (langOk(small.char)) {
                state.charNow = { hid: phase.h.id, text: small.char, turn: state.turn };
                const log = state.charLog[phase.h.id] || (state.charLog[phase.h.id] = []);
                if (log[log.length - 1]?.text !== small.char) log.push({ text: small.char, turn: state.turn });
                if (log.length > 6) state.charLog[phase.h.id] = log.slice(-6);
            }
            else slip = true;
        }
        if (small.gift || small.giftDone) {
            if (small.gift && !langOk(small.gift)) slip = true;
            const prev = state.charGift?.hid === phase.h.id ? state.charGift : null;
            state.charGift = {
                hid: phase.h.id,
                text: small.gift && langOk(small.gift) ? small.gift : prev?.text || null,
                done: !!(small.giftDone || prev?.done),
            };
        }
    }
    if (day && phase.kind === 'today' && !langOk(day.title || day.morning || day.day)) { slip = true; }
    else if (day && phase.kind === 'today') {
        state.days[`${phase.h.id}#${phase.dayIndex}`] = day;
    }
    if (recap && !langOk(recap)) slip = true;
    if (recap && phase.ended && langOk(recap)) {
        state.recaps.push({ hid: phase.ended.id, name: displayName(phase.ended), text: recap });
        if (state.recaps.length > 30) state.recaps = state.recaps.slice(-30);
        state.recapDone[phase.ended.id] = true;
    }
    phase = phaseOf(state);
    if (small || cal || prep || people || day || recap) state.langSlip = slip;
    // Праздник прошёл — люди и мысли персонажа к нему больше не относятся
    if (!phase.h || (phase.kind !== 'prep' && phase.kind !== 'today')) {
        if (state.charNow && state.charNow.hid !== phase.h?.id) state.charNow = null;
    }

    // ── Упоминать ли подготовку в следующем ответе (чем ближе, тем чаще) ──
    state.mentionNow = false;
    if (phase.kind === 'prep' && state.turn - state.lastMention >= mentionEvery(phase.daysTo)) {
        state.mentionNow = true;
        state.lastMention = state.turn;
    }

    // ── Снимок для инфоблока этого сообщения ──
    msg.extra.ht = viewSnapshot(phase);

    saveState();
    injectPrompts();
    scheduleRenderAll();
}

// «День рождения Нины» строкой праздника — это дубль дня рождения из B-строк
function birthdayOwner(name) {
    if (!/(день\s*рожд|днюх|именинн|birthday)/i.test(String(name))) return null;
    const n = String(name).toLowerCase();
    const stem = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е').slice(0, Math.max(3, String(x || '').length - 2));
    if (n.replace(/ё/g, 'е').includes(stem(getUserName()))) return 'user';
    if (n.replace(/ё/g, 'е').includes(stem(getCharName()))) return 'char';
    return null;
}

function mergeHolidays(list) {
    for (const h of list) {
        if (isBanned(state, h.name)) continue;
        const owner = birthdayOwner(h.name);
        if (owner) {
            if (!state.birthdays[owner]) {
                const d = new Date(h.start * 86400000);
                state.birthdays[owner] = { m: d.getUTCMonth() + 1, d: d.getUTCDate(), prep: h.prep ?? null };
            }
            continue;
        }
        const id = holidayId(h);
        const i = state.holidays.findIndex(x => holidayId(x) === id
            || (x.name.toLowerCase() === h.name.toLowerCase() && Math.abs(x.start - h.start) <= 3));
        if (i >= 0) state.holidays[i] = h;
        else state.holidays.push(h);
    }
    state.holidays.sort((a, b) => a.start - b.start);
}

// Держим прошедшие праздники ещё неделю (для «после»), остальное — в прошлое
function pruneHolidays() {
    // убрать уже попавшие в список дубли дней рождения
    state.holidays = (state.holidays || []).filter(h => !birthdayOwner(h.name));
    if (state.today == null) return;
    state.holidays = state.holidays.filter(h => h.start + h.days - 1 >= state.today - 7).slice(0, 20);
    for (const k of Object.keys(state.charLog || {})) {
        if (!state.holidays.some(h => holidayId(h) === k) && !k.startsWith('bday-')) delete state.charLog[k];
    }
    for (const k of Object.keys(state.days)) {
        const hid = k.split('#')[0];
        if (!state.holidays.some(h => holidayId(h) === hid) && !hid.startsWith('bday-')) delete state.days[k];
    }
}

// ─── Смена эпохи или веры: будущие праздники подбираются заново ───
function rebuildCalendar() {
    if (!state) loadState();
    const drop = (st) => {
        if (st.today != null) {
            // идущий сегодня праздник оставляем, остальные будущие — убираем
            st.holidays = (st.holidays || []).filter(h => h.start <= st.today && h.start + h.days - 1 >= st.today);
        } else {
            st.holidays = [];
        }
        st.prep = null;
        st.forceCal = true;
    };
    drop(state);
    applyToSnapshots(drop);
    // Календари из уже пришедших ответов больше не принимаем (при правке или повторной обработке);
    // новый свайп — новый текст, его календарь примется
    state.calIgnore = state.calIgnore || [];
    for (const m of chat) {
        const raw = m?.extra?.ht_raw?.raw;
        if (raw && /HT-CAL/i.test(raw)) {
            const hsh = hashText(raw);
            if (!state.calIgnore.includes(hsh)) state.calIgnore.push(hsh);
        }
    }
    if (state.calIgnore.length > 200) state.calIgnore = state.calIgnore.slice(-200);
    saveState();
    injectPrompts();
    renderAll();
    window.toastr?.info?.(L().rebuildToast, 'Hearthtide');
}

// ─── Удаление праздника игроком: больше не предлагается и нигде не показывается ───
function deleteHoliday(hid) {
    const h = allHolidays(state).find(x => x.id === hid);
    if (!h) return;
    if (h.birthday) {
        state.birthdayOff = { ...(state.birthdayOff || {}), [h.who]: true };
    } else {
        for (const k of banKeys(h.name)) if (!state.banned.includes(k)) state.banned.push(k);
        if (!state.bannedNames.includes(h.name)) state.bannedNames.push(h.name);
        state.holidays = state.holidays.filter(x => !isBanned(state, x.name));
    }
    // Стираем всё, что с ним связано — и в сохранённых снимках тоже
    applyToSnapshots(st => {
        st.holidays = (st.holidays || []).filter(x => !isBanned(state, x.name));
        if (st.prep?.hid === hid) st.prep = null;
        if (st.charNow?.hid === hid) st.charNow = null;
        if (st.charGift?.hid === hid) st.charGift = null;
        if (h.birthday) st.birthdayOff = { ...(st.birthdayOff || {}), [h.who]: true };
    });
    if (state.prep?.hid === hid) state.prep = null;
    for (const k of Object.keys(state.days)) if (k.startsWith(`${hid}#`)) delete state.days[k];
    state.recaps = state.recaps.filter(r => r.hid !== hid);
    if (state.charNow?.hid === hid) state.charNow = null;
    if (state.charGift?.hid === hid) state.charGift = null;
    saveState();
    injectPrompts();
    renderAll();
}

// В старых снимках тоже прячем удалённые праздники
function sanitizeView(view) {
    if (!view) return view;
    const gone = (name, birthday, who) => (birthday ? !!state.birthdayOff?.[who] : isBanned(state, name));
    const v = { ...view };
    v.upcoming = (v.upcoming || []).filter(u => !gone(u.name, u.birthday, u.who));
    v.recaps = (v.recaps || []).filter(r => !isBanned(state, r.name));
    if (v.h && gone(v.h.name, v.h.birthday, v.h.who)) {
        v.h = null; v.kind = 'none'; v.plan = null; v.prep = null; v.daysTo = null;
        v.people = []; v.charNow = null; v.charGift = null; v.care = null; v.gifts = false;
    }
    if (v.ended && isBanned(state, v.ended.name)) v.ended = null;
    return v;
}

function displayName(h) {
    if (!h) return '';
    if (h.birthday) return L().birthday(h.who === 'user' ? getUserName() : getCharName());
    return h.name;
}

function viewSnapshot(phase) {
    const planFor = (h, n) => (h ? state.days[`${h.id}#${n}`] || null : null);
    return {
        v: 1,
        setting: state.setting, place: state.place, when: state.when, part: dayPart(state.clock),
        kind: phase.kind,
        h: phase.h ? { id: phase.h.id, name: displayName(phase.h), meaning: phase.h.meaning, type: phase.h.type, days: phase.h.days, birthday: !!phase.h.birthday, who: phase.h.who } : null,
        daysTo: phase.daysTo ?? null,
        dayIndex: phase.dayIndex ?? null,
        plan: phase.kind === 'today' ? planFor(phase.h, phase.dayIndex) : null,
        prep: phase.kind === 'prep' && state.prep?.hid === phase.h?.id ? state.prep : null,
        ended: phase.ended ? { name: displayName(phase.ended), recap: state.recaps.find(r => r.hid === phase.ended.id)?.text || null } : null,
        upcoming: (phase.upcoming || []).filter(x => !phase.h || x.id !== phase.h.id).slice(0, 4)
            .map(x => ({ id: x.id, name: displayName(x), type: x.type, daysTo: x.start - state.today, birthday: !!x.birthday, who: x.who })),
        recaps: state.recaps.slice(-3).reverse(),
        ...(() => {
            const act = phase.h && (phase.kind === 'prep' || phase.kind === 'today');
            if (!act) return { people: [], care: null, charNow: null, charSteps: [], charGift: null, gifts: false };
            const hid = phase.h.id;
            return {
                people: clone(state.people || []),
                care: state.care[hid] || null,
                charNow: state.charNow?.hid === hid ? state.charNow.text : null,
                charSteps: (state.charLog?.[hid] || []).slice(-4, -1).map(x => x.text),
                charGift: state.charGift?.hid === hid ? { text: state.charGift.text, done: state.charGift.done } : null,
                gifts: hasGifts(state, phase.h) && !(phase.h.birthday && phase.h.who === 'char'),
            };
        })(),
    };
}

function liveView() { return viewSnapshot(phaseOf(state)); }

// ═══════════════════════════════════════════════════════════════
// ИНДЖЕКТ
// Состояние — на глубине 4; правило тега — в самом конце готового промпта
// (после инструкций пресета), для текстовых API — на глубине 0.
// ═══════════════════════════════════════════════════════════════
function currentRequest() {
    return requestFor(state, phaseOf(state));
}

function injectPrompts() {
    const on = isEnabled() && state;
    const ctx = on ? ctxFor(currentRequest()) : null;
    setExtensionPrompt(PROMPT_STATE, on ? buildStatePrompt(ctx) : '', extension_prompt_types.IN_CHAT, 4, true, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(PROMPT_TAG, on && !isChatCompletion() ? buildTagPrompt(ctx) : '', extension_prompt_types.IN_CHAT, 0, true, extension_prompt_roles.SYSTEM);
}

// Старые маленькие теги из истории в промпт не отправляем — только последние несколько как образец
const HT_RE = /\s*<!--\s*HT(?:-[A-Z]+)?\b[\s\S]*?-->/gi;
function stripOldTags(list) {
    let kept = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!m || typeof m.content !== 'string' || !/<!--\s*HT\b/i.test(m.content)) continue;
        if (kept < KEEP_TAGS_IN_PROMPT) { kept++; continue; }
        m.content = m.content.replace(HT_RE, '').replace(/\s+$/, '');
    }
}

function onPromptReady(eventData) {
    if (!isEnabled() || !state || !eventData || !Array.isArray(eventData.chat)) return;
    stripOldTags(eventData.chat);
    if (eventData.dryRun) return;
    const text = buildTagPrompt(ctxFor(currentRequest()));
    let at = eventData.chat.length;
    while (at > 0 && eventData.chat[at - 1]?.role === 'assistant') at--;
    eventData.chat.splice(at, 0, { role: 'system', content: text });
}

function onAfterCombinePrompts(data) {
    if (!isEnabled() || !data || typeof data.prompt !== 'string') return;
    const all = [...data.prompt.matchAll(HT_RE)];
    if (all.length <= KEEP_TAGS_IN_PROMPT) return;
    const cut = new Set(all.slice(0, all.length - KEEP_TAGS_IN_PROMPT).map(m => m.index));
    data.prompt = data.prompt.replace(HT_RE, (match, offset) => (cut.has(offset) ? '' : match));
}

// ═══════════════════════════════════════════════════════════════
// ИНФОБЛОК
// ═══════════════════════════════════════════════════════════════
const ui = { open: new Map(), confirmDel: null };

const TYPE_ICON = {
    religious: 'fa-church', folk: 'fa-wheat-awn', seasonal: 'fa-leaf', state: 'fa-flag',
    personal: 'fa-cake-candles', family: 'fa-house-chimney', supernatural: 'fa-ghost', fast: 'fa-hourglass-half', memorial: 'fa-feather',
};

const EVENT_ICON = {
    gift: 'fa-gift', wish: 'fa-star', rumor: 'fa-comments', prep: 'fa-hammer',
    family: 'fa-people-roof', custom: 'fa-bell', mishap: 'fa-triangle-exclamation', thought: 'fa-cloud',
};
const PART_ICON = { morning: 'fa-cloud-sun', day: 'fa-sun', evening: 'fa-cloud-moon', night: 'fa-moon' };

function lastBotIndex() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return -1;
}
const getMesEl = (id) => document.querySelector(`#chat .mes[mesid="${id}"]`);

let renderTimer = null;
function scheduleRenderAll() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, 60);
}
function renderAll() {
    if (!isEnabled()) { document.querySelectorAll('.ht-ib').forEach(b => b.remove()); return; }
    if (!state && chat.length) loadState();
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderBlock(Number(el.getAttribute('mesid'))));
}

function placeBlock(mesEl, block) {
    const text = mesEl.querySelector('.mes_text');
    if (!text) return false;
    const pos = position();
    if (pos === 'top') {
        text.insertAdjacentElement('beforebegin', block);
    } else if (pos === 'middle') {
        // Между абзацами посередине ответа
        const parts = [...text.children].filter(el => el !== block && !el.classList.contains('ht-ib'));
        if (parts.length >= 2) parts[Math.ceil(parts.length / 2) - 1].insertAdjacentElement('afterend', block);
        else text.insertAdjacentElement('afterend', block);
    } else {
        text.insertAdjacentElement('afterend', block);
    }
    return true;
}

function shouldShow(id) {
    const msg = chat[id];
    if (!isEnabled() || !state || !msg || msg.is_user || msg.is_system) return false;
    const live = id === lastBotIndex();
    return live ? true : (showPrev() && !!msg.extra?.ht);
}

function renderBlock(id) {
    const el = getMesEl(id);
    if (!el) return;
    const msg = chat[id];
    const live = id === lastBotIndex();
    let block = el.querySelector('.ht-ib');
    const view = sanitizeView(state && msg && !msg.is_user && !msg.is_system ? (live ? liveView() : msg.extra?.ht) : null);
    const show = isEnabled() && view && (live || showPrev());
    if (!show) { block?.remove(); return; }

    if (!block) {
        block = document.createElement('div');
        block.className = 'ht-ib';
        bindBlock(block);
    }
    if (!placeBlock(el, block)) return;
    block.dataset.mesid = String(id);
    const open = ui.open.get(id) || false;
    block.classList.toggle('ht-open', open);
    block.innerHTML = headHtml(view, open) + (open ? bodyHtml(view, live) : '');
}

// ─── Кольцо: сколько дней осталось (из 30), в день праздника — полное ───
function ring(view) {
    const size = 42, sw = 4, r = size / 2 - sw / 2, C = 2 * Math.PI * r, c = size / 2;
    let frac = 0, center = '', cls = '';
    if (view.kind === 'today') {
        frac = view.h?.days > 1 ? view.dayIndex / view.h.days : 1;
        center = view.h?.days > 1 ? `<span class="ht-ring-num">${view.dayIndex}/${view.h.days}</span>` : '<i class="fa-solid fa-fire"></i>';
        cls = 'ht-ring-today';
    } else if ((view.kind === 'prep' || view.kind === 'far' || view.kind === 'after') && view.daysTo != null) {
        frac = Math.max(0.03, 1 - Math.min(view.daysTo, 30) / 30);
        center = `<span class="ht-ring-num">${view.daysTo > 99 ? '99+' : view.daysTo}</span>`;
        cls = view.kind === 'prep' ? 'ht-ring-prep' : '';
    } else {
        center = '<i class="fa-regular fa-calendar"></i>';
    }
    return `<span class="ht-ring ${cls}" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
            <circle class="ht-ring-track" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}"/>
            <circle class="ht-ring-fill" cx="${c}" cy="${c}" r="${r}" stroke-width="${sw}" stroke-dasharray="${C * frac} ${C}" transform="rotate(-90 ${c} ${c})"/>
        </svg>
        <span class="ht-ring-center">${center}</span>
    </span>`;
}

function daysWord(n) { return L().days(n, plural); }

function headHtml(view, open) {
    let title, sub = '';
    const h = view.h;
    if (view.kind === 'today' && h) {
        title = L().today(h.name);
        sub = view.plan?.title || (h.days > 1 ? L().dayOf(view.dayIndex, h.days) : h.meaning || '');
    } else if (view.kind === 'after' && view.ended) {
        title = L().ended(view.ended.name);
        sub = h ? L().nextIn(h.name, daysWord(view.daysTo)) : '';
    } else if (h) {
        title = h.name;
        sub = view.daysTo === 1 ? L().tomorrow : L().inDays(daysWord(view.daysTo));
        if (view.kind === 'prep') sub += L().preparing;
    } else {
        title = L().nearest;
        sub = L().soon;
    }
    const icon = h ? TYPE_ICON[h.birthday ? 'personal' : h.type] || 'fa-star' : 'fa-calendar-days';
    return `<div class="ht-head" role="button" tabindex="0" data-act="toggle" aria-expanded="${open}">
        ${ring(view)}
        <span class="ht-head-text">
            <span class="ht-title"><i class="fa-solid ${icon}"></i>${esc(title)}</span>
            ${sub ? `<span class="ht-sub">${esc(sub)}</span>` : ''}
        </span>
        <i class="fa-solid fa-chevron-down ht-chev"></i>
    </div>`;
}

// Сворачиваемые разделы; что свёрнуто — помним между перезагрузками
const SEC_KEY = 'hearthtide_sections';
const SEC_DEFAULT_CLOSED = { upcoming: true, memories: true, people: true };
// «Дальше» не запоминаем: при каждом раскрытии инфоблока он свёрнут
const SESSION_SECTIONS = new Set(['upcoming']);
const secSession = {};
function secClosed(key) {
    if (SESSION_SECTIONS.has(key)) return secSession[key] !== false;
    try {
        const saved = JSON.parse(localStorage.getItem(SEC_KEY) || '{}');
        return key in saved ? !!saved[key] : !!SEC_DEFAULT_CLOSED[key];
    } catch { return !!SEC_DEFAULT_CLOSED[key]; }
}
function toggleSec(key) {
    if (SESSION_SECTIONS.has(key)) { secSession[key] = !secClosed(key) ? true : false; return; }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SEC_KEY) || '{}'); } catch { /* пусто */ }
    saved[key] = !secClosed(key);
    localStorage.setItem(SEC_KEY, JSON.stringify(saved));
}

function section(key, icon, title, html, extra = '') {
    if (!html) return '';
    const closed = secClosed(key);
    return `<section class="ht-sec${closed ? ' ht-sec-closed' : ''}">
        <h5 role="button" tabindex="0" data-act="sec" data-key="${key}" aria-expanded="${!closed}">
            <span class="ht-badge"><i class="fa-solid ${icon}"></i></span><span>${title}</span>${extra}<i class="fa-solid fa-chevron-down ht-sec-chev"></i>
        </h5>
        ${closed ? '' : `<div class="ht-sec-body">${html}</div>`}
    </section>`;
}

function bodyHtml(view, live) {
    const delBtn = (hid) => {
        if (!live || !hid) return '';
        const confirm = ui.confirmDel === hid;
        return `<button class="ht-del${confirm ? ' ht-del-confirm' : ''}" data-act="del" data-hid="${esc(hid)}" title="${confirm ? L().removeSure : L().remove}" aria-label="${L().remove}">
            <i class="fa-solid ${confirm ? 'fa-check' : 'fa-trash-can'}"></i>${confirm ? `<span>${L().removeQ}</span>` : ''}</button>`;
    };
    const s = view.setting || {};
    const kv = (icon, label, value) => `<div class="ht-kv"><i class="fa-solid ${icon}"></i><div><span>${label}</span><b>${esc(value)}</b></div></div>`;
    const world = [
        s.era && kv('fa-hourglass-half', L().era, s.era),
        s.faith && kv('fa-hands-praying', L().faith, s.faith),
        (view.place || s.place) && kv('fa-location-dot', L().place, view.place || s.place),
        view.when && kv('fa-calendar-day', L().date, view.when),
    ].filter(Boolean).join('');

    let main = '';
    const h = view.h;
    if (view.kind === 'today' && h) {
        const plan = view.plan;
        if (plan) {
            const rows = ['morning', 'day', 'evening', 'night'].filter(p => plan[p]).map(p => `
                <div class="ht-part${p === view.part ? ' ht-now' : ''}">
                    <i class="fa-solid ${PART_ICON[p]}"></i>
                    <div><b>${L().part[p]}${p === view.part ? L().now : ''}</b><span>${esc(plan[p])}</span></div>
                </div>`).join('');
            main = section('main', 'fa-fire', plan.title ? esc(plan.title) : L().festiveDay, `<div class="ht-parts">${rows}</div>`, delBtn(h.id));
        } else {
            main = section('main', 'fa-fire', L().festiveDay, `<p class="ht-text">${esc(h.meaning || '')}</p><p class="ht-mute">${L().planSoon}</p>`, delBtn(h.id));
        }
    } else if (view.kind === 'prep' && h) {
        const p = view.prep;
        main = section('main', 'fa-wand-magic-sparkles', L().prep, p ? `
            ${p.people ? `<p class="ht-text">${esc(p.people)}</p>` : ''}
            ${p.mood ? `<p class="ht-mood"><i class="fa-solid fa-feather-pointed"></i>${esc(p.mood)}</p>` : ''}`
            : `<p class="ht-text">${esc(h.meaning || '')}</p><p class="ht-mute">${L().prepSoon}</p>`, delBtn(h.id));
    } else if (view.kind === 'after' && view.ended) {
        main = section('main', 'fa-moon', esc(L().ended(view.ended.name)), `<p class="ht-text">${esc(view.ended.recap || L().afterDefault)}</p>`);
    } else if (h) {
        main = section('main', TYPE_ICON[h.type] || 'fa-star', esc(h.name), `<p class="ht-text">${esc(h.meaning || '')}</p>`, delBtn(h.id));
    }

    const upcoming = (view.upcoming || []).map(u => `
        <div class="ht-up"><i class="fa-solid ${TYPE_ICON[u.birthday ? 'personal' : u.type] || 'fa-star'}"></i>
        <span>${esc(u.name)}</span><b>${u.daysTo === 1 ? L().tomorrow : L().inDays(daysWord(u.daysTo))}</b>${delBtn(u.id)}</div>`).join('');

    // Персонаж — всегда сверху, своя карточка: важность, текущий шаг, что было до, подарок
    let charCard = '';
    if ((view.kind === 'prep' || view.kind === 'today') && view.care) {
        const g = view.charGift;
        const gift = view.gifts ? `<div class="ht-char-gift${g?.done ? ' ht-done' : ''}"><i class="fa-solid ${g?.done ? 'fa-circle-check' : 'fa-gift'}"></i>
            <div><span>${esc(L().giftForUser(getUserName()))}</span><b>${esc(g?.done ? (g.text || L().giftGiven) : (g?.text || L().giftUndecided))}</b></div></div>` : '';
        const trail = (view.charSteps || []).length ? `<div class="ht-trail"><span>${L().before}:</span> ${(view.charSteps).map(esc).join(' → ')}</div>` : '';
        charCard = `<div class="ht-char${live && view.care === 'high' ? ' ht-glow' : ''}">
            <div class="ht-char-head"><i class="fa-solid fa-user"></i><b>${esc(getCharName())}</b><span class="ht-care ht-care-${view.care}">${esc(L().care[view.care])}</span></div>
            ${view.care !== 'low' ? `<div class="ht-char-now"><span>${L().nowLabel}</span>${esc(view.charNow || L().charIdle)}</div>${trail}` : ''}
            ${gift}
        </div>`;
    }

    // Близкие и знакомые: по группам, один человек — одна строка, подарок прямо в строке
    const groups = ['relative', 'friend', 'acquaintance'].map(gk => {
        const list = (view.people || []).filter(p => p.group === gk);
        if (!list.length) return '';
        return `<div class="ht-group"><div class="ht-group-title">${L().groups[gk]}</div>${list.map(p => `
            <div class="ht-person"><b>${esc(p.name)}</b><span>${esc(p.now || '')}</span>${p.gift ? `<em class="ht-chip"><i class="fa-solid fa-gift"></i>${esc(p.gift)}</em>` : ''}</div>`).join('')}</div>`;
    }).join('');
    const peopleSec = section('people', 'fa-users', L().people, groups);
    const memories = (view.recaps || []).map(r => `<div class="ht-line"><i class="fa-solid fa-bookmark"></i><span><b>${esc(r.name)}:</b> ${esc(r.text)}</span></div>`).join('');

    return `<div class="ht-body">
        ${world ? `<div class="ht-world">${world}</div>` : ''}
        ${charCard}
        ${main}
        ${peopleSec}
        ${section('upcoming', 'fa-calendar-days', L().upcoming, upcoming)}
        ${section('memories', 'fa-bookmark', L().memories, memories)}
        ${live ? `<div class="ht-actions"><button class="ht-btn" data-act="rebuild" title="${L().rebuildTip}"><i class="fa-solid fa-arrows-rotate"></i>${L().rebuild}</button></div>` : ''}
    </div>`;
}

function bindBlock(block) {
    block.addEventListener('click', (e) => {
        const t = e.target.closest('[data-act]');
        if (!t || !block.contains(t)) return;
        e.stopPropagation();
        const id = Number(block.dataset.mesid);
        if (t.dataset.act === 'toggle') {
            const opening = !block.classList.contains('ht-open');
            if (opening) for (const k of SESSION_SECTIONS) delete secSession[k];
            ui.open.set(id, opening);
            renderBlock(id);
        } else if (t.dataset.act === 'rebuild') {
            rebuildCalendar();
        } else if (t.dataset.act === 'sec') {
            toggleSec(t.dataset.key);
            renderAll();   // во всех инфоблоках раздел свёрнут одинаково
        } else if (t.dataset.act === 'del') {
            const hid = t.dataset.hid;
            if (ui.confirmDel === hid) {
                ui.confirmDel = null;
                deleteHoliday(hid);
            } else {
                ui.confirmDel = hid;
                renderBlock(id);
            }
        }
    });
    block.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.ht-head, .ht-sec h5')) {
            e.preventDefault();
            e.target.click();
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// ПАНЕЛЬ В МЕНЮ РАСШИРЕНИЙ
// ═══════════════════════════════════════════════════════════════
function injectSettingsPanel() {
    let attempts = 0;
    const iv = setInterval(() => {
        attempts++;
        const container = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!container) { if (attempts >= 40) clearInterval(iv); return; }
        clearInterval(iv);
        if (document.getElementById('ht-settings')) return;
        container.insertAdjacentHTML('beforeend', `
        <div class="inline-drawer" id="ht-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-holly-berry"></i> Hearthtide</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content ht-settings">
                <label class="checkbox_label"><input type="checkbox" id="ht-set-enabled" ${isEnabled() ? 'checked' : ''}>Включить</label>
                <label class="ht-settings-row">Инфоблок в ответе бота
                    <select id="ht-set-position" class="text_pole">
                        <option value="top" ${position() === 'top' ? 'selected' : ''}>сверху</option>
                        <option value="middle" ${position() === 'middle' ? 'selected' : ''}>посередине</option>
                        <option value="bottom" ${position() === 'bottom' ? 'selected' : ''}>снизу</option>
                    </select>
                </label>
                <label class="checkbox_label"><input type="checkbox" id="ht-set-prev" ${showPrev() ? 'checked' : ''}>Показывать в предыдущих ответах</label>
                <label class="ht-settings-row">Язык инфоблока
                    <select id="ht-set-lang" class="text_pole">
                        <option value="ru" ${langMode() === 'ru' ? 'selected' : ''}>русский</option>
                        <option value="en" ${langMode() === 'en' ? 'selected' : ''}>English</option>
                    </select>
                </label>
                <label class="ht-settings-row">Эпоха
                    <select id="ht-set-era" class="text_pole">
                        <option value="ancient" ${eraMode() === 'ancient' ? 'selected' : ''}>Древность</option>
                        <option value="modern" ${eraMode() === 'modern' ? 'selected' : ''}>Современность</option>
                    </select>
                </label>
                <label class="ht-settings-row" id="ht-row-faith" ${eraMode() === 'modern' ? '' : 'style="display:none"'}>Праздники
                    <select id="ht-set-faith" class="text_pole">
                        <option value="faith" ${faithMode() === 'faith' ? 'selected' : ''}>с верой — крупные религиозные тоже</option>
                        <option value="secular" ${faithMode() === 'secular' ? 'selected' : ''}>светские — без религиозных</option>
                    </select>
                </label>
            </div>
        </div>`);
        document.getElementById('ht-set-enabled')?.addEventListener('change', e => {
            localStorage.setItem(LS.enabled, e.target.checked ? 'true' : 'false');
            injectPrompts();
            renderAll();
        });
        document.getElementById('ht-set-position')?.addEventListener('change', e => {
            localStorage.setItem(LS.position, e.target.value);
            document.querySelectorAll('.ht-ib').forEach(b => b.remove());
            renderAll();
        });
        document.getElementById('ht-set-lang')?.addEventListener('change', e => {
            localStorage.setItem(LS.lang, e.target.value);
            injectPrompts();
            renderAll();
        });
        document.getElementById('ht-set-era')?.addEventListener('change', e => {
            localStorage.setItem(LS.era, e.target.value);
            const row = document.getElementById('ht-row-faith');
            if (row) row.style.display = e.target.value === 'modern' ? '' : 'none';
            rebuildCalendar();
        });
        document.getElementById('ht-set-faith')?.addEventListener('change', e => {
            localStorage.setItem(LS.faith, e.target.value);
            rebuildCalendar();
        });
        document.getElementById('ht-set-prev')?.addEventListener('change', e => {
            localStorage.setItem(LS.showPrev, e.target.checked ? 'true' : 'false');
            renderAll();
        });
    }, 250);
}

// ═══════════════════════════════════════════════════════════════
// СОБЫТИЯ
// ═══════════════════════════════════════════════════════════════
let generating = false;

function onGenerationStarted(type, params, dryRun) {
    if (dryRun) return;
    generating = true;
    if (!isEnabled()) return;
    if (!state) loadState();
    injectPrompts();
}

function onMessageReceived(id) {
    if (!isEnabled()) return;
    if (!state) loadState();
    processReply(Number(id));
}

function onMessageSwiped(id) {
    if (!isEnabled() || !state) return;
    setTimeout(() => {
        if (generating) return;
        const m = chat[id];
        if (!m || m.is_user) return;
        const sw = m.swipes?.[m.swipe_id];
        if (sw && sw.trim() && m.mes === sw && state.snapshots.some(s => s.beforeMsg === Number(id))) processReply(Number(id));
        else scheduleRenderAll();
    }, 150);
}

function onMessageEdited(id) {
    if (!isEnabled() || !state) return;
    const m = chat[id];
    if (m && !m.is_user && Number(id) === lastProcessedMsg()) processReply(Number(id));
    else scheduleRenderAll();
}

function onMessageDeleted() {
    if (!isEnabled() || !state) return;
    const len = chat.length;
    const affected = state.snapshots.filter(s => s.beforeMsg >= len).sort((a, b) => a.beforeMsg - b.beforeMsg);
    if (affected.length) {
        restoreSnapshot(affected[0]);
        state.snapshots = state.snapshots.filter(s => s.beforeMsg < len);
        saveState();
        injectPrompts();
    }
    scheduleRenderAll();
}

function onChatChanged() {
    ui.open.clear();
    loadState();
    injectPrompts();
    for (const ms of [150, 600, 1500]) setTimeout(renderAll, ms);
}

// Таверна дорисовывает сообщения позже событий — следим за самим #chat
let chatObserver = null;
function observeChat() {
    const target = document.getElementById('chat');
    if (!target) { setTimeout(observeChat, 500); return; }
    if (chatObserver) return;
    // Следим и за новыми сообщениями, и за перерисовкой текста внутри них: другие
    // расширения могут переписать текст ответа и стереть инфоблок (особенно в середине)
    chatObserver = new MutationObserver((muts) => {
        let changed = false;
        for (const m of muts) {
            const t = m.target;
            if (t.nodeType === 1 && t.closest?.('.ht-ib')) continue;          // наши собственные изменения
            const nodes = [...m.addedNodes, ...m.removedNodes];
            if (nodes.length && nodes.every(n => n.nodeType === 1 && n.classList?.contains('ht-ib'))) continue;
            changed = true;
            break;
        }
        if (changed) scheduleEnsure();
    });
    chatObserver.observe(target, { childList: true, subtree: true });
}

// Вернуть инфоблоки, которые кто-то стёр (во время генерации не трогаем — текст ещё пишется)
let ensureTimer = null;
function scheduleEnsure() {
    clearTimeout(ensureTimer);
    ensureTimer = setTimeout(ensureBlocks, 150);
}
function ensureBlocks() {
    if (!isEnabled() || generating) return;
    if (!state && chat.length) loadState();
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const id = Number(el.getAttribute('mesid'));
        const has = el.querySelector('.ht-ib');
        if (shouldShow(id) && !has) renderBlock(id);
    });
}

function on(evt, fn) { if (evt) eventSource.on(evt, fn); }

function init() {
    injectSettingsPanel();
    loadState();
    injectPrompts();
    on(event_types.GENERATION_STARTED, onGenerationStarted);
    on(event_types.GENERATION_ENDED, () => { generating = false; scheduleEnsure(); });
    on(event_types.GENERATION_STOPPED, () => { generating = false; scheduleEnsure(); });
    on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onAfterCombinePrompts);
    on(event_types.CHARACTER_MESSAGE_RENDERED, scheduleRenderAll);
    on(event_types.USER_MESSAGE_RENDERED, scheduleRenderAll);
    on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    on(event_types.MESSAGE_EDITED, onMessageEdited);
    on(event_types.MESSAGE_UPDATED, scheduleRenderAll);
    on(event_types.MESSAGE_DELETED, onMessageDeleted);
    on(event_types.MORE_MESSAGES_LOADED, scheduleRenderAll);
    on(event_types.CHAT_CHANGED, onChatChanged);
    observeChat();
    for (const ms of [300, 1000]) setTimeout(renderAll, ms);
}

jQuery(() => init());
