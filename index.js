// Hearthtide — index.js
// Праздники, которые живут в ролплее: календарь эпохи, подготовка, сам праздник с утра до ночи.
// Всё через инджект: ИИ пишет скрытые теги, расширение считает дни и хранит память.

import {
    chat, chat_metadata, this_chid, characters,
    setExtensionPrompt, extension_prompt_types, extension_prompt_roles,
    saveChatDebounced, name1,
} from '../../../../script.js';
import { eventSource, event_types } from '../../../../scripts/events.js';

import { dayPart, plural, parseDate, fromDayNum, isoOf, dayNum } from './dates.js';
import { parseSmall, parseCalendar, parsePrep, parseDay, parseRecap, parsePeople, parseEvents, parseOffers, parseBeat, stripBlocks } from './tag.js';
import { phaseOf, requestFor, mentionEvery, holidayId, allHolidays, banKeys, isBanned, namesMatch, passedThisYear, hasGifts, openEvent, OPEN_STATUSES, sideNeeds, sideDue } from './calendar.js';
import { buildStatePrompt, buildTagPrompt, buildSideMessages } from './prompts.js';
import { listProfiles, gatherSources, sendSide, reasonOf } from './side.js';
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
    api: 'hearthtide_api',             // профиль подключения для отдельного запроса: auto — тот, что выбран в таверне
    depth: 'hearthtide_depth',         // сколько последних сообщений читает отдельный запрос
    eraMap: 'hearthtide_era_map',      // эпоха и вера — отдельно для каждого персонажа или группы
};
const lsGet = (k, d) => { const v = localStorage.getItem(k); return v === null ? d : v; };
const isEnabled = () => lsGet(LS.enabled, 'true') !== 'false';
const position = () => lsGet(LS.position, 'bottom');
const showPrev = () => lsGet(LS.showPrev, 'true') !== 'false';
// Профиль: по умолчанию тот, что сейчас выбран в таверне. Профилей нет вовсе — работаем по-старому, через инджект
const apiChoice = () => lsGet(LS.api, 'auto');
function apiProfile() {
    const v = apiChoice();
    if (v !== 'auto') return v;
    return globalThis.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.selectedProfile || '';
}
const apiOn = () => isEnabled() && !!apiProfile();
const sideDepth = () => Number(lsGet(LS.depth, '10')) || 10;

// ─── Эпоха и вера запоминаются для каждого персонажа (и группы) ───
function charKey() {
    const gid = globalThis.SillyTavern?.getContext?.()?.groupId;
    if (gid) return `g:${gid}`;
    const ch = this_chid !== undefined ? characters[this_chid] : null;
    return ch?.avatar ? `c:${ch.avatar}` : null;
}
function eraMap() {
    try { return JSON.parse(localStorage.getItem(LS.eraMap) || '{}') || {}; } catch (e) { return {}; }
}
function setCharSetting(field, value) {
    const key = charKey();
    if (!key) { localStorage.setItem(field === 'era' ? LS.era : LS.faith, value); return; }
    const map = eraMap();
    map[key] = { ...(map[key] || {}), [field]: value };
    localStorage.setItem(LS.eraMap, JSON.stringify(map));
}
const eraMode = () => eraMap()[charKey()]?.era || lsGet(LS.era, 'ancient');
const faithMode = () => eraMap()[charKey()]?.faith || lsGet(LS.faith, 'faith');
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
        activeHid: null,        // праздник, к которому относятся люди и мысли персонажа
        highlights: {},         // hid → [{ name, text }] — кто чем отличился, помним до конца праздника
        backoff: {},            // тип запроса → ход, до которого его не повторяем (ИИ проигнорировал)
        evts: [],               // ивенты и мероприятия: { id, hid, kind, title, who, status, turn, lastUpdate, note, moments }
        lastEventEnd: -99,
        flashbacks: [],         // воспоминания: { id, title, text, when, kind } — в контекст только по кнопке
        recall: null,           // id воспоминания, которое уйдёт в следующий ответ
        planPart: {},           // `${hid}#${день}` → часть дня, к которой распорядок уже подстроен
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
        offers: [],             // поводы из истории, ждут решения игрока: { id, cause, name, start, days, meaning, type, prep, turn }
        offerNo: [],            // названия отклонённых поводов — больше не предлагаем
        bdayAsked: false,       // дни рождения {{user}} и {{char}} уже спрашивали: нет в карточке — не выдумываем
        diag: null,             // почему нет календаря: notag | nocal | lang
        diagNames: [],          // что пришло не на том языке — показать игроку
        calMiss: 0,             // сколько раз подряд ИИ пропустил календарь
        yearLog: null,          // текущий год: { y, from, items: [{ id, name, birthday, who, type, start, days, kept }] }
        lived: {},              // hid → true: история застала этот праздник (не перепрыгнула скипом)
        skipFrom: null,         // день, с которого время прыгнуло далеко вперёд — спросить, какие праздники проскочили
        beat: null,             // что праздник может принести в следующий ответ (от отдельного запроса)
        beatLog: [],            // последние такие подсказки — чтобы не повторялись
        lastSideTurn: -99,      // когда отдельный запрос последний раз дошёл
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
    // старые итоги праздников → в воспоминания
    if (!state.flashbacks.length && state.recaps?.length) {
        state.flashbacks = state.recaps.map((r, i) => ({ id: `fb-old-${i}`, title: r.name, text: r.text, when: null, kind: 'holiday' }));
    }
    // место, сохранённое вместе с английским словом-типом («settlement Деревня Березовка»)
    if (state.place) state.place = tidyPlace(state.place);
    if (state.setting?.place) state.setting.place = tidyPlace(state.setting.place);
}

// ИИ иногда пишет тип места словом из промпта на другом языке: «settlement Деревня Березовка» → «Деревня Березовка»
function tidyPlace(v) {
    const s = String(v ?? '').trim();
    const m = langMode() === 'en'
        ? s.match(/^[а-яё][а-яё' -]*?\s+(?=[a-z])/i)
        : s.match(/^[a-z][a-z' -]*?\s+(?=[а-яё])/i);
    return m ? s.slice(m[0].length) : s;
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
        calMiss: state.calMiss || 0,
        // игрок переименовал праздник в другой — ИИ дописывает новый смысл
        meaningFor: (state.holidays || []).find(h => h.needMeaning && !isBanned(state, h.name))?.name || null,
        // чтобы ИИ не предлагал одно и то же: ждущие решения и недавно отклонённые
        // скип: какие праздники проскочили; и что в этом году уже было — только для запроса календаря
        skipGap: state.skipFrom != null && state.today != null
            ? { from: isoOf(Math.max(state.skipFrom, state.yearLog?.y === fromDayNum(state.today).y ? state.yearLog.from : dayNum(fromDayNum(state.today).y, 1, 1))), to: isoOf(state.today - 1) } : null,
        passed: (state.yearLog?.items || []).filter(i => !i.birthday && i.name && !isBanned(state, i.name)).slice(-10).map(i => i.name),
        offerNames: [...(state.offers || []).map(o => o.name), ...(state.offerNo || []).slice(-2)].slice(0, 4),
        peopleSeen: peopleSeen(),
        eraMode: eraMode(),
        api: apiOn(),
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
const USER_FIELDS = ['banned', 'bannedNames', 'birthdayOff', 'calIgnore', 'offerNo'];

function restoreSnapshot(snap) {
    const keep = state.snapshots;
    const user = Object.fromEntries(USER_FIELDS.map(k => [k, clone(state[k] ?? null)]));
    Object.assign(state, clone(snap.data));
    for (const [k, v] of Object.entries(user)) if (v != null) state[k] = v;
    state.snapshots = keep;
    // удалённые игроком праздники не возвращаются вместе со старым снимком
    state.holidays = (state.holidays || []).filter(h => !isBanned(state, h.name));
    // и решённые поводы тоже: отклонённые и уже принятые
    state.offers = (state.offers || []).filter(o => !offerKnown(o));
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

// ─── Был ли человек в ролплее: имя в последних сообщениях (с учётом падежей) ───
function recentStoryText(n = 8) {
    return chat.slice(-n).filter(m => m?.mes && !m.is_system)
        .map(m => String(m.mes).replace(/<!--[\s\S]*?-->/g, ' '))
        .join(' ').toLowerCase().replace(/ё/g, 'е');
}
function nameStem(name) {
    // «бабка Агафья» → по последнему слову; «Любава» → «люба» (ловит Любаву, Любавы)
    const words = String(name || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(w => w.length >= 3);
    const w = words[words.length - 1] || '';
    return w.length > 4 ? w.slice(0, w.length - 2) : w;
}
function seenInStory(name, text) {
    const st = nameStem(name);
    return !!st && new RegExp(`(?<![\\p{L}])${st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(text);
}
/** Люди, которые действительно есть в последних сообщениях — только их показываем и отправляем ИИ */
function peopleSeen() {
    const text = recentStoryText(6);
    return (state.people || []).filter(p => seenInStory(p.name, text));
}

// ─── Воспоминания ───
function addFlashback(title, text, kind) {
    state.flashbacks.push({ id: `fb-${state.turn}-${state.flashbacks.length}`, title, text, when: state.when, kind });
    if (state.flashbacks.length > 40) state.flashbacks = state.flashbacks.slice(-40);
}

// ─── Ивенты: появились, идут, закончились ───
function processEvents(phase, small, evs) {
    const today = phase.kind === 'today' && phase.h ? phase.h.id : null;
    // ивенты прошлого праздника, которые так и не закрылись, — забылись
    for (const e of state.evts) {
        if (OPEN_STATUSES.includes(e.status) && e.hid !== today) e.status = 'faded';
    }
    if (!today) return;
    let ev = openEvent(state, today);

    // Статус от ИИ
    if (ev && small?.ev) {
        const note = small.evNote && langOk(small.evNote) ? small.evNote : null;
        if (ev.status === 'invited' && (small.ev === 'joined' || small.ev === 'declined')) {
            ev.status = small.ev;
            ev.lastUpdate = state.turn;
            if (small.ev === 'declined') state.lastEventEnd = state.turn;
        } else if (small.ev === 'done' || small.ev === 'skipped') {
            ev.status = small.ev;
            ev.note = note;
            state.lastEventEnd = state.turn;
            if (small.ev === 'done' && note) addFlashback(ev.title, note, ev.kind);
        }
        ev = openEvent(state, today);
    }
    // Новые ивенты и моменты
    for (const e of evs || []) {
        if (!langOk(e.title)) continue;
        if (e.kind === 'moment') {
            if (ev?.kind === 'party' && ev.status === 'joined') {
                ev.moments = ev.moments || [];
                if (!ev.moments.some(m => m.title === e.title)) ev.moments.push({ title: e.title, turn: state.turn });
                if (ev.moments.length > 8) ev.moments = ev.moments.slice(-8);
                ev.lastMoment = state.turn;
                ev.lastUpdate = state.turn;
            }
            continue;
        }
        if (ev) continue;   // одновременно — только одно событие
        ev = {
            id: `ev-${state.turn}`, hid: today, kind: e.kind, title: e.title, who: e.who,
            status: e.kind === 'party' ? 'invited' : 'active', turn: state.turn, lastUpdate: state.turn, note: null, moments: [],
        };
        state.evts.push(ev);
    }
    // Забытые: ИИ долго не закрывает — тихо закрываем
    for (const e of state.evts) {
        if (!OPEN_STATUSES.includes(e.status)) continue;
        const idle = state.turn - (e.lastUpdate ?? e.turn);
        if ((e.status === 'invited' && idle > 6) || (e.status === 'active' && idle > 8) || (e.status === 'joined' && idle > 25)) {
            e.status = e.status === 'invited' ? 'missed' : 'faded';
            state.lastEventEnd = state.turn;
        }
    }
    if (state.evts.length > 30) state.evts = state.evts.slice(-30);
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
    // какой запрос ИИ видел в промпте этого ответа — чтобы не повторять проигнорированный каждый ход
    // (с отдельным запросом основную модель ни о чём не просим)
    const asked = apiOn() ? null : requestFor(state, phaseOf(state));
    state.turn += 1;
    state.beat = null;      // подсказка ушла в этот ответ

    // Крупные блоки после первого разбора вырезаются из текста и живут в extra —
    // при свайпе назад или повторной обработке берём их оттуда
    let text = msg.mes;
    const saved = msg.extra?.ht_raw;
    const source = saved && saved.hash === hashText(text) ? saved.raw : text;

    // Модели с «думалкой» иногда пишут теги в рассуждениях, а в ответ не переносят — тогда берём оттуда
    const think = String(msg.extra?.reasoning || '');
    const fromThink = !/<!--\s*HT/i.test(source) && /<!--\s*HT/i.test(think);
    const src = fromThink ? think : source;

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

    // Ответ отдельного запроса к этому тексту (если уже пришёл): те же блоки, читаем вместе с ответом
    const sideRec = apiOn() ? msg.extra.ht_side?.[hashText(text)] || null : null;
    const sideText = sideRec?.text || '';
    const sideAsked = sideRec?.asked || [];
    const askedCal = asked === 'cal' || sideAsked.includes('cal');
    const both = (fn) => fn(src) ?? (sideText ? fn(sideText) : null);
    const small = parseSmall(src);
    const sideSmall = sideText ? parseSmall(sideText, 'HT-S') : null;
    // поля о персонаже, подарке, ивенте и смысле — из ответа или из отдельного запроса
    const sm = small || sideSmall ? {
        ...(small || {}),
        ...Object.fromEntries(Object.entries(sideSmall || {}).filter(([k, v]) => v != null && v !== false && !['inner', 'date', 'clock', 'when', 'place'].includes(k))),
    } : null;
    const calRaw = (state.calIgnore || []).includes(hashText(src)) ? null : parseCalendar(src);
    const calSide = sideText && !(state.calIgnore || []).includes(hashText(sideText)) ? parseCalendar(sideText) : null;
    const cal = calRaw || calSide;
    const prep = both(parsePrep);
    const day = both(parseDay);
    const recap = both(parseRecap);
    const people = both(parsePeople);
    const evs = [...parseEvents(src), ...(sideText ? parseEvents(sideText) : [])];
    const offersIn = [...parseOffers(src), ...(sideText ? parseOffers(sideText) : [])];
    const beat = sideText ? parseBeat(sideText) : null;
    // Строки H, пришедшие без запроса календаря, — тоже повод из истории: решает игрок
    if (cal && !askedCal && !cal.setting && cal.holidays.length) {
        offersIn.push(...cal.holidays.map(h => ({ ...h, cause: null })));
        cal.holidays = [];
    }
    if (sideRec) state.lastSideTurn = state.turn;
    if (beat && !/^none\b/i.test(beat)) {
        state.beat = beat;
        state.beatLog = [...(state.beatLog || []), beat].slice(-3);
    }

    // ── Дата, время, место ──
    let slip = false;
    const prevToday = state.today;
    if (small) {
        state.missed = 0;
        // Скип через несколько дней: праздники внутри скипа молча пропускаем (без итога)
        if (small.date != null && state.today != null && small.date - state.today > 1) {
            for (const h of allHolidays(state)) {
                const end = h.start + h.days - 1;
                if (end >= state.today && end < small.date) state.recapDone[h.id] = true;
            }
            // Большой скип: календарь знает только ближайшие праздники — спросим, какие ещё проскочили
            if (small.date - state.today > 14) {
                if (state.skipFrom == null) state.skipFrom = state.today + 1;
                state.forceCal = true;
            }
        }
        if (small.date != null) state.today = small.date;
        if (small.clock != null) state.clock = small.clock;
        slip = slip || !langOk(small.when) || !langOk(small.place);
        if (small.when && langOk(small.when)) state.when = small.when;
        if (small.place && langOk(small.place)) state.place = tidyPlace(small.place);
    } else {
        state.missed = (state.missed || 0) + 1;
    }

    // ── Календарь ──
    if (cal) {
        const before = cal.holidays.length;
        const wrong = cal.holidays.filter(h => !langOk(h.name)).map(h => h.name);
        cal.holidays = cal.holidays.filter(h => langOk(h.name));
        if (before && !cal.holidays.length) {                        // календарь пришёл, но весь не на том языке
            state.diag = 'lang';
            state.diagNames = wrong.slice(0, 4);
        }
        if (cal.holidays.length < before) slip = true;
        if (cal.setting) {
            for (const k of ['era', 'faith', 'place']) if (cal.setting[k] && !langOk(cal.setting[k])) { cal.setting[k] = null; slip = true; }
            state.setting = { ...(state.setting || {}), ...Object.fromEntries(Object.entries(cal.setting).filter(([, v]) => v)) };
            if (cal.setting.place) state.place = state.setting.place = tidyPlace(cal.setting.place);
        }
        mergeHolidays(cal.holidays);
        for (const [who, md] of Object.entries(cal.birthdays)) state.birthdays[who] = md;
        state.forceCal = false;
        if (askedCal) state.bdayAsked = true;       // не прислал строку B — дня рождения не знаем, не переспрашиваем
        if (cal.passed.some(x => !langOk(x.name))) slip = true;
        logSkipped(cal.passed.filter(x => langOk(x.name)));
        state.skipFrom = null;
    }
    // Прошедшие праздники — в «Текущий год» (до того, как старые уйдут из календаря)
    logPast();
    pruneHolidays();
    // ── Новый смысл переименованного праздника ──
    if (sm?.mean) {
        const target = state.holidays.find(h => h.needMeaning && !isBanned(state, h.name));
        if (target && langOk(sm.mean)) { target.meaning = sm.mean; delete target.needMeaning; }
        else if (target) slip = true;
    }
    // ── Поводы из истории — ждут решения игрока ──
    if (takeOffers(offersIn)) slip = true;

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
        const hid = phase.h.id;
        // Отыгравшие своё — в «отличились» (одна строка на человека, новая заменяет старую)
        const recent = recentStoryText(10);
        const doneLang = people.done.filter(d => langOk(d.text));
        if (doneLang.length < people.done.length) slip = true;
        const doneOk = doneLang.filter(d => seenInStory(d.name, recent));   // выдуманные не принимаем
        if (doneOk.length) {
            const hl = state.highlights[hid] || (state.highlights[hid] = []);
            for (const d of doneOk) {
                const i = hl.findIndex(x => x.name.toLowerCase() === d.name.toLowerCase());
                if (i >= 0) hl[i] = d; else hl.push(d);
            }
            if (hl.length > 8) state.highlights[hid] = hl.slice(-8);
        }
        const doneNames = new Set(doneOk.map(d => d.name.toLowerCase()));
        const active = people.active.filter(p => !doneNames.has(p.name.toLowerCase()));
        const ok = active.filter(p => langOk(p.now) && langOk(p.gift));
        if (ok.length < active.length) slip = true;
        state.people = ok;
        state.lastPeopleTurn = state.turn;
    }
    // Мысль/действие персонажа и его подарок — из маленького тега
    if (sm && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        if (sm.char) {
            if (langOk(sm.char)) {
                state.charNow = { hid: phase.h.id, text: sm.char, turn: state.turn };
                const log = state.charLog[phase.h.id] || (state.charLog[phase.h.id] = []);
                if (log[log.length - 1]?.text !== sm.char) log.push({ text: sm.char, turn: state.turn });
                if (log.length > 6) state.charLog[phase.h.id] = log.slice(-6);
            }
            else slip = true;
        }
        if (sm.gift || sm.giftDone) {
            if (sm.gift && !langOk(sm.gift)) slip = true;
            const prev = state.charGift?.hid === phase.h.id ? state.charGift : null;
            state.charGift = {
                hid: phase.h.id,
                text: sm.gift && langOk(sm.gift) ? sm.gift : prev?.text || null,
                done: !!(sm.giftDone || prev?.done),
            };
        }
    }
    if (day && phase.kind === 'today' && ['title', 'morning', 'day', 'evening', 'night'].some(k => day[k] && !langOk(day[k]))) { slip = true; }
    else if (day && phase.kind === 'today') {
        // Распорядок дополняется: пришедшие части заменяют старые, прошедшие остаются
        const key = `${phase.h.id}#${phase.dayIndex}`;
        const prevPlan = state.days[key] || {};
        for (const k of Object.keys(day)) if (day[k] == null) delete day[k];
        Object.assign(day, { ...prevPlan, ...day });
        state.planPart[key] = dayPart(state.clock) || 'morning';
        state.days[`${phase.h.id}#${phase.dayIndex}`] = day;
    }
    if (recap && !langOk(recap)) slip = true;
    if (recap && phase.ended && langOk(recap)) {
        addFlashback(displayName(phase.ended), recap, 'holiday');
        state.recaps.push({ hid: phase.ended.id, name: displayName(phase.ended), text: recap });
        if (state.recaps.length > 30) state.recaps = state.recaps.slice(-30);
        state.recapDone[phase.ended.id] = true;
    }
    // ── Ивенты и мероприятия ──
    processEvents(phase, sm, evs);
    // Проигнорированные запросы повторяем не сразу, а через несколько ответов
    const answered = { cal: !!cal, day: !!day, prep: !!prep, people: !!people, recap: !!recap };
    const WAIT = { cal: 2, day: 1, prep: 3, people: 3, recap: 1 };
    state.backoff = state.backoff || {};
    if (asked in WAIT) {
        if (answered[asked]) delete state.backoff[asked];
        else state.backoff[asked] = state.turn + WAIT[asked];
    }
    // Календарь — основа всего: пропущенный переспрашиваем сразу, настойчивее и короче; пауза — только после трёх пропусков подряд
    if (asked === 'cal') {
        state.calMiss = cal ? 0 : (state.calMiss || 0) + 1;
        if (!cal && state.calMiss < 3) delete state.backoff.cal;
    }
    if (asked === 'event' && !evs.some(e => e.kind !== 'moment')) state.lastEventEnd = state.turn - 1;
    if (asked === 'moment' && !evs.some(e => e.kind === 'moment') && phase.h) {
        const ev = openEvent(state, phase.h.id);
        if (ev) ev.lastMoment = state.turn - 1;
    }
    if (asked === 'replan' && !day && phase.kind === 'today' && phase.h) {
        state.planPart[`${phase.h.id}#${phase.dayIndex}`] = dayPart(state.clock) || 'morning';
    }
    // воспоминание по кнопке ушло в этот ответ — больше не повторяем
    if (state.recall) {
        const fb = state.flashbacks.find(f => f.id === state.recall);
        if (fb) fb.recalled = (fb.recalled || 0) + 1;
        state.recall = null;
    }

    phase = phaseOf(state);
    // история застала праздник — в «Текущем году» он будет отмеченным, а не прошедшим мимо
    if (phase.kind === 'today' && phase.h) state.lived[phase.h.id] = true;
    if (small || cal || prep || people || day || recap || offersIn.length) state.langSlip = slip;
    // Праздник сменился или был скип на несколько дней — люди и мысли прошлого праздника больше не актуальны
    const curHid = phase.h && (phase.kind === 'prep' || phase.kind === 'today') ? phase.h.id : null;
    const jumped = prevToday != null && state.today != null && state.today - prevToday > 1;
    if (curHid !== state.activeHid || jumped) {
        if (!people) {                       // свежий список, пришедший в этом же ответе, не трогаем
            state.people = [];
            state.lastPeopleTurn = -99;
        }
        if (state.charNow?.hid !== curHid) state.charNow = null;
        state.activeHid = curHid;
    }
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
    // Почему нет праздников — подсказка в инфоблоке, чтобы было видно, чья это проблема
    if (!small) state.diag = 'notag';
    else if (cal && cal.holidays.length) state.diag = null;
    else if (askedCal && !cal) state.diag = 'nocal';                          // просили календарь — не прислал
    else if (state.diag === 'notag') state.diag = null;
    state.diagThink = fromThink;

    msg.extra.ht = viewSnapshot(phase);

    saveState();
    injectPrompts();
    scheduleRenderAll();
}

// ─── Текущий год: все прошедшие праздники, отмеченные и прошедшие мимо ───
// Хранится только в состоянии; в инджект не идёт. Новый год — чистый лист.
function ensureYear() {
    if (state.today == null) return null;
    const y = fromDayNum(state.today).y;
    if (state.yearLog?.y !== y) {
        const prev = state.yearLog;
        // год сменился по ходу истории — с 1 января; первый год истории — с её первого дня
        state.yearLog = { y, from: prev && prev.y < y ? dayNum(y, 1, 1) : state.today, items: [] };
        state.lived = {};
    }
    return state.yearLog;
}

function logItem(log, it) {
    if (fromDayNum(it.start).y !== log.y || it.start < log.from) return;
    const same = log.items.find(i => i.id === it.id
        || (!i.birthday && !it.birthday && namesMatch(i.name, it.name) && Math.abs(i.start - it.start) <= 3)
        || (i.birthday && it.birthday && i.who === it.who));
    if (same) { same.kept = same.kept || it.kept; return; }
    log.items.push(it);
    log.items.sort((a, b) => a.start - b.start);
    if (log.items.length > 40) log.items = log.items.slice(-40);
}

function logPast() {
    const log = ensureYear();
    if (!log) return;
    const list = allHolidays(state);
    // дни рождения этого года, которые скип мог перепрыгнуть (в календаре их уже нет)
    for (const who of ['user', 'char']) {
        const md = state.birthdays?.[who];
        if (!md || state.birthdayOff?.[who]) continue;
        const h = { start: dayNum(log.y, md.m, md.d), days: 1, name: null, who, birthday: true, type: 'personal' };
        h.id = holidayId(h);
        if (!list.some(x => x.id === h.id)) list.push(h);
    }
    for (const h of list) {
        if (h.start + h.days - 1 >= state.today) continue;
        logItem(log, { id: h.id, name: h.name, birthday: !!h.birthday, who: h.who, type: h.type, start: h.start, days: h.days, kept: !!state.lived?.[h.id] });
    }
}

/** Праздники, которые проскочил скип, — со слов ИИ (строки X календаря) */
function logSkipped(list) {
    const log = ensureYear();
    if (!log) return;
    for (const x of list || []) {
        if (x.start >= state.today || isBanned(state, x.name) || birthdayOwner(x.name)) continue;
        logItem(log, { id: holidayId({ name: x.name, start: x.start }), name: x.name, birthday: false, type: x.type, start: x.start, days: 1, kept: false });
    }
}

// ─── Поводы из истории: ИИ предлагает, игрок решает ───
/** Повод уже не нужен: отклонён, удалён или такой праздник уже в календаре */
function offerKnown(o) {
    if (passedThisYear(state, o.name, o.start)) return true;
    if (isBanned(state, o.name) || (state.offerNo || []).some(n => namesMatch(n, o.name))) return true;
    return (state.holidays || []).some(h => namesMatch(h.name, o.name) && Math.abs(h.start - o.start) <= 30);
}

/** Принять новые поводы из ответа; вернуть true, если что-то пришло не на том языке */
function takeOffers(list) {
    let slip = false;
    state.offers = state.offers || [];
    for (const o of list || []) {
        if (![o.name, o.meaning, o.cause].every(langOk)) { slip = true; continue; }
        if (state.today != null && (o.start < state.today || o.start - state.today > 180)) continue;
        const owner = birthdayOwner(o.name);
        if (owner && (state.birthdays?.[owner] || state.birthdayOff?.[owner])) continue;   // уже известен или удалён игроком
        if (owner) o.bday = owner;                                                         // день рождения узнали из истории
        if (offerKnown(o)) continue;
        if (state.offers.some(x => namesMatch(x.name, o.name))) continue;
        state.offers.push({ ...o, id: `of-${state.turn}-${Date.now().toString(36)}-${state.offers.length}`, turn: state.turn });
    }
    // устаревшие: дата прошла, игрок давно не решает
    state.offers = state.offers
        .filter(o => !offerKnown(o) && (state.today == null || o.start >= state.today) && state.turn - o.turn <= 20)
        .slice(-3);
    return slip;
}

const dropOfferIn = (st, oid) => { st.offers = (st.offers || []).filter(o => o.id !== oid); };

/** Игрок принял повод (возможно, поправив его) — праздник в календаре, переживает свайпы и «подобрать заново» */
function acceptOffer(oid, edit = null) {
    const o = (state.offers || []).find(x => x.id === oid);
    if (!o) return false;
    let start = o.start;
    if (edit) {
        start = parseDate(edit.date);
        if (start == null) { window.toastr?.warning?.(L().badDate, 'Hearthtide'); return false; }
    }
    const toBday = String(edit?.type || '').startsWith('bday_') ? edit.type.slice(5) : (!edit?.type && o.bday) || null;
    if (toBday) {
        const md = fromDayNum(start);
        const apply = (st) => {
            st.birthdays = { ...(st.birthdays || {}), [toBday]: { ...(st.birthdays?.[toBday] || {}), m: md.m, d: md.d } };
            if (st.birthdayOff) delete st.birthdayOff[toBday];
            dropOfferIn(st, oid);
        };
        apply(state);
        applyToSnapshots(apply);
    } else {
        const name = String(edit?.name || '').trim() || o.name;
        const meanIn = edit ? String(edit.meaning ?? '').trim() : null;
        const h = { start, days: o.days, name, type: edit?.type || o.type, prep: o.prep, edited: true, story: true };
        if (meanIn && meanIn !== (o.meaning || '')) h.meaning = meanIn;              // игрок сам написал смысл
        else if (namesMatch(name, o.name)) h.meaning = o.meaning;
        else { h.meaning = null; h.needMeaning = true; }                             // переименовал в другое — смысл допишет ИИ
        // игрок явно хочет этот праздник — снимаем с него старый запрет
        const keys = banKeys(name);
        state.banned = state.banned.filter(b => !keys.includes(b));
        state.bannedNames = state.bannedNames.filter(n => !namesMatch(n, name));
        const id = holidayId(h);
        const apply = (st) => {
            st.holidays = st.holidays || [];
            if (!st.holidays.some(x => holidayId(x) === id)) st.holidays.push(clone(h));
            st.holidays.sort((a, b) => a.start - b.start);
            dropOfferIn(st, oid);
        };
        apply(state);
        applyToSnapshots(apply);
    }
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().offerAdded, 'Hearthtide');
    return true;
}

/** Игрок отклонил повод — больше его не предлагаем */
function declineOffer(oid) {
    const o = (state.offers || []).find(x => x.id === oid);
    if (!o) return;
    state.offerNo = [...(state.offerNo || []).filter(n => !namesMatch(n, o.name)), o.name].slice(-30);
    dropOfferIn(state, oid);
    applyToSnapshots(st => dropOfferIn(st, oid));
    saveState();
    injectPrompts();
    window.toastr?.info?.(L().offerDropped, 'Hearthtide');
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
        if (isBanned(state, h.name) || passedThisYear(state, h.name, h.start)) continue;
        const owner = birthdayOwner(h.name);
        if (owner) {
            if (!state.birthdays[owner]) {
                const d = new Date(h.start * 86400000);
                state.birthdays[owner] = { m: d.getUTCMonth() + 1, d: d.getUTCDate(), prep: h.prep ?? null };
            }
            continue;
        }
        // праздник, который игрок поправил руками, календарь ИИ не перезаписывает
        if (state.holidays.some(x => x.edited && (holidayId(x) === holidayId(h) || (namesMatch(x.name, h.name) && Math.abs(x.start - h.start) <= 30)))) continue;
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
    for (const k of Object.keys(state.highlights || {})) {
        if (!state.holidays.some(h => holidayId(h) === k) && !k.startsWith('bday-')) delete state.highlights[k];
    }
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
            // идущий сегодня праздник и принятые игроком поводы из истории оставляем, остальные будущие — убираем
            st.holidays = (st.holidays || []).filter(h => h.story || (h.start <= st.today && h.start + h.days - 1 >= st.today));
        } else {
            st.holidays = (st.holidays || []).filter(h => h.story);
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
        const raws = [m?.extra?.ht_raw?.raw, ...Object.values(m?.extra?.ht_side || {}).map(x => x?.text)];
        for (const raw of raws) {
            if (!raw || !/HT-CAL/i.test(raw)) continue;
            const hsh = hashText(raw);
            if (!state.calIgnore.includes(hsh)) state.calIgnore.push(hsh);
        }
    }
    if (state.calIgnore.length > 200) state.calIgnore = state.calIgnore.slice(-200);
    saveState();
    injectPrompts();
    renderAll();
    window.toastr?.info?.(apiOn() ? L().rebuildToastApi : L().rebuildToast, 'Hearthtide');
    if (apiOn()) maybeSide(lastProcessedMsg(), true);
}

// ─── Правка праздника игроком ───
// Праздник опознаётся по «название@дата»: при правке переносим на новое имя всё, что к нему привязано
function renameHidIn(st, oldId, newId) {
    if (oldId === newId) return;
    if (st.prep?.hid === oldId) st.prep.hid = newId;
    for (const k of Object.keys(st.days || {})) {
        if (k.startsWith(`${oldId}#`)) { st.days[k.replace(oldId, newId)] = st.days[k]; delete st.days[k]; }
    }
    for (const k of Object.keys(st.planPart || {})) {
        if (k.startsWith(`${oldId}#`)) { st.planPart[k.replace(oldId, newId)] = st.planPart[k]; delete st.planPart[k]; }
    }
    for (const map of ['charLog', 'highlights', 'care', 'gifts', 'recapDone', 'lived']) {
        if (st[map] && oldId in st[map]) { st[map][newId] = st[map][oldId]; delete st[map][oldId]; }
    }
    if (st.charNow?.hid === oldId) st.charNow.hid = newId;
    if (st.charGift?.hid === oldId) st.charGift.hid = newId;
    for (const e of st.evts || []) if (e.hid === oldId) e.hid = newId;
    if (st.activeHid === oldId) st.activeHid = newId;
}

// Праздник подменили другим: подготовку, распорядок и шаги персонажа ИИ соберёт заново
function forgetHolidayIn(st, id) {
    if (st.prep?.hid === id) st.prep = null;
    for (const map of ['days', 'planPart']) {
        for (const k of Object.keys(st[map] || {})) if (k.startsWith(`${id}#`)) delete st[map][k];
    }
    for (const map of ['charLog', 'care', 'gifts']) if (st[map]) delete st[map][id];
    if (st.charNow?.hid === id) st.charNow = null;
    if (st.charGift?.hid === id) st.charGift = null;
}

function saveHolidayEdit(hid, name, dateStr, type, meaning = null) {
    const h = allHolidays(state).find(x => x.id === hid);
    if (!h) return false;
    const start = parseDate(dateStr);
    if (start == null) { window.toastr?.warning?.(L().badDate, 'Hearthtide'); return false; }
    const md = fromDayNum(start);
    const toBday = String(type || '').startsWith('bday_') ? type.slice(5) : null;

    if (h.birthday || toBday) {
        // день рождения: хранится как «месяц-день» в карточке персонажа
        const who = toBday || h.who;
        const apply = (st) => {
            st.birthdays = { ...(st.birthdays || {}), [who]: { ...(st.birthdays?.[who] || {}), m: md.m, d: md.d } };
            if (st.birthdayOff) delete st.birthdayOff[who];
            if (!h.birthday) st.holidays = (st.holidays || []).filter(x => holidayId(x) !== hid);
        };
        apply(state);
        applyToSnapshots(apply);
        if (!h.birthday) {
            // бывший праздник больше не предлагать
            for (const k of banKeys(h.name)) if (!state.banned.includes(k)) state.banned.push(k);
            if (!state.bannedNames.includes(h.name)) state.bannedNames.push(h.name);
        }
    } else {
        const newName = String(name || '').trim() || h.name;
        const fixed = { start, name: newName, type: type || h.type, edited: true };
        // Другой праздник, а не поправленное название: старый смысл и подготовка к нему больше не подходят
        const other = !namesMatch(h.name, newName);
        const meanIn = meaning == null ? null : String(meaning).trim();
        if (meanIn && meanIn !== (h.meaning || '')) { fixed.meaning = meanIn; fixed.needMeaning = false; }
        else if (other) { fixed.meaning = null; fixed.needMeaning = true; }
        const newId = holidayId({ ...h, ...fixed });
        const apply = (st) => {
            const x = (st.holidays || []).find(y => holidayId(y) === hid);
            if (x) { Object.assign(x, fixed); if (!x.needMeaning) delete x.needMeaning; }
            renameHidIn(st, hid, newId);
            if (other) forgetHolidayIn(st, newId);
            st.holidays?.sort((a, b) => a.start - b.start);
        };
        apply(state);
        applyToSnapshots(apply);
        // переименовали — старое название ИИ больше не предлагает
        if (newName.toLowerCase() !== h.name.toLowerCase()) {
            for (const k of banKeys(h.name)) if (!state.banned.includes(k) && !banKeys(newName).includes(k)) state.banned.push(k);
            if (!state.bannedNames.includes(h.name)) state.bannedNames.push(h.name);
        }
    }
    saveState();
    injectPrompts();
    return true;
}

function savePlaceEdit(value) {
    const v = String(value || '').trim();
    if (!v) return false;
    state.place = v;
    if (state.setting) state.setting.place = v;
    applyToSnapshots(st => { st.place = v; if (st.setting) st.setting.place = v; });
    saveState();
    injectPrompts();
    return true;
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
    if (state.highlights) delete state.highlights[hid];
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
    v.year = (v.year || []).filter(i => !i.raw || !isBanned(state, i.raw));
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
        diag: phase.h ? null : state.diag || null,
        diagNames: phase.h || state.diag !== 'lang' ? [] : state.diagNames || [],
        h: phase.h ? { id: phase.h.id, name: displayName(phase.h), raw: phase.h.name, iso: isoOf(phase.h.start), meaning: phase.h.meaning, type: phase.h.type, days: phase.h.days, birthday: !!phase.h.birthday, who: phase.h.who } : null,
        daysTo: phase.daysTo ?? null,
        dayIndex: phase.dayIndex ?? null,
        plan: phase.kind === 'today' ? planFor(phase.h, phase.dayIndex) : null,
        prep: phase.kind === 'prep' && state.prep?.hid === phase.h?.id ? state.prep : null,
        ended: phase.ended ? { name: displayName(phase.ended), recap: state.recaps.find(r => r.hid === phase.ended.id)?.text || null } : null,
        upcoming: (phase.upcoming || []).filter(x => !phase.h || x.id !== phase.h.id).slice(0, 4)
            .map(x => ({ id: x.id, name: displayName(x), raw: x.name, iso: isoOf(x.start), type: x.type, meaning: x.meaning, daysTo: x.start - state.today, birthday: !!x.birthday, who: x.who })),
        recaps: state.recaps.slice(-3).reverse(),
        year: (state.yearLog?.items || []).map(i => ({
            id: i.id, name: i.birthday ? L().birthday(i.who === 'user' ? getUserName() : getCharName()) : i.name, raw: i.name,
            type: i.birthday ? 'personal' : i.type, iso: isoOf(i.start), kept: i.kept,
            recap: state.recaps.find(r => r.hid === i.id)?.text || null,
        })),
        flashbacks: clone(state.flashbacks.slice(-10).reverse()),
        recall: state.recall,
        ...(() => {
            const act = phase.h && (phase.kind === 'prep' || phase.kind === 'today');
            if (!act) return { people: [], highlights: [], evts: [], care: null, charNow: null, charSteps: [], charGift: null, gifts: false };
            const hid = phase.h.id;
            return {
                people: clone(peopleSeen()),
                care: state.care[hid] || null,
                charNow: state.charNow?.hid === hid ? state.charNow.text : null,
                charSteps: (state.charLog?.[hid] || []).slice(-4, -1).map(x => x.text),
                highlights: clone(state.highlights?.[hid] || []),
                evts: phase.kind === 'today' ? clone(state.evts.filter(e => e.hid === hid)) : [],
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

// ═══════════════════════════════════════════════════════════════
// ОТДЕЛЬНЫЙ ЗАПРОС
// После ответа бота (в подготовке и в праздник — после каждого, издали — изредка)
// одна модель-помощник читает историю и присылает те же блоки. Они ложатся
// в инфоблок этого ответа, а подсказка (BEAT) уходит основной модели в следующий.
// ═══════════════════════════════════════════════════════════════
let side = null;            // { N, hash, ctl } — запрос в пути
let sideFailTurn = -99;

function sideBusyFor(id) { return !!side && side.N === id; }

function cancelSide() {
    if (side) { try { side.ctl.abort(); } catch (e) { /* пусто */ } side = null; scheduleRenderAll(); }
}

/** Решить, нужен ли запрос после ответа N, и отправить */
function maybeSide(N, force = false) {
    if (!apiOn() || !state || generating) return;
    const msg = chat[N];
    if (!msg || msg.is_user || msg.is_system || N !== lastProcessedMsg()) return;
    if (msg.extra?.ht_side?.[hashText(msg.mes)] && !force) return;       // к этому тексту уже есть
    const phase = phaseOf(state);
    const needs = sideNeeds(state, phase);
    if (force) needs.add('new');
    else if (!sideDue(state, phase, needs)) return;
    // после сбоя издалека не долбим: подождём пару ответов (в праздник — пробуем каждый раз)
    if (!force && phase.kind !== 'prep' && phase.kind !== 'today' && (state.turn || 0) - sideFailTurn < 3) return;
    runSide(N, needs);
}

async function runSide(N, needs) {
    cancelSide();
    const ctl = new AbortController();
    const hash = hashText(chat[N].mes);
    const me = { N, hash, ctl };
    side = me;
    scheduleRenderAll();
    const t0 = Date.now();
    try {
        // Тот же профиль, что у основной модели: дадим API передохнуть после ответа, чтобы не упереться в лимит
        const mainProfile = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.connectionManager?.selectedProfile;
        if (apiProfile() === mainProfile) {
            await new Promise(r => setTimeout(r, 2500));
            if (side !== me) return;
        }
        const ctx = ctxFor(null);
        const src = await gatherSources(N, sideDepth());
        const messages = buildSideMessages(ctx, needs, src);
        console.debug('[Hearthtide] отдельный запрос →', [...needs].join(', '), messages);
        const text = await sendSide(apiProfile(), messages, ctl.signal);
        if (side !== me) return;                                        // отменён или заменён новым
        const msg = chat[N];
        if (!msg || hashText(msg.mes) !== hash || N !== lastProcessedMsg()) return;   // текст уже другой
        console.debug(`[Hearthtide] ответ за ${((Date.now() - t0) / 1000).toFixed(1)} с:\n${text}`);
        msg.extra = msg.extra || {};
        const map = msg.extra.ht_side || {};
        map[hash] = { text, asked: [...needs] };
        // храним для нескольких свайпов, не больше
        const keys = Object.keys(map);
        if (keys.length > 4) delete map[keys[0]];
        msg.extra.ht_side = map;
        side = null;
        processReply(N);                // снимок перед N → ответ + блоки отдельного запроса
    } catch (e) {
        if (ctl.signal.aborted || side !== me) return;
        sideFailTurn = state?.turn ?? 0;
        const why = reasonOf(e);
        console.error('[Hearthtide] отдельный запрос не прошёл:', why, e);
        window.toastr?.error?.(`${L().sideFail}: ${why}`, 'Hearthtide', { timeOut: 12000 });
    } finally {
        if (side === me) side = null;
        scheduleRenderAll();
    }
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
const ui = { open: new Map(), confirmDel: null, editing: null, offerSeen: new Set() };

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
    block.innerHTML = headHtml(view, open, live && sideBusyFor(id)) + (live ? offerHtml() : '') + (open ? bodyHtml(view, live) : '');
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

function headHtml(view, open, busy = false) {
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
        // причина, почему праздников нет, — целиком, с переносом строк, и что именно пришло
        sub = view.diag ? L().diag[view.diag] + (view.diagNames?.length ? `. ${L().diagGot}: ${view.diagNames.join(', ')}` : '') : L().soon;
    }
    const icon = h ? TYPE_ICON[h.birthday ? 'personal' : h.type] || 'fa-star' : 'fa-calendar-days';
    return `<div class="ht-head" role="button" tabindex="0" data-act="toggle" aria-expanded="${open}">
        ${ring(view)}
        <span class="ht-head-text">
            <span class="ht-title"><i class="fa-solid ${icon}"></i>${esc(title)}</span>
            ${sub ? `<span class="ht-sub${view.diag && !h ? ' ht-sub-wrap' : ''}">${esc(sub)}</span>` : ''}
        </span>
        ${busy ? `<i class="fa-solid fa-feather-pointed ht-busy" title="${esc(L().sideBusy)}"></i>` : ''}
        <i class="fa-solid fa-chevron-down ht-chev"></i>
    </div>`;
}

// Сворачиваемые разделы; что свёрнуто — помним между перезагрузками
const SEC_KEY = 'hearthtide_sections';
const SEC_DEFAULT_CLOSED = { upcoming: true, memories: true, people: true, year: true };
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

// Форма правки праздника (и повода перед принятием): название, дата, тип, смысл
function editFormHtml(x, act = 'edit-save', label = L().save) {
    const typeOpts = Object.entries(L().types).map(([k, v]) => `<option value="${k}" ${!x.birthday && x.type === k ? 'selected' : ''}>${v}</option>`).join('')
        + ['user', 'char'].map(w => `<option value="bday_${w}" ${x.birthday && x.who === w ? 'selected' : ''}>${esc(L().bdayOf(w === 'user' ? getUserName() : getCharName()))}</option>`).join('');
    return `<div class="ht-edit" data-hid="${esc(x.id)}">
        ${x.birthday ? '' : `<label>${L().fName}<input class="text_pole" data-ed="name" value="${esc(x.raw || x.name)}"></label>`}
        <label>${L().fDate}<input class="text_pole" data-ed="date" value="${esc(x.iso || '')}" inputmode="numeric"></label>
        ${x.birthday ? '' : `<label>${L().fType}<select class="text_pole" data-ed="type">${typeOpts}</select></label>`}
        ${x.birthday ? '' : `<label>${L().fMeaning}<textarea class="text_pole" data-ed="meaning" rows="2">${esc(x.meaning || '')}</textarea></label>`}
        <div class="ht-edit-actions">
            <button class="ht-btn" data-act="edit-cancel">${L().cancel}</button>
            <button class="ht-btn ht-btn-main" data-act="${act}" data-hid="${esc(x.id)}"><i class="fa-solid fa-check"></i>${label}</button>
        </div>
    </div>`;
}

// ─── Повод из истории: под шапкой последнего инфоблока, видно и в свёрнутом ───
function offerHtml() {
    const list = state?.offers || [];
    const o = list[0];
    if (!o) return '';
    if (ui.editing === o.id) {
        return `<div class="ht-offer">${editFormHtml({ id: o.id, raw: o.name, iso: isoOf(o.start), type: o.type, meaning: o.meaning, birthday: !!o.bday, who: o.bday }, 'offer-save', L().accept)}</div>`;
    }
    const d = state.today != null ? o.start - state.today : null;
    const when = d == null ? isoOf(o.start) : d <= 0 ? L().offerToday : d === 1 ? L().tomorrow : L().inDays(daysWord(d));
    const fresh = !ui.offerSeen.has(o.id);
    ui.offerSeen.add(o.id);
    return `<div class="ht-offer${fresh ? ' ht-offer-new' : ''}" data-oid="${esc(o.id)}">
        ${o.cause ? `<div class="ht-offer-cause"><i class="fa-solid fa-feather-pointed"></i><span>${L().offerCause}:</span> <b>${esc(o.cause)}</b></div>` : ''}
        <div class="ht-offer-hol"><i class="fa-solid ${TYPE_ICON[o.type] || 'fa-star'}"></i>
            <span>${L().offerHol}: <b>${esc(o.name)}</b> · ${esc(when)}</span>
            ${list.length > 1 ? `<em>${esc(L().offerMore(list.length - 1))}</em>` : ''}</div>
        ${o.meaning ? `<p class="ht-offer-mean">${esc(o.meaning)}</p>` : ''}
        <div class="ht-offer-actions">
            <button class="ht-btn ht-btn-main" data-act="offer-yes" data-oid="${esc(o.id)}"><i class="fa-solid fa-check"></i>${L().accept}</button>
            <button class="ht-btn" data-act="offer-edit" data-oid="${esc(o.id)}"><i class="fa-solid fa-pen"></i>${L().edit}</button>
            <button class="ht-btn ht-btn-quiet" data-act="offer-no" data-oid="${esc(o.id)}"><i class="fa-solid fa-xmark"></i>${L().decline}</button>
        </div>
    </div>`;
}

function bodyHtml(view, live) {
    const delBtn = (hid) => {
        if (!live || !hid) return '';
        const confirm = ui.confirmDel === hid;
        return `<button class="ht-del${confirm ? ' ht-del-confirm' : ''}" data-act="del" data-hid="${esc(hid)}" title="${confirm ? L().removeSure : L().remove}" aria-label="${L().remove}">
            <i class="fa-solid ${confirm ? 'fa-check' : 'fa-trash-can'}"></i>${confirm ? `<span>${L().removeQ}</span>` : ''}</button>`;
    };
    const editBtn = (hid) => (live && hid ? `<button class="ht-del ht-edit-btn" data-act="edit" data-hid="${esc(hid)}" title="${L().edit}" aria-label="${L().edit}"><i class="fa-solid fa-pen"></i></button>` : '');
    const editForm = (x) => editFormHtml(x);
    const s = view.setting || {};
    const kv = (icon, label, value) => `<div class="ht-kv"><i class="fa-solid ${icon}"></i><div><span>${label}</span><b>${esc(value)}</b></div></div>`;
    const world = [
        s.era && kv('fa-hourglass-half', L().era, s.era),
        s.faith && kv('fa-hands-praying', L().faith, s.faith),
        (view.place || s.place) && (ui.editing === 'place' && live
            ? `<div class="ht-kv ht-kv-edit"><i class="fa-solid fa-location-dot"></i><div><span>${L().fPlace}</span>
                <input class="text_pole" data-ed="place" value="${esc(view.place || s.place)}">
                <div class="ht-edit-actions"><button class="ht-btn" data-act="edit-cancel">${L().cancel}</button><button class="ht-btn ht-btn-main" data-act="place-save"><i class="fa-solid fa-check"></i>${L().save}</button></div></div></div>`
            : kv('fa-location-dot', L().place, view.place || s.place).replace('</b></div></div>', `</b></div>${live ? `<button class="ht-del ht-edit-btn" data-act="place-edit" title="${L().edit}" aria-label="${L().edit}"><i class="fa-solid fa-pen"></i></button>` : ''}</div>`)),
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
            main = section('main', 'fa-fire', plan.title ? esc(plan.title) : L().festiveDay, `<div class="ht-parts">${rows}</div>`, editBtn(h.id) + delBtn(h.id));
        } else {
            main = section('main', 'fa-fire', L().festiveDay, `<p class="ht-text">${esc(h.meaning || '')}</p><p class="ht-mute">${L().planSoon}</p>`, editBtn(h.id) + delBtn(h.id));
        }
    } else if (view.kind === 'prep' && h) {
        const p = view.prep;
        main = section('main', 'fa-wand-magic-sparkles', L().prep, p ? `
            ${p.people ? `<p class="ht-text">${esc(p.people)}</p>` : ''}
            ${p.mood ? `<p class="ht-mood"><i class="fa-solid fa-feather-pointed"></i>${esc(p.mood)}</p>` : ''}`
            : `<p class="ht-text">${esc(h.meaning || '')}</p><p class="ht-mute">${L().prepSoon}</p>`, editBtn(h.id) + delBtn(h.id));
    } else if (view.kind === 'after' && view.ended) {
        main = section('main', 'fa-moon', esc(L().ended(view.ended.name)), `<p class="ht-text">${esc(view.ended.recap || L().afterDefault)}</p>`);
    } else if (h) {
        main = section('main', TYPE_ICON[h.type] || 'fa-star', esc(h.name), `<p class="ht-text">${esc(h.meaning || '')}</p>`, editBtn(h.id) + delBtn(h.id));
    } else if (view.diag) {
        // праздников нет — объясняем почему (и что именно пришло, если не тот язык)
        main = `<p class="ht-mute"><i class="fa-solid fa-circle-info"></i> ${esc(L().diag[view.diag])}${view.diagNames?.length ? `. ${esc(L().diagGot)}: ${view.diagNames.map(esc).join(', ')}` : ''}</p>`;
    }

    if (h && ui.editing === h.id && live && main) main = main.replace('<div class="ht-sec-body">', `<div class="ht-sec-body">${editForm(h)}`);
    const upcoming = (view.upcoming || []).map(u => ui.editing === u.id && live ? editForm(u) : `
        <div class="ht-up"><i class="fa-solid ${TYPE_ICON[u.birthday ? 'personal' : u.type] || 'fa-star'}"></i>
        <span>${esc(u.name)}</span><b>${u.daysTo === 1 ? L().tomorrow : L().inDays(daysWord(u.daysTo))}</b>${editBtn(u.id)}${delBtn(u.id)}</div>`).join('');

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
    const standout = (view.highlights || []).length ? `<div class="ht-group ht-standout"><div class="ht-group-title"><i class="fa-solid fa-star"></i>${L().standout}</div>${view.highlights.map(x => `
            <div class="ht-person"><b>${esc(x.name)}</b><span>${esc(x.text)}</span></div>`).join('')}</div>` : '';
    const peopleSec = section('people', 'fa-users', L().people, groups + standout);
    // События дня: идущее сверху, мероприятие — своей раскрывающейся карточкой
    const evRows = (view.evts || []).slice().reverse().map(e => {
        const st = L().evStatus[e.status] || e.status;
        const open = ['active', 'invited', 'joined'].includes(e.status);
        if (e.kind === 'party') {
            const moments = (e.moments || []).map(m => `<li>${esc(m.title)}</li>`).join('');
            return `<details class="ht-party ht-ev-${e.status}"${open ? ' open' : ''}>
                <summary><i class="fa-solid fa-champagne-glasses"></i><span><b>${esc(e.title)}</b>${e.who ? ` · ${esc(e.who)}` : ''}</span><em>${esc(st)}</em></summary>
                ${moments ? `<div class="ht-moments"><span>${L().moments}</span><ul>${moments}</ul></div>` : ''}
                ${e.note ? `<p class="ht-ev-note">${esc(e.note)}</p>` : ''}
            </details>`;
        }
        return `<div class="ht-ev ht-ev-${e.status}"><i class="fa-solid ${open ? 'fa-bolt' : e.status === 'done' ? 'fa-circle-check' : 'fa-circle-minus'}"></i>
            <div><span><b>${esc(e.title)}</b>${e.who ? ` · ${esc(e.who)}` : ''} <em>${esc(st)}</em></span>${e.note ? `<p class="ht-ev-note">${esc(e.note)}</p>` : ''}</div></div>`;
    }).join('');
    const eventsSec = section('events', 'fa-bolt', L().events, evRows);

    // Текущий год: по порядку дат; отмеченные — с итогом, прошедшие мимо — приглушены
    const yearRows = (view.year || []).map(i => {
        const [, m, d] = i.iso.split('-');
        return `<div class="ht-yr${i.kept ? '' : ' ht-yr-missed'}">
            <time>${d}.${m}</time><i class="fa-solid ${TYPE_ICON[i.type] || 'fa-star'}"></i>
            <div><b>${esc(i.name)}</b>${i.recap ? `<p>${esc(i.recap)}</p>` : ''}</div>
            <em>${i.kept ? L().yearKept : L().yearMissed}</em></div>`;
    }).join('');

    // Воспоминания: в контекст только по кнопке «вспомнить»
    const memories = (view.flashbacks || []).map(f => {
        const queued = view.recall === f.id;
        const btn = live ? `<button class="ht-recall${queued ? ' ht-on' : ''}" data-act="recall" data-fb="${esc(f.id)}" title="${queued ? L().recallQueued : L().recall}">
            <i class="fa-solid fa-clock-rotate-left"></i><span>${queued ? L().recallShort : L().recall}</span></button>` : '';
        return `<div class="ht-fb"><div><b>${esc(f.title)}</b>${f.when ? `<span class="ht-mute"> · ${esc(f.when)}</span>` : ''}<p>${esc(f.text)}</p></div>${btn}</div>`;
    }).join('');

    return `<div class="ht-body">
        ${world ? `<div class="ht-world">${world}</div>` : ''}
        ${charCard}
        ${main}
        ${eventsSec}
        ${peopleSec}
        ${section('upcoming', 'fa-calendar-days', L().upcoming, upcoming)}
        ${section('year', 'fa-calendar-check', L().year, yearRows, view.year?.length ? `<em class="ht-count">${view.year.length}</em>` : '')}
        ${section('memories', 'fa-clock-rotate-left', L().flashbacks, memories)}
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
        } else if (t.dataset.act === 'edit') {
            ui.editing = t.dataset.hid;
            ui.confirmDel = null;
            if (t.closest('.ht-sec')?.classList.contains('ht-sec-closed')) toggleSec(t.closest('.ht-sec').querySelector('h5')?.dataset.key);
            renderBlock(id);
        } else if (t.dataset.act === 'place-edit') {
            ui.editing = 'place';
            renderBlock(id);
        } else if (t.dataset.act === 'edit-cancel') {
            ui.editing = null;
            renderBlock(id);
        } else if (t.dataset.act === 'edit-save') {
            const f = t.closest('.ht-edit');
            const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
            if (saveHolidayEdit(t.dataset.hid, val('name'), val('date'), val('type'), f?.querySelector('[data-ed="meaning"]') ? val('meaning') : null)) {
                ui.editing = null;
                window.toastr?.success?.(L().saved, 'Hearthtide');
                renderAll();
            }
        } else if (t.dataset.act === 'offer-yes') {
            if (acceptOffer(t.dataset.oid)) renderAll();
        } else if (t.dataset.act === 'offer-no') {
            declineOffer(t.dataset.oid);
            renderAll();
        } else if (t.dataset.act === 'offer-edit') {
            ui.editing = t.dataset.oid;
            ui.confirmDel = null;
            renderBlock(id);
        } else if (t.dataset.act === 'offer-save') {
            const f = t.closest('.ht-edit');
            const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
            if (acceptOffer(t.dataset.hid, { name: val('name'), date: val('date'), type: val('type'), meaning: val('meaning') })) {
                ui.editing = null;
                renderAll();
            }
        } else if (t.dataset.act === 'place-save') {
            const v = block.querySelector('[data-ed="place"]')?.value;
            if (savePlaceEdit(v)) {
                ui.editing = null;
                window.toastr?.success?.(L().saved, 'Hearthtide');
                renderAll();
            }
        } else if (t.dataset.act === 'recall') {
            const fbId = t.dataset.fb;
            state.recall = state.recall === fbId ? null : fbId;   // повторное нажатие отменяет
            saveState();
            injectPrompts();
            if (state.recall) window.toastr?.info?.(L().recallToast(getCharName()), 'Hearthtide');
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
                <label class="ht-settings-row">Профиль
                    <select id="ht-set-api" class="text_pole"><option value="auto">текущий профиль</option></select>
                </label>
                <label class="ht-settings-row">Помнит сообщений
                    <select id="ht-set-depth" class="text_pole">
                        ${[5, 10, 20, 30].map(n => `<option value="${n}" ${sideDepth() === n ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>
                </label>
                <div class="menu_button" id="ht-set-scan"><i class="fa-solid fa-magnifying-glass"></i> Проверить историю</div>
                <label class="ht-settings-row"><span>Эпоха <small id="ht-era-who"></small></span>
                    <select id="ht-set-era" class="text_pole">
                        <option value="ancient" ${eraMode() === 'ancient' ? 'selected' : ''}>прошлое и вымышленные миры</option>
                        <option value="modern" ${eraMode() === 'modern' ? 'selected' : ''}>наши дни</option>
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
        fillProfiles();
        document.getElementById('ht-set-api')?.addEventListener('focus', fillProfiles);
        document.getElementById('ht-set-api')?.addEventListener('change', e => {
            localStorage.setItem(LS.api, e.target.value);
            cancelSide();
            injectPrompts();          // запрос уйдёт сам — после следующего ответа бота
        });
        document.getElementById('ht-set-depth')?.addEventListener('change', e => {
            localStorage.setItem(LS.depth, e.target.value);
        });
        document.getElementById('ht-set-scan')?.addEventListener('click', () => {
            if (!apiOn()) { window.toastr?.info?.(L().noProfile, 'Hearthtide'); return; }
            if (!state || lastProcessedMsg() < 0) { window.toastr?.info?.(L().scanNothing, 'Hearthtide'); return; }
            window.toastr?.info?.(L().scanToast, 'Hearthtide');
            maybeSide(lastProcessedMsg(), true);
        });
        syncCharSettings();
        document.getElementById('ht-set-era')?.addEventListener('change', e => {
            setCharSetting('era', e.target.value);
            const row = document.getElementById('ht-row-faith');
            if (row) row.style.display = e.target.value === 'modern' ? '' : 'none';
            rebuildCalendar();
        });
        document.getElementById('ht-set-faith')?.addEventListener('change', e => {
            setCharSetting('faith', e.target.value);
            rebuildCalendar();
        });
        document.getElementById('ht-set-prev')?.addEventListener('change', e => {
            localStorage.setItem(LS.showPrev, e.target.checked ? 'true' : 'false');
            renderAll();
        });
    }, 250);
}

// Профили подключения в списке (список в таверне может меняться — обновляем при каждом открытии)
async function fillProfiles() {
    const sel = document.getElementById('ht-set-api');
    if (!sel) return;
    const list = await listProfiles();
    const cur = apiChoice();
    sel.innerHTML = `<option value="auto">текущий профиль</option>`
        + list.map(p => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    // выбранный профиль удалили в таверне — возвращаемся к текущему профилю
    if (cur !== 'auto' && !list.some(p => p.id === cur)) localStorage.setItem(LS.api, 'auto');
}

// Эпоха и вера в настройках — для текущего персонажа
function syncCharSettings() {
    const era = document.getElementById('ht-set-era');
    const faith = document.getElementById('ht-set-faith');
    if (era) era.value = eraMode();
    if (faith) faith.value = faithMode();
    const row = document.getElementById('ht-row-faith');
    if (row) row.style.display = eraMode() === 'modern' ? '' : 'none';
    const who = document.getElementById('ht-era-who');
    if (who) who.textContent = charKey() ? `· ${getCharName()}` : '';
}

// Новый персонаж: эпоха не наследуется от прошлого — ставим «прошлое» и говорим об этом
function noteCharSettings() {
    const key = charKey();
    if (key && !eraMap()[key]) {
        const map = eraMap();
        map[key] = { era: 'ancient', faith: 'faith' };
        localStorage.setItem(LS.eraMap, JSON.stringify(map));
        if (isEnabled()) window.toastr?.info?.(L().eraNew(getCharName()), 'Hearthtide', { timeOut: 8000 });
    }
    syncCharSettings();
}

// ═══════════════════════════════════════════════════════════════
// СОБЫТИЯ
// ═══════════════════════════════════════════════════════════════
let generating = false;

function onGenerationStarted(type, params, dryRun) {
    if (dryRun) return;
    generating = true;
    sideAfterGen = null;
    cancelSide();          // пользователь уже пишет дальше — результат для прошлого ответа не нужен
    if (!isEnabled()) return;
    if (!state) loadState();
    injectPrompts();
}

function onMessageReceived(id) {
    if (!isEnabled()) return;
    if (!state) loadState();
    processReply(Number(id));
    // таверна ещё дописывает сообщение — запрос отправим, когда генерация закончится
    sideAfterGen = Number(id);
    // на случай, если событие конца генерации не придёт
    setTimeout(() => { if (sideAfterGen === Number(id)) { generating = false; onGenerationEnded(); } }, 4000);
}
let sideAfterGen = null;
function onGenerationEnded() {
    generating = false;
    scheduleEnsure();
    if (sideAfterGen != null) {
        const id = sideAfterGen;
        sideAfterGen = null;
        setTimeout(() => maybeSide(id), 300);
    }
}

function onMessageSwiped(id) {
    if (!isEnabled() || !state) return;
    setTimeout(() => {
        if (generating) return;
        const m = chat[id];
        if (!m || m.is_user) return;
        const sw = m.swipes?.[m.swipe_id];
        if (sw && sw.trim() && m.mes === sw && state.snapshots.some(s => s.beforeMsg === Number(id))) {
            processReply(Number(id));
            maybeSide(Number(id));
        }
        else scheduleRenderAll();
    }, 150);
}

function onMessageEdited(id) {
    if (!isEnabled() || !state) return;
    const m = chat[id];
    if (m && !m.is_user && Number(id) === lastProcessedMsg()) {
        processReply(Number(id));
        maybeSide(Number(id));
    }
    else scheduleRenderAll();
}

function onMessageDeleted() {
    if (!isEnabled() || !state) return;
    if (side && !chat[side.N]) cancelSide();
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
    cancelSide();
    sideAfterGen = null;
    ui.open.clear();
    loadState();
    noteCharSettings();
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
    on(event_types.GENERATION_ENDED, onGenerationEnded);
    on(event_types.GENERATION_STOPPED, onGenerationEnded);
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
