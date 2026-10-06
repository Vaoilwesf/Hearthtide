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
import { parseSmall, parseCalendar, parsePrep, parseDay, parseRecap, parsePeople, parseEvents, parseOffers, parseBeat, parseCast, parseDateBlock, parseDateUp, parseRecapParts, stripBlocks } from './tag.js';
import { PAIR_DEFAULT, newDate, startDate, applyDateUp, openSteps, goalOpen, doneCount, toggleStep, finishDate, dateChanceInfo, migrateDate, DATE_MISS_HOURS, DATE_OPEN } from './romance.js';
import { CAST_GROUPS, KIN_GROUPS, ROM_KEYS, isKin, samePerson, findCast, castBanned, parseBday, bdayText, bdayIn, ageOf, relLevel, romLevel, clampRel, mergeCast, migrateCast, nameCandidates } from './cast.js';
import { phaseOf, requestFor, mentionEvery, holidayId, allHolidays, banKeys, isBanned, namesMatch, passedThisYear, hasGifts, openEvent, offeredEvent, EVENT_CHANCE, EVENT_COOLDOWN, OPEN_STATUSES, sideNeeds, sideDue, CENSUS_DEPTH, dateHoursLeft } from './calendar.js';
import { buildStatePrompt, buildTagPrompt, buildSideMessages, giftTarget } from './prompts.js';
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
    dateChance: 'hearthtide_date_chance', // шанс, что чар сам позовёт на свидание после ответа (%)
    dateLevel: 'hearthtide_date_level',   // сложность свиданий: easy | hard
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
const dateLevel = () => (lsGet(LS.dateLevel, 'easy') === 'hard' ? 'hard' : 'easy');
const dateChanceSetting = () => { const n = Number(lsGet(LS.dateChance, '6')); return isNaN(n) ? 6 : Math.max(0, Math.min(30, n)); };

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
    if (value === 'auto') delete map[key][field];
    localStorage.setItem(LS.eraMap, JSON.stringify(map));
}
// Эпоху нового персонажа определяет ИИ по карточке в первом календаре (auto), пока игрок не выберет сам
const eraMode = () => eraMap()[charKey()]?.era || (charKey() ? 'auto' : lsGet(LS.era, 'ancient'));
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
        evRoll: false,          // выпал шанс: в следующем ответе (или запросе помощника) предложить случайный ивент
        evDecisions: {},        // решения игрока по ивентам (по названию): accepted | declined — переживают свайпы
        pair: null,             // {{char}} и {{user}}: { f: дружба −100…100, r: романтика −100…100, note }; null — ещё не ясно
        pairDrop: -99,          // когда дружба заметно упала (ссора) — шанс свидания выше
        pairSet: null,          // правка игрока: { pair, at } — ответы до at включительно её не перезаписывают
        lastBondTurn: -99,      // когда основная модель (или помощник) последний раз прислали bond
        bondMiss: 0,            // сколько ответов подряд без bond, пока пара не ясна
        bondSide: -99,          // когда помощника последний раз просили начальные значения пары
        dateRollTry: 0,         // выпавшее свидание модель пропустила — просим ещё раз, настойчивее
        dateRecapFor: null,     // id закончившегося свидания, к которому ещё нужен итог
        dateRecapTurn: null,
        dateMissed: null,       // { title, turn } — намеченное свидание не состоялось (одна строка в промпт)
        dateSeenMsg: null,      // до какого сообщения помощник уже судил ход свидания
        date: null,             // свидание: { id, title, goal, hook, steps [{t, who, done}], score, status offered|active|ended, … }
        dateRoll: false,        // выпал шанс: предложить свидание
        lastDateEnd: -99,
        datesDone: [],          // прошедшие свидания: { title, result, score }
        dateDecisions: {},      // решения игрока по предложенным свиданиям (по названию) — переживают свайпы
        cast: [],               // люди истории: { id, name, group, who, bday {d,m,y}, rel {user, char}, edited, relLock }
        castNo: [],             // убранные игроком — ИИ их не вернёт
        lastCastTurn: -99,
        lastCensusTurn: -99,    // перепись людей истории по большому окну сообщений
        flashbacks: [],         // воспоминания: { id, title, text, when, kind } — в контекст только по кнопке
        recall: null,           // id воспоминания, которое уйдёт в следующий ответ
        planPart: {},           // `${hid}#${день}` → часть дня, к которой распорядок уже подстроен
        lastPeopleTurn: -99,
        care: {},               // hid → high | normal | low — насколько праздник важен персонажу
        gifts: {},              // hid → true/false — предполагает ли праздник подарки
        giftTo: {},             // hid → кому по обычаю дарят (виновник торжества)
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
        nudge: null,            // кто из людей праздника может зайти в следующий ответ
        nudgeIdx: 0,
        whoIdx: 0,              // чьё желание основная модель обновляет в этом ответе (по очереди)
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
    // люди из старых версий: роли, родня по сторонам, романтика — кнопками
    migrateCast(state, getUserName(), getCharName());
    // свидание из прошлой версии: шаги разом и шкала с 35 % → живые шаги
    migrateDate(state);
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

// пару сверяем, если bond не приходил столько ответов
const BOND_STALE = 12;

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
        ...castForPrompt(),
        // пара: пока не ясна — сколько ответов подряд без bond; ясна — давно ли сверяли
        bondMiss: state.pair ? 0 : state.bondMiss || 0,
        bondStale: !!state.pair && (state.turn || 0) - (state.lastBondTurn ?? -99) >= BOND_STALE,
        dateLevel: dateLevel(),
        // {{char}} сам вспоминал свидание в последних ответах — не подталкивать
        dateMentioned: dateMentioned(),
        // перепись в инджекте: кого часто называют в истории
        castHint: request === 'cast' ? castHint() : [],
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
const USER_FIELDS = ['banned', 'bannedNames', 'birthdayOff', 'calIgnore', 'offerNo', 'evDecisions', 'castNo', 'dateDecisions', 'pairSet'];

function restoreSnapshot(snap) {
    const keep = state.snapshots;
    const user = Object.fromEntries(USER_FIELDS.map(k => [k, clone(state[k] ?? null)]));
    Object.assign(state, clone(snap.data));
    for (const [k, v] of Object.entries(user)) if (v != null) state[k] = v;
    state.snapshots = keep;
    // пару, выставленную игроком, снимок из времени до правки не отменяет (более поздние уже ведут её дальше)
    if (state.pairSet?.pair && snap.beforeMsg <= state.pairSet.at) state.pair = clone(state.pairSet.pair);
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
// Люди истории для промпта: кто сейчас рядом (имя в последних сообщениях) и у кого скоро день рождения
function castForPrompt() {
    // «глазок» выключен — человек не попадает в промпт (но и не вносится заново)
    const cast = (state.cast || []).filter(c => !c.off && !castBanned(state, c.name));
    if (!cast.length) return { castSeen: [], castBdays: [] };
    const text = recentStoryText(8);
    const castBdays = cast.map(c => ({ c, days: bdayIn(c, state.today) })).filter(x => x.days != null && x.days <= 7)
        .sort((a, b) => a.days - b.days).slice(0, 2)
        .map(({ c, days }) => ({
            name: c.name || c.toU || c.toC, days, relU: c.rel?.user ?? 0, relC: c.rel?.char ?? 0,
            // ближе к дню — чаще всплывает в разговоре
            nudge: (state.turn || 0) % (days <= 2 ? 2 : 3) === 0,
        }));
    const castSeen = cast.filter(c => (c.name ? seenInStory(c.name, text) : [c.toU, c.toC].some(r => r && seenInStory(r, text)))
        || castBdays.some(b => b.name === (c.name || c.toU || c.toC))).slice(0, 8);
    return { castSeen, castBdays };
}

// ─── Кого часто называют в истории — подсказка для переписи людей (по всему чату, с кэшем) ───
let hintCache = { key: null, list: [] };
function castHint() {
    const key = `${chat.length}|${hashText(chat[chat.length - 1]?.mes)}|${(state.cast || []).length}|${(state.castNo || []).length}`;
    if (hintCache.key === key) return hintCache.list;
    const texts = chat.slice(-400).filter(m => m?.mes && !m.is_system).map(m => m.mes);
    const exclude = [getUserName(), getCharName(), ...(state.cast || []).map(c => c.name), ...(state.castNo || []),
        ...(state.holidays || []).map(h => h.name), state.place, state.setting?.place].filter(Boolean);
    let list = [];
    try { list = nameCandidates(texts, exclude); } catch (e) { console.warn('[Hearthtide] частые имена:', e); }
    hintCache = { key, list };
    return list;
}

function peopleSeen() {
    const text = recentStoryText(6);
    return (state.people || []).filter(p => seenInStory(p.name, text));
}

// ─── Воспоминания ───
function addFlashback(title, text, kind, parts = null) {
    state.flashbacks.push({ id: `fb-${state.turn}-${state.flashbacks.length}`, title, text, when: state.when, kind, parts });
    if (state.flashbacks.length > 40) state.flashbacks = state.flashbacks.slice(-40);
}

// ─── Ивенты: появились, идут, закончились ───
function processEvents(phase, small, evs) {
    // ивенты привязаны к ближайшему празднику — и в подготовке, и в сам день
    const cur = (phase.kind === 'today' || phase.kind === 'prep') && phase.h ? phase.h.id : null;
    for (const e of state.evts) {
        if ((OPEN_STATUSES.includes(e.status) || e.status === 'offered') && e.hid !== cur) e.status = e.status === 'offered' ? 'missed' : 'faded';
    }
    if (!cur) return;
    let ev = openEvent(state, cur);

    // Статус от ИИ: чем кончилось
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
        ev = openEvent(state, cur);
    }
    // Новые: случайный ивент только предлагается — в историю он войдёт, если игрок примет
    for (const e of evs || []) {
        if (!langOk(e.title) || (e.hook && !langOk(e.hook))) continue;
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
        if (ev || offeredEvent(state)) continue;   // одновременно — только одно
        const item = {
            id: `ev-${state.turn}`, hid: cur, kind: e.kind, title: e.title, who: e.who, hook: e.hook || null,
            status: 'offered', turn: state.turn, lastUpdate: state.turn, note: null, moments: [],
        };
        // игрок уже решал по этому ивенту (свайп, пересборка) — его решение в силе
        const d = state.evDecisions?.[evKey(item)];
        if (d) applyEventDecision(item, d);
        state.evts.push(item);
        state.evRoll = false;
    }
    // Забытые: долго без решения или без конца — тихо закрываем
    for (const e of state.evts) {
        const idle = state.turn - (e.lastUpdate ?? e.turn);
        if (e.status === 'offered' && idle > 4) { e.status = 'missed'; state.lastEventEnd = state.turn; continue; }
        if (!OPEN_STATUSES.includes(e.status)) continue;
        if ((e.status === 'invited' && idle > 6) || (e.status === 'active' && idle > 8) || (e.status === 'joined' && idle > 25)) {
            e.status = e.status === 'invited' ? 'missed' : 'faded';
            state.lastEventEnd = state.turn;
        }
    }
    if (state.evts.length > 30) state.evts = state.evts.slice(-30);
}

// ─── Решение игрока по ивенту: принять / отклонить ───
const evKey = (e) => `${e.hid}|${String(e.title || '').toLowerCase()}`;
function applyEventDecision(e, d) {
    if (d === 'accepted') e.status = e.kind === 'party' ? 'joined' : 'active';
    else e.status = 'declined';
    e.lastUpdate = state?.turn ?? e.lastUpdate;
}
function decideEvent(id, d) {
    const e = (state.evts || []).find(x => x.id === id);
    if (!e || e.status !== 'offered') return;
    state.evDecisions = { ...(state.evDecisions || {}), [evKey(e)]: d };
    const apply = (st) => {
        const x = (st.evts || []).find(y => y.id === id && y.status === 'offered');
        if (!x) return;
        if (d === 'accepted') x.status = x.kind === 'party' ? 'joined' : 'active';
        else x.status = 'declined';
        x.turn = st.turn ?? x.turn;              // «только что принят» — основная модель введёт его сразу
        x.lastUpdate = st.turn ?? x.lastUpdate;
        if (d === 'declined') st.lastEventEnd = st.turn;
    };
    apply(state);
    applyToSnapshots(apply);
    saveState();
    injectPrompts();
    renderAll();
}

// Детерминированный бросок по тексту ответа: пересборка того же ответа даёт тот же результат, свайп — новый
function rollFor(text, turn) {
    let x = 2166136261 ^ turn;
    const t = String(text || '');
    for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); }
    return (x >>> 0) % 100;
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
    const hadDateRoll = !!state.dateRoll;     // в промпте этого ответа была просьба позвать на свидание
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
    // поля о персонаже, подарке, ивенте, смысле и паре — из ответа; чего в ответе нет — из отдельного запроса.
    // Пустые значения помощника (0, [], false) не затирают отметки основной модели (шаги свидания, bond)
    const has = (v) => v != null && v !== false && v !== 0 && !(Array.isArray(v) && !v.length);
    const sm = small || sideSmall ? { ...(small || {}) } : null;
    for (const [k, v] of Object.entries(sideSmall || {})) {
        if (!['inner', 'date', 'clock', 'when', 'place'].includes(k) && has(v) && !has(sm[k])) sm[k] = v;
    }
    if (small?.bond && sideSmall?.bond) sm.bondNote = small.bondNote || null;   // пометка — от той же модели, что и числа
    const calRaw = (state.calIgnore || []).includes(hashText(src)) ? null : parseCalendar(src);
    const calSide = sideText && !(state.calIgnore || []).includes(hashText(sideText)) ? parseCalendar(sideText) : null;
    const cal = calRaw || calSide;
    const prep = both(parsePrep);
    const day = both(parseDay);
    const recap = both(parseRecap);
    const recapParts = both(parseRecapParts);
    const people = both(parsePeople);
    const evs = [...parseEvents(src), ...(sideText ? parseEvents(sideText) : [])];
    const offersIn = [...parseOffers(src), ...(sideText ? parseOffers(sideText) : [])];
    const castIn = [parseCast(src), sideText ? parseCast(sideText) : null].filter(Boolean);
    const dateIn = parseDateBlock(src) || (sideText ? parseDateBlock(sideText) : null);
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
        // эпоха «по карточке»: ИИ сказал, наши это дни или нет — запоминаем для персонажа
        if (cal.setting?.mode && eraMode() === 'auto') { setCharSetting('era', cal.setting.mode); syncCharSettings(); }
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
    // ── Люди истории: новые — один раз, известные — только отношения ──
    const castLog = [];
    for (const c of castIn) if (mergeCast(state, c, langOk, state.turn, castLog)) slip = true;
    if (castIn.length) console.info(`[Hearthtide] люди истории: ${castLog.join('; ') || 'пустой блок'} · всего ${state.cast.length}`);
    else if (sideAsked.includes('cast')) console.info('[Hearthtide] люди истории: помощник не прислал HT-CAST (если ответ обрезан — см. ответ выше)');
    if (asked === 'cast' || sideAsked.includes('cast')) state.lastCastTurn = state.turn;
    if (sideAsked.includes('census')) state.lastCensusTurn = state.turn;
    if (sideAsked.includes('bond')) state.bondSide = state.turn;

    // ── {{char}} и {{user}}: дружба и романтика ──
    if (sm?.bond) {
        if (sm.bondNote && !langOk(sm.bondNote)) slip = true;
        const prev = state.pair;
        if (prev && sm.bond.f <= prev.f - 15) state.pairDrop = state.turn;       // заметно поссорились
        state.pair = { scale: 2, f: sm.bond.f, r: sm.bond.r, note: sm.bondNote && langOk(sm.bondNote) ? sm.bondNote : prev?.note || null };
        state.lastBondTurn = state.turn;
        state.bondMiss = 0;
    } else if (!state.pair && (small || sideRec)) {
        state.bondMiss = (state.bondMiss || 0) + 1;                              // напомним в следующем ответе
    }
    // игрок поправил пару сам — ответы до его правки её не перезаписывают (свайп, повторная обработка)
    if (state.pairSet && N <= state.pairSet.at) {
        state.pair = clone(state.pairSet.pair);
        state.lastBondTurn = state.turn;
    }
    // ── Свидание: намечено → началось → шаги (помощник или основная модель) → итог ──
    let dateEnded = null;
    const lvl = dateLevel();
    const upRaw = (sideText ? parseDateUp(sideText) : null) || parseDateUp(src);
    const up = upRaw ? tidyDateUp(upRaw) : null;
    if (sideAsked.includes('date')) state.dateSeenMsg = N;
    const endNow = () => { const e = finishDate(state, state.turn); if (e) recordDate(state, e); return e; };
    let dd = state.date;
    // намеченное началось — в срок или раньше: только теперь шкала и шаги
    if (dd?.status === 'scheduled' && (up?.start || dateIn?.started)) startDate(dd, state.turn);
    if (dd?.status === 'scheduled') {
        const left = dateHoursLeft(state);
        if (left != null && left < -DATE_MISS_HOURS) {
            dd.status = 'missed';
            state.dateMissed = { title: dd.title, turn: state.turn };
            state.lastDateEnd = state.turn;
            recordDate(state, dd, true);
        }
    }
    if (dd?.status === 'active' && up) {
        const r = applyDateUp(dd, up, state.turn, lvl);
        if (r.ignoredGoal) console.info('[Hearthtide] свидание: цель ещё закрыта — GOAL пропущен');
        if (r.moved) console.info(`[Hearthtide] свидание: ${dd.score}% · шагов сделано ${doneCount(dd)} · открыто ${openSteps(dd).length}`);
        if (r.ended) dateEnded = endNow();
    }
    if (dd?.status === 'active' && !dateEnded && state.turn - (dd.lastUpdate ?? dd.turn) > 14) dateEnded = endNow();
    // итог, дописанный после конца свидания
    if (up?.recap && state.dateRecapFor && !dateEnded) applyDateRecap(state, state.dateRecapFor, up.recap, up.best);
    if (state.dateRecapFor && state.turn - (state.dateRecapTurn ?? state.turn) > 3) state.dateRecapFor = null;   // не дождались — без итога
    if (state.date?.status === 'offered' && state.turn - state.date.turn > 4) state.date = null;   // не ответили — забылось
    if (dateIn && !['active', 'offered', 'scheduled'].includes(state.date?.status)
        && [dateIn.title, dateIn.goal, dateIn.hook, dateIn.where].every(langOk)) {
        const fixed = tidyDateUp({ add: dateIn.steps.map(x => ({ t: x.t, whoRaw: x.who })), done: [], fail: [] }).add;
        const d = newDate({ ...dateIn, steps: fixed }, state.turn, dateIn.started);
        if (d.at && !d.at.now && d.at.day == null) d.at.day = state.today;
        const dec = !dateIn.started && state.dateDecisions?.[String(d.title).toLowerCase()];
        if (dec === 'declined') d.status = 'declined';
        else if (dec === 'accepted') acceptInto(state, d);
        // история договорилась на потом — сразу намечено
        else if (!dateIn.started && (state.dateDecisions?.[String(d.title).toLowerCase()] === undefined) && sideAsked.includes('datewatch') && d.at && !d.at.now) d.status = 'scheduled';
        if (d.status !== 'declined') state.date = d;
        state.dateRoll = false;
    }

    // ── Подготовка, день праздника, итог — привязываем к текущей фазе ──
    let phase = phaseOf(state);
    if (prep && phase.h && (phase.kind === 'prep' || phase.kind === 'far' || phase.kind === 'today')) {
        if (langOk(prep.people) && langOk(prep.mood)) {
            state.prep = { hid: phase.h.id, day: state.today, turn: state.turn, people: prep.people, mood: prep.mood };
        } else slip = true;
        if (prep.gifts != null) state.gifts[phase.h.id] = prep.gifts;
        if (prep.giftTo && langOk(prep.giftTo)) state.giftTo[phase.h.id] = prep.giftTo;
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
    // Один человек праздника за ответ: его желание теперь (по очереди, дёшево — прямо в маленьком теге)
    if (sm?.who && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        const p = (state.people || []).find(x => samePerson(x.name, sm.who.name));
        if (p && langOk(sm.who.text)) {
            if (!echoes(p.now, sm.who.text)) { p.now = sm.who.text; p.turn = state.turn; }
        } else if (p) slip = true;
        state.whoIdx = (state.whoIdx || 0) + 1;
    } else if ((phase.kind === 'prep' || phase.kind === 'today') && (state.people || []).length) {
        state.whoIdx = (state.whoIdx || 0) + 1;                                  // пропустил — следующий по очереди
    }
    // Мысль/действие персонажа и его подарок — из маленького тега
    if (sm && phase.h && (phase.kind === 'prep' || phase.kind === 'today')) {
        if (sm.giftTo && langOk(sm.giftTo) && !phase.h.birthday) state.giftTo[phase.h.id] = sm.giftTo;
        // шаг, почти повторяющий прошлые словами, не принимаем — цепочка должна идти дальше
        const echo = (t) => (state.charLog[phase.h.id] || []).slice(-3).some(x => echoes(x.text, t));
        if (sm.char && echo(sm.char)) sm.char = null;
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
        const parts = recapParts && [...recapParts.done, ...recapParts.gifts, recapParts.best].filter(Boolean).every(langOk) ? recapParts : null;
        addFlashback(displayName(phase.ended), recap, 'holiday', parts);
        state.recaps.push({ hid: phase.ended.id, name: displayName(phase.ended), text: recap, parts });
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

    // ── Случайный ивент: бросок после ответа (в праздник чаще, в подготовке реже) ──
    state.evRoll = false;
    if ((phase.kind === 'today' || phase.kind === 'prep') && phase.h && !openEvent(state, phase.h.id) && !offeredEvent(state)
        && state.turn - (state.lastEventEnd ?? -99) >= EVENT_COOLDOWN
        && state.turn - Math.max(-99, ...(state.evts || []).filter(e => e.hid === phase.h.id).map(e => e.turn)) >= EVENT_COOLDOWN) {
        state.evRoll = rollFor(text, state.turn) < EVENT_CHANCE[phase.kind];
    }

    // ── Свидание: бросок после ответа (есть романтика; после ссоры шанс выше) ──
    // Выпало, а модель промолчала — просим ещё раз, настойчивее (один раз); потом — новый бросок
    const free = !state.date || state.date.status === 'ended';
    const di = dateChanceInfo(state, state.turn, dateChanceSetting());
    if (free && hadDateRoll && !dateIn && !(state.dateRollTry > 0) && di.chance > 0) {
        state.dateRoll = true;
        state.dateRollTry = 1;
        console.info('[Hearthtide] свидание: выпало, но модель не позвала — прошу ещё раз');
    } else {
        state.dateRollTry = 0;
        const roll = free && di.chance > 0 ? rollFor(text, state.turn + 7919) : null;
        state.dateRoll = roll != null && roll < di.chance;
        if (roll != null) console.info(`[Hearthtide] свидание: бросок ${roll} ${state.dateRoll ? '<' : '≥'} ${di.chance}% — ${state.dateRoll ? 'выпало, позовёт в следующем ответе' : 'не выпало'}`);
        else if (free) console.debug(`[Hearthtide] свидание: шанса нет (${di.why}${di.left ? `, ещё ${di.left}` : ''}${di.r != null ? `, романтика ${di.r}` : ''})`);
    }

    // ── Упоминать ли подготовку в следующем ответе (чем ближе, тем чаще) ──
    state.mentionNow = false;
    if (phase.kind === 'prep' && state.turn - state.lastMention >= mentionEvery(phase.daysTo)) {
        state.mentionNow = true;
        state.lastMention = state.turn;
    }
    // ── Кто из людей праздника может зайти в следующий ответ: по очереди, не толпой ──
    state.nudge = null;
    const nudgeNow = phase.kind === 'today' ? state.turn % 2 === 0 : state.mentionNow;
    if (phase.h && nudgeNow) {
        const ppl = (state.people || []).filter(p => p.now);   // список людей сбрасывается при смене праздника
        if (ppl.length) {
            const p = ppl[(state.nudgeIdx || 0) % ppl.length];
            state.nudgeIdx = (state.nudgeIdx || 0) + 1;
            state.nudge = { name: p.name, now: p.now };
        } else state.nudge = { name: null };
    }

    // ── Снимок для инфоблока этого сообщения ──
    // Почему нет праздников — подсказка в инфоблоке, чтобы было видно, чья это проблема
    if (!small) state.diag = 'notag';
    else if (cal && cal.holidays.length) state.diag = null;
    else if (askedCal && !cal) state.diag = 'nocal';                          // просили календарь — не прислал
    else if (state.diag === 'notag') state.diag = null;
    state.diagThink = fromThink;

    msg.extra.ht = viewSnapshot(phase);
    // свидание закончилось в этом ответе — уведомление посреди экрана (один раз)
    if (dateEnded) showDateToast(dateEnded);
    // {{char}} зовёт на свидание — короткое уведомление сверху (один раз на приглашение)
    if (state.date?.status === 'offered' && state.date.turn === state.turn && N === lastBotIndex()) showDateInvite(state.date);

    saveState();
    injectPrompts();
    scheduleRenderAll();
}

// Повторяет ли фраза прошлую: хотя бы 3 общих слова (по корням длиной 5) и это 40% и больше
function echoes(a, b) {
    const set = (t) => new Set(String(t || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(w => w.length >= 4).map(w => w.slice(0, 5)));
    const A = set(a), B = set(b);
    if (!A.size || !B.size) return false;
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n >= 3 && n / Math.min(A.size, B.size) >= 0.4;
}

// ─── Свидание: служебное ───
const hoursUntil = (st, at) => (!at || at.now || st.today == null ? null : ((at.day ?? st.today) - st.today) * 24 + (at.clock ?? 18) - (st.clock ?? 12));
/** Игрок сказал «да»: назначено на потом — намечено (без шкалы и шагов), прямо сейчас — началось */
function acceptInto(st, d) {
    const left = hoursUntil(st, d.at);
    if (left != null && left > 0.75) d.status = 'scheduled';
    else startDate(d, st.turn);
}
/** Ответ модели о свидании: имена вместо {{user}} / (user), кто делает шаг, язык */
function tidyDateUp(up) {
    const u = getUserName(), c = getCharName();
    const stem = (n) => String(n || '').toLowerCase().replace(/ё/g, 'е').slice(0, 4);
    const fix = (t) => (t ? String(t).replace(/\{\{user\}\}/gi, u).replace(/\{\{char\}\}/gi, c)
        .replace(/\s*\((?:user|char|both|юзер|чар|оба|вместе|игрок)\)\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim() || null : null);
    const ok = (t) => (t && langOk(t) ? t : null);
    const who = (w) => {
        const x = String(w || '').toLowerCase().replace(/ё/g, 'е');
        if (/both|either|together|оба|вмест|обе/.test(x)) return 'both';
        if (/user|юзер|игрок/.test(x) || (stem(u).length >= 3 && x.includes(stem(u)))) return 'user';
        if (/char|чар/.test(x) || (stem(c).length >= 3 && x.includes(stem(c)))) return 'char';
        return 'both';
    };
    up.add = (up.add || []).map(a => ({ t: ok(fix(a.t)), who: who(a.whoRaw) })).filter(a => a.t);
    for (const x of [...(up.done || []), ...(up.fail || [])]) x.note = ok(fix(x.note));
    for (const k of ['vibe', 'thought', 'recap', 'best']) up[k] = ok(fix(up[k]));
    return up;
}
const dateParts = (d) => ({ done: (d.notes || []).filter(n => n.ok).map(n => n.t).slice(-5), gifts: [], best: d.best || null });
/** Свидание кончилось (или не состоялось) — в «Текущий год», в итоги и воспоминания */
function recordDate(st, d, missed = false) {
    const name = `${L().dateWord}: ${d.title}`;
    const result = missed ? 'missed' : d.result;
    if (st === state) ensureYear();
    const log = st.yearLog;
    if (log && st.today != null && fromDayNum(st.today).y === log.y && !log.items.some(i => i.id === d.id)) {
        log.items.push({ id: d.id, name, birthday: false, type: 'date', start: st.today, days: 1, kept: !missed, result });
        log.items.sort((a, b) => a.start - b.start);
    }
    st.recaps = st.recaps || [];
    if (!st.recaps.some(r => r.hid === d.id)) st.recaps.push({ hid: d.id, name, text: missed ? L().dateMissed : d.recap || null, parts: missed ? null : dateParts(d), result });
    st.flashbacks = st.flashbacks || [];
    if (!st.flashbacks.some(f => f.id === `fb-${d.id}`)) st.flashbacks.push({ id: `fb-${d.id}`, title: name, text: missed ? L().dateMissed : d.recap || L().dateResult[d.result], when: st.when, kind: 'date', parts: missed ? null : dateParts(d), result });
    if (!missed && !d.recap) { st.dateRecapFor = d.id; st.dateRecapTurn = st.turn; }
}
function applyDateRecap(st, id, text, best) {
    const r = (st.recaps || []).find(x => x.hid === id);
    if (r) { r.text = text; r.parts = { ...(r.parts || { done: [], gifts: [] }), best: best || r.parts?.best || null }; }
    const f = (st.flashbacks || []).find(x => x.id === `fb-${id}`);
    if (f) { f.text = text; if (r) f.parts = r.parts; }
    if (st.date?.id === id) { st.date.recap = text; if (best) st.date.best = best; }
    st.dateRecapFor = null;
}
/** {{char}} думал о свидании в последних ответах? Тогда не подталкиваем */
function dateMentioned() {
    const d = state?.date;
    if (!d || d.status !== 'scheduled') return false;
    const bots = chat.filter(m => m && !m.is_user && !m.is_system && m.mes).slice(-2).map(m => String(m.mes).replace(/<!--[\s\S]*?-->/g, ' ')).join(' ').toLowerCase().replace(/ё/g, 'е');
    if (/свидан|\bdate\b/.test(bots)) return true;
    const words = String(d.title || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(w => w.length >= 5).map(w => w.slice(0, w.length - 2));
    return words.some(w => bots.includes(w));
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
        || (!i.birthday && !it.birthday && i.type !== 'date' && it.type !== 'date' && namesMatch(i.name, it.name) && Math.abs(i.start - it.start) <= 3)
        || (i.birthday && it.birthday && i.who === it.who));
    if (same) { same.kept = same.kept || it.kept; return; }
    log.items.push(it);
    log.items.sort((a, b) => a.start - b.start);
    if (log.items.length > 40) log.items = log.items.slice(-40);
}

function logPast() {
    const log = ensureYear();
    if (!log) return;
    // Отмеченные раньше (до появления вкладки или до начала учёта) — по итогам этого года
    for (const r of state.recaps || []) {
        if (String(r.hid || '').startsWith('d-')) continue;          // свидания вносятся сами, при завершении
        const m = String(r.hid || '').match(/(?:@|-)(-?\d+)$/);   // «название@день» или «bday-user-день»
        const start = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(start) || start >= state.today || fromDayNum(start).y !== log.y) continue;
        if (log.items.some(i => i.id === r.hid)) continue;
        const h = (state.holidays || []).find(x => holidayId(x) === r.hid);
        const bday = String(r.hid).match(/^bday-(user|char)-/);
        log.items.push({ id: r.hid, name: bday ? null : r.name, birthday: !!bday, who: bday?.[1], type: h?.type || 'folk', start, days: h?.days || 1, kept: true });
        log.items.sort((a, b) => a.start - b.start);
    }
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
    for (const map of ['charLog', 'highlights', 'care', 'gifts', 'giftTo', 'recapDone', 'lived']) {
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
    for (const map of ['charLog', 'care', 'gifts', 'giftTo']) if (st[map]) delete st[map][id];
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
            type: i.birthday ? 'personal' : i.type, iso: isoOf(i.start), kept: i.kept, result: i.result || null,
            recap: state.recaps.find(r => r.hid === i.id)?.text || (i.type === 'date' && i.result && i.result !== 'missed' ? L().dateResult[i.result] : null),
            parts: state.recaps.find(r => r.hid === i.id)?.parts || null,
        })),
        flashbacks: clone(state.flashbacks.slice(-10).reverse()),
        pair: state.pair ? clone(state.pair) : null,
        // намеченное свидание — в инфоблоке, праздник сейчас или нет
        planned: state.date?.status === 'scheduled' ? { title: state.date.title, goal: state.date.goal, where: state.date.where, when: dateWhenText(state, state.date.at) } : null,
        cast: (state.cast || []).filter(c => !castBanned(state, c.name)).map(c => ({ ...clone(c), bdayIn: bdayIn(c, state.today), age: ageOf(c, state.today) })),
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
                evts: clone(state.evts.filter(e => e.hid === hid)),
                charGift: state.charGift?.hid === hid ? { text: state.charGift.text, done: state.charGift.done } : null,
                giftTo: giftTarget(state, phase.h, getUserName(), getCharName()),
                gifts: hasGifts(state, phase.h) && giftTarget(state, phase.h, getUserName(), getCharName()).toLowerCase() !== getCharName().toLowerCase(),
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
let sideErr = null;         // { N, why } — последний запрос упал (для кнопки «повторить»)

const sideLoading = () => !!side && side.N === lastProcessedMsg();
function sideMarkHtml() {
    if (sideErr && sideErr.N === lastProcessedMsg()) {
        return `<i class="fa-solid fa-rotate-right ht-retry" role="button" tabindex="0" data-act="side-retry" title="${esc(`${L().sideFail}: ${sideErr.why}. ${L().sideRetry}`)}"></i>`;
    }
    return '';
}

function sideBusyFor(id) { return !!side && side.N === id; }

function cancelSide() {
    if (side) { try { side.ctl.abort(); } catch (e) { /* пусто */ } side = null; scheduleRenderAll(); }
}

/** Решить, нужен ли запрос после ответа N, и отправить */
function maybeSide(N, force = false, extra = []) {
    if (!apiOn() || !state || generating) return;
    const msg = chat[N];
    if (!msg || msg.is_user || msg.is_system || N !== lastProcessedMsg()) return;
    if (msg.extra?.ht_side?.[hashText(msg.mes)] && !force) return;       // к этому тексту уже есть
    const phase = phaseOf(state);
    const needs = sideNeeds(state, phase);
    for (const k of extra) needs.add(k);
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
    sideErr = null;
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
        ctx.castHint = castHint();
        // перепись людей читает больше сообщений, чем обычный запрос
        // ход свидания судим только по новым сообщениям — помечаем их [NEW]
        const newFrom = needs.has('date') ? (state.dateSeenMsg != null && state.dateSeenMsg < N ? state.dateSeenMsg : Math.max(-1, N - 2)) : null;
        const src = await gatherSources(N, needs.has('census') ? Math.max(sideDepth(), CENSUS_DEPTH) : sideDepth(), newFrom);
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
        sideErr = { N, why };
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
const ui = { open: new Map(), tab: new Map(), confirmDel: null, editing: null, offerSeen: new Set(), firstSeen: new Map(), nodes: new Map() };

const TYPE_ICON = {
    religious: 'fa-church', folk: 'fa-wheat-awn', seasonal: 'fa-leaf', state: 'fa-flag',
    personal: 'fa-cake-candles', family: 'fa-house-chimney', supernatural: 'fa-ghost', fast: 'fa-hourglass-half', memorial: 'fa-feather', date: 'fa-heart',
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
    if (!isEnabled()) { document.querySelectorAll('.ht-ib, .ht-cards').forEach(b => b.remove()); ui.nodes.clear(); return; }
    if (!state && chat.length) loadState();
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderBlock(Number(el.getAttribute('mesid'))));
    updateDateWhy();
}

// ─── Где кончается текст ответа ───
// Расширения картинок и другие кладут свои изображения и блоки в конец .mes_text. «Снизу» — это сразу
// после последнего куска текста, до этого хвоста; карточки решений — там же, независимо от положения инфоблока
const TAIL_TAGS = /^(IMG|VIDEO|AUDIO|IFRAME|PICTURE|FIGURE|CANVAS|SVG|OBJECT|EMBED|BR|HR|STYLE|SCRIPT|TEMPLATE|LINK|META|BUTTON|INPUT|TEXTAREA|SELECT)$/;
const BOX_TAGS = /^(DIV|SECTION|ASIDE|DETAILS|FORM|NAV)$/;
const isOurs = (n) => n.nodeType === 1 && (n.classList.contains('ht-ib') || n.classList.contains('ht-cards'));
function hasText(n) {
    if (n.nodeType === 3) return !!n.textContent.trim();
    if (n.nodeType !== 1 || isOurs(n) || TAIL_TAGS.test(String(n.tagName).toUpperCase())) return false;
    return !!n.textContent.trim();                         // пустой абзац или абзац из одних картинок — не текст
}
// чужой блок: контейнер с классом или id — разметка самого ответа их не ставит
const foreignBox = (n) => n.nodeType === 1 && BOX_TAGS.test(String(n.tagName).toUpperCase()) && !!(n.className || n.id);
function textEnd(text) {
    const nodes = [...text.childNodes];
    for (let i = nodes.length - 1; i >= 0; i--) if (hasText(nodes[i]) && !foreignBox(nodes[i])) return nodes[i];
    // весь ответ в чужой обёртке — тогда хотя бы после последнего текста
    for (let i = nodes.length - 1; i >= 0; i--) if (hasText(nodes[i])) return nodes[i];
    return null;
}
const putAfter = (ref, el) => { if (ref.nextSibling !== el) ref.parentNode.insertBefore(el, ref.nextSibling); };

// Уже стоит сразу после текста — не двигаем: иначе блок прыгает, пока картинки и чужие блоки дорисовываются
function settled(node) {
    if (!node.isConnected) return false;
    let p = node.previousSibling;
    while (p && (isOurs(p) || p.nodeType === 8 || (p.nodeType === 3 && !p.textContent.trim()))) p = p.previousSibling;
    return !!p && hasText(p) && !foreignBox(p) && !p.classList?.contains('mes_text');
}

// Карточки решений (свидание, ивент, повод) всегда идут сразу за инфоблоком — где бы он ни стоял по настройкам
function placeBlock(mesEl, block, cards = null) {
    const text = mesEl.querySelector('.mes_text');
    if (!text) return false;
    const pos = position();
    if (pos === 'top') {
        if (text.previousSibling !== block) text.insertAdjacentElement('beforebegin', block);
    } else if (pos === 'middle') {
        if (!(block.parentNode === text && settled(block))) {
            // между абзацами посередине ответа
            const parts = [...text.children].filter(el => !isOurs(el) && hasText(el) && !foreignBox(el));
            if (parts.length >= 2) putAfter(parts[Math.ceil(parts.length / 2) - 1], block);
            else putAfter(textEnd(text) || text, block);
        }
    } else if (!(mesEl.contains(block) && settled(block))) {
        putAfter(textEnd(text) || text, block);
    }
    if (cards) putAfter(block, cards);
    return true;
}

// Таверна и другие расширения перерисовывают текст ответа и стирают наши блоки. Возвращаем их сразу,
// в том же такте, до отрисовки — без мигания и прыжков (а не через таймер, как раньше)
function reattach() {
    if (!isEnabled()) return;
    for (const [id, n] of ui.nodes) {
        if (n.block.isConnected && (!n.cards || n.cards.isConnected) && (position() !== 'bottom' || settled(n.block))) continue;
        const el = getMesEl(id);
        if (!el) { if (!n.block.isConnected) ui.nodes.delete(id); continue; }
        const old = el.querySelector('.ht-ib');
        if (old && old !== n.block) { ui.nodes.delete(id); continue; }    // уже нарисован заново
        placeBlock(el, n.block, n.cards);
    }
}

/** Есть ли у последнего ответа карточки решений: свидание, ивент, повод из истории */
const cardsDue = () => !!state && (['offered', 'active'].includes(state.date?.status) || !!offeredEvent(state) || !!(state.offers || []).length);

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
    let cards = el.querySelector('.ht-cards');
    const view = sanitizeView(state && msg && !msg.is_user && !msg.is_system ? (live ? liveView() : msg.extra?.ht) : null);
    const show = isEnabled() && view && (live || showPrev());
    if (!show) { block?.remove(); cards?.remove(); ui.nodes.delete(id); return; }

    if (!block) {
        block = document.createElement('div');
        block.className = 'ht-ib';
        bindBlock(block);
    }
    // карточки решений — только у последнего ответа, своей плашкой прямо под текстом
    const cardsHtml = live ? dateCardHtml() + eventCardHtml() + offerHtml() : '';
    if (cardsHtml && !cards) {
        cards = document.createElement('div');
        cards.className = 'ht-cards';
        bindBlock(cards);
    } else if (!cardsHtml && cards) { cards.remove(); cards = null; }
    if (!placeBlock(el, block, cards)) return;
    ui.nodes.set(id, { block, cards });
    block.dataset.mesid = String(id);
    const open = ui.open.get(id) || false;
    block.classList.toggle('ht-open', open);
    // пока помощник читает историю — заставка: кольцо крутится, по шапке бежит блик, содержимое приглушено
    const loading = live && sideLoading();
    block.classList.toggle('ht-loading', loading);
    const plannedMark = view.planned ? `<i class="fa-solid fa-heart ht-head-date" title="${esc(`${L().datePlanned}: ${view.planned.title}${view.planned.when ? ` · ${view.planned.when}` : ''}`)}"></i>` : '';
    block.innerHTML = headHtml(view, open, (live ? sideMarkHtml() : '') + plannedMark, loading) + (open ? bodyHtml(view, live, ui.tab.get(id) || 'now') : '');
    if (cards) {
        cards.dataset.mesid = String(id);
        cards.classList.toggle('ht-loading', loading);
        // та же разметка — не трогаем: идущая анимация (смена шагов, появление) не обрывается
        if (cards._html !== cardsHtml) { cards.innerHTML = cardsHtml; cards._html = cardsHtml; }
    }
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

function headHtml(view, open, mark = '', loading = false) {
    let title, sub = '';
    const h = view.h;
    if (view.kind === 'today' && h) {
        title = L().today(h.name);
        // название дня, совпадающее с названием праздника, не повторяем
        const pt = view.plan?.title && !namesMatch(view.plan.title, h.name) ? view.plan.title : '';
        // коротко: название дня, «день N из M» или часть суток — смысл праздника есть ниже
        sub = pt || (h.days > 1 ? L().dayOf(view.dayIndex, h.days) : (view.part ? L().part[view.part] : ''));
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
        sub = view.diag ? L().diag[view.diag] + (view.diagNames?.length ? `. ${L().diagGot}: ${view.diagNames.join(', ')}` : '') : (apiOn() ? '' : L().soon);
    }
    const icon = h ? TYPE_ICON[h.birthday ? 'personal' : h.type] || 'fa-star' : 'fa-calendar-days';
    if (loading) sub = L().sideBusy;
    return `<div class="ht-head" role="button" tabindex="0" data-act="toggle" aria-expanded="${open}">
        ${loading ? `<span class="ht-ring ht-ring-wait"><i class="fa-solid fa-feather-pointed"></i></span>` : ring(view)}
        <span class="ht-head-text">
            <span class="ht-title"><i class="fa-solid ${icon}"></i>${esc(title)}</span>
            ${sub ? `<span class="ht-sub${view.diag && !h ? ' ht-sub-wrap' : ''}">${esc(sub)}</span>` : ''}
        </span>
        ${mark}
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

// ═══ Свидания ═══
// Карточка под шапкой последнего инфоблока: предложение (принять / отклонить) или идущее свидание —
// цель, шкала успеха, шаги (можно отмечать самому), «завершить».
// цвет успеха: от серого к насыщенному розовому
const romMix = (v) => `color-mix(in srgb, var(--ht-rom-hot) ${Math.max(6, Math.min(100, Math.round(v)))}%, #8d8792)`;
// анимация показывается один раз: дальше та же разметка без смены (перерисовка не обрывает её)
function freshFor(key, ms = 4000) {
    const now = Date.now(), t = ui.firstSeen.get(key);
    if (t == null) { ui.firstSeen.set(key, now); return true; }
    return now - t < ms;
}
/** Когда назначено — для игрока */
function dateWhenText(st, at) {
    if (!at) return '';
    if (at.now) return L().dateNow;
    const d = st.today != null ? (at.day ?? st.today) - st.today : 0;
    const hh = at.clock != null ? `${String(Math.floor(at.clock)).padStart(2, '0')}:${String(Math.round((at.clock % 1) * 60)).padStart(2, '0')}` : '';
    return L().dateAt(d, hh);
}

function dateCardHtml() {
    const d = state?.date;
    if (!d || (d.status !== 'offered' && d.status !== 'active')) return '';
    const fresh = freshFor(`date:${d.id}:${d.status}`);
    const u = getUserName(), c = getCharName();
    const portrait = `<span class="ht-portrait">${avaHtml(charAvatarUrl(), c)}<span class="ht-ava-pin">${avaHtml(userAvatarUrl(), u, 'ht-ava-round')}</span></span>`;
    if (d.status === 'offered') {
        const when = [d.where, dateWhenText(state, d.at)].filter(Boolean).join(' · ');
        return `<div class="ht-offer ht-date${fresh ? ' ht-offer-new' : ''}">
            <div class="ht-dhead">${portrait}<div class="ht-dmain">
                <span class="ht-dinvite"><i class="fa-solid fa-heart"></i>${esc(L().dateInvite(c))}</span>
                <b class="ht-dtitle">${esc(d.title)}</b>${when ? `<span class="ht-dwhen">${esc(when)}</span>` : ''}</div></div>
            ${d.goal ? `<p class="ht-offer-mean"><i class="fa-solid fa-bullseye"></i> ${esc(d.goal)}</p>` : ''}
            ${d.hook ? `<p class="ht-offer-mean">${esc(d.hook)}</p>` : ''}
            <div class="ht-offer-actions ht-two">
                <button class="ht-btn ht-btn-main" data-act="date-yes" title="${esc(L().evGo)}"><i class="fa-solid fa-heart"></i><span>${L().evGo}</span></button>
                <button class="ht-btn ht-btn-quiet" data-act="date-no" title="${esc(L().decline)}"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
            </div>
        </div>`;
    }
    // идёт: портрет {{char}} с кружком {{user}}, рядом полоска «как идёт», шкала, цель, мысль, живые шаги
    const lvl = dateLevel();
    const g = d.goalDone ? 'done' : goalOpen(d, lvl) ? 'open' : 'locked';
    const whoTxt = (w) => (w === 'user' ? u : w === 'char' ? c : L().dateBoth);
    const open = openSteps(d);
    const step = (x, cls = '') => `<button class="ht-date-step ht-who-${x.who} ${cls}" data-act="date-step" data-n="${x.n}"${x.state !== 'open' ? ' disabled tabindex="-1"' : ''}>
        <i class="fa-${x.state === 'done' ? 'solid fa-heart' : x.state === 'failed' ? 'solid fa-heart-crack' : 'regular fa-heart'}"></i><span>${esc(x.t)}</span><em>${esc(whoTxt(x.who))}</em></button>`;
    const slots = [];
    for (let i = 0; i < DATE_OPEN; i++) {
        const cur = open.find(x => x.slot === i);
        // шаг закрылся в этом ответе — медленная смена: старый зачёркивается и уходит, новый въезжает на его место
        const gone = d.steps.filter(x => x.slot === i && x.state !== 'open' && x.endTurn === state.turn).slice(-1)[0];
        const swap = gone && freshFor(`step:${d.id}:${gone.n}`, 5000);
        if (!cur && !swap) continue;
        slots.push(`<div class="ht-slot">${swap ? step(gone, `ht-step-out ht-step-${gone.state}`) : ''}${cur ? step(cur, swap ? 'ht-step-in' : '') : ''}</div>`);
    }
    const hearts = Math.min(5, Math.floor(d.score / 18));
    const notes = (d.notes || []).slice(-3).reverse().map(n => `<li class="${n.ok ? '' : 'ht-bad'}"><i class="fa-solid ${n.ok ? 'fa-check' : 'fa-xmark'}"></i><span>${esc(n.t)}</span></li>`).join('');
    const tone = romMix(d.score);
    return `<div class="ht-offer ht-date ht-date-on${fresh ? ' ht-offer-new' : ''}" style="--v:${d.score};--c:${tone}">
        <span class="ht-dhearts" aria-hidden="true">${'<i class="fa-solid fa-heart"></i>'.repeat(hearts)}</span>
        <div class="ht-dhead">${portrait}
            <span class="ht-dstrip" title="${esc(d.vibe || L().dateVibeStart)}"><i></i></span>
            <div class="ht-dmain">
                <b class="ht-dtitle">${esc(d.title)}</b>
                ${d.where ? `<span class="ht-dwhen">${esc(d.where)}</span>` : ''}
                <span class="ht-dvibe">${esc(d.vibe || L().dateVibeStart)}</span>
            </div>
            <b class="ht-date-pct">${d.score}%</b>
        </div>
        <div class="ht-date-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${d.score}"><i></i></div>
        ${d.goal ? `<div class="ht-dgoal ht-goal-${g}"><i class="fa-solid ${g === 'done' ? 'fa-circle-check' : g === 'open' ? 'fa-bullseye' : 'fa-lock'}"></i><span><b>${L().dateGoal}:</b> ${esc(d.goal)}</span><em>${esc(L().goalState[g])}</em></div>` : ''}
        ${d.thought ? `<p class="ht-dthought"><span>${L().dateThinks}</span>«${esc(d.thought.replace(/^[«"“]+|[»"”]+$/g, ''))}»</p>` : ''}
        <div class="ht-date-steps">${slots.join('') || `<p class="ht-mute">${L().dateNoSteps}</p>`}</div>
        ${notes ? `<ul class="ht-dnotes" aria-label="${esc(L().dateNotes)}">${notes}</ul>` : ''}
        <div class="ht-offer-actions ht-one"><button class="ht-btn ht-btn-quiet" data-act="date-end"><i class="fa-solid fa-flag-checkered"></i><span>${L().dateFinish}</span></button></div>
    </div>`;
}

// Решения игрока по свиданию — и в снимки, чтобы пережили свайпы
function changeDate(fn) {
    const id = state.date?.id;
    if (!id) return;
    fn(state);
    applyToSnapshots(st => { if (st.date?.id === id) fn(st); });
    saveState();
    injectPrompts();
    renderAll();
}
function decideDate(yes) {
    const d = state.date;
    if (!d || d.status !== 'offered') return;
    state.dateDecisions = { ...(state.dateDecisions || {}), [String(d.title).toLowerCase()]: yes ? 'accepted' : 'declined' };
    changeDate(st => {
        // на потом — «намечено» в инфоблоке, без шкалы и шагов; прямо сейчас — начинается
        if (yes) acceptInto(st, st.date);
        else { st.dateDeclined = { title: st.date.title, turn: st.turn }; st.date = null; st.lastDateEnd = st.turn; }
    });
}
function endDateNow() {
    if (state.date?.status !== 'active') return;
    let done = null;
    changeDate(st => {
        const d = finishDate(st, st.turn);
        if (d) recordDate(st, d);
        if (st === state) done = d;
    });
    if (done) {
        saveState();
        renderAll();
        showDateToast(done);
        if (apiOn()) maybeSide(lastProcessedMsg(), true, ['daterecap']);   // итог допишет помощник
    }
}

// Уведомление об итоге свидания — посреди экрана, один раз, закрывается само или по нажатию
const dateToasted = new Set();
function showDateToast(d) {
    if (!d || dateToasted.has(d.id) || typeof document?.createElement !== 'function') return;
    dateToasted.add(d.id);
    const el = document.createElement('div');
    el.className = `ht-date-toast ht-date-${d.result}`;
    el.setAttribute('role', 'status');
    const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
    el.innerHTML = `<div class="ht-date-toast-card">
        <div class="ht-date-hearts"><i class="fa-solid fa-heart"></i><i class="fa-solid fa-heart"></i><i class="fa-solid fa-heart"></i></div>
        <span>${esc(L().dateOver)}</span>
        <b>${esc(L().dateResult[d.result])}</b>
        <p>${esc(d.title)} · ${d.score}%</p>
        ${d.delta && (d.delta.r || d.delta.f) ? `<p class="ht-date-delta"><i class="fa-solid fa-heart"></i> ${esc(L().romance)} ${sign(d.delta.r)} · <i class="fa-solid fa-handshake"></i> ${esc(L().friendship)} ${sign(d.delta.f)}</p>` : ''}
    </div>`;
    const close = () => { el.classList.add('ht-out'); setTimeout(() => el.remove(), 300); };
    el.addEventListener('click', close);
    document.body.appendChild(el);
    setTimeout(close, 7000);
}

// ═══ Вкладка «Люди»: галерея карточек ═══
// Сверху — {{char}} и {{user}}; дальше люди по подвкладкам: все · родня {{user}} · родня {{char}} · знакомые.

// Аватарки: бот и персона — из таверны; остальным игрок ставит свою картинку (ужимаем до 112 px, ~5 КБ)
let personaMod = null;
import('../../../personas.js').then(m => { personaMod = m; }).catch(() => { /* старая таверна — возьмём из чата */ });
function charAvatarUrl() {
    const ch = this_chid !== undefined ? characters[this_chid] : null;
    return ch?.avatar && ch.avatar !== 'none' ? `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}` : null;
}
function userAvatarUrl() {
    const f = personaMod?.user_avatar;
    if (f) return `/thumbnail?type=persona&file=${encodeURIComponent(f)}`;
    return document.querySelector?.('.mes[is_user="true"] .avatar img')?.getAttribute('src') || null;
}
const avatars = () => (chat_metadata.ht_avatars = chat_metadata.ht_avatars || {});
async function shrinkImage(file, size = 112) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const k = Math.max(size / img.width, size / img.height);
        const w = img.width * k, h = img.height * k;
        c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        return c.toDataURL('image/jpeg', 0.82);
    } finally { URL.revokeObjectURL(url); }
}
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
const avaHtml = (src, name, cls = '') => src
    ? `<span class="ht-ava ${cls}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></span>`
    : `<span class="ht-ava ht-ava-none ${cls}">${esc(initials(name))}</span>`;

// маленькая шкала, как в «Симс»: от середины — вправо зелёным (хорошо), влево красным (плохо);
// под ней — как они ладят, своими словами ИИ (или ступень, если слов нет)
const barHtml = (n) => {
    const v = Math.max(-100, Math.min(100, n ?? 0));
    return `<span class="ht-mini-bar${v < 0 ? ' ht-neg' : ''}" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${v}"><i style="--v:${Math.abs(v)};--h:${Math.round((v + 100) * 0.6)}"></i></span>`;
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
function miniBar(src, who, n, note) {
    const words = note || L().rel[relLevel(n ?? 0)];
    return `<div class="ht-mini" title="${esc(`${who}: ${signed(n ?? 0)} · ${words}`)}">
        <span class="ht-mini-row">${avaHtml(src, who, 'ht-ava-xs')}<b>${signed(n ?? 0)}</b></span>${barHtml(n)}</div>`;
}

const CAST_TABS = ['all', 'kin_user', 'kin_char', 'kin_both', 'others'];
const inCastTab = (p, t) => t === 'all' || (t === 'others' ? !KIN_GROUPS.includes(p.group) : p.group === t);

function castTabHtml(view, live) {
    const list = view.cast || [];
    const u = getUserName(), c = getCharName();
    const uA = userAvatarUrl(), cA = charAvatarUrl();
    const tab = CAST_TABS.includes(ui.castTab) ? ui.castTab : 'all';
    const tabLabel = { all: L().castAll, kin_user: L().kinOf(u), kin_char: L().kinOf(c), kin_both: L().kinBoth, others: L().castOthers };
    const subtabs = `<div class="ht-subtabs" role="tablist">${CAST_TABS.map(t => {
        const n = list.filter(p => inCastTab(p, t)).length;
        if (t === 'kin_both' && !n && tab !== t) return '';          // общей семьи нет — и подвкладки нет
        return `<button role="tab" class="${t === tab ? 'ht-on' : ''}" data-act="cast-tab" data-tab="${t}" aria-selected="${t === tab}">${esc(tabLabel[t])}${n ? `<em>${n}</em>` : ''}</button>`;
    }).join('')}</div>`;

    // {{char}} и {{user}} — первая карточка, шире остальных, видна всегда; романтика — розовая подсветка и бьющееся сердце.
    // Пока модель не прислала bond — нули и «пока не ясно»; игрок может выставить сам
    const pr = view.pair || { ...PAIR_DEFAULT, unknown: true };
    const rl = romLevel(pr.r);
    const dateLine = live ? dateWhyText() : '';
    // {{char}} — портрет в подсвеченной рамке; {{user}} — маленький круглый значок, прикреплённый сбоку
    const pair = tab === 'all' ? `<div class="ht-cc ht-cc-pair${pr.r > 0 ? ' ht-cc-love' : ''}${pr.unknown ? ' ht-cc-unknown' : ''}">
        <span class="ht-portrait ht-portrait-lg">${avaHtml(cA, c)}<span class="ht-ava-pin" title="${esc(u)}">${avaHtml(uA, u, 'ht-ava-round')}</span>${pr.r > 0 ? '<i class="fa-solid fa-heart ht-pair-mid"></i>' : ''}</span>
        <b class="ht-cc-name">${esc(c)}</b>
        ${pr.unknown ? `<span class="ht-cc-role ht-mute">${esc(L().pairUnknown)}</span>` : pr.note ? `<span class="ht-cc-role">${esc(pr.note)}</span>` : ''}
        <div class="ht-pair-bars">
            <div class="ht-mini" title="${esc(`${L().friendship}: ${signed(pr.f)} · ${L().rel[relLevel(pr.f)]}`)}"><span class="ht-mini-row"><i class="fa-solid fa-handshake ht-mini-ico"></i>${esc(L().friendship)}<b>${signed(pr.f)}</b></span>${barHtml(pr.f)}</div>
            <div class="ht-mini ht-mini-rom" title="${esc(`${L().romance}: ${signed(pr.r)} · ${L().rom[rl]}`)}"><span class="ht-mini-row"><i class="fa-solid fa-heart ht-mini-ico"></i>${esc(L().romance)}<b>${signed(pr.r)}</b></span>${barHtml(pr.r)}</div>
        </div>
        ${pr.r !== 0 ? `<span class="ht-rom-chip${pr.r < 0 ? ' ht-rom-neg' : ''}"><i class="fa-solid fa-heart"></i>${esc(L().rom[rl])}</span>` : ''}
        ${dateLine ? `<span class="ht-pair-date"><i class="fa-solid fa-heart"></i>${esc(L().dateWord)}: ${esc(dateLine)}</span>` : ''}
        ${live ? `<div class="ht-cc-tools"><button data-act="pair-edit" title="${esc(L().pairEdit)}" aria-label="${esc(L().pairEdit)}"><i class="fa-solid fa-pen"></i></button></div>` : ''}
    </div>` : '';

    const ava = avatars();
    const card = (p) => {
        const key = `cast:${p.id}`;
        const d = p.bdayIn;
        const near = d != null && d <= 30 ? (d === 0 ? ' ht-bd-today' : d <= 7 ? ' ht-bd-near' : ' ht-bd-soon') : '';
        const name = p.name || L().noName;
        const roles = [p.toU && `${u}: ${p.toU}`, p.toC && `${c}: ${p.toC}`].filter(Boolean);
        const romSet = p.rom?.user || p.rom?.char;
        const confirm = ui.confirmDel === key;
        return `<div class="ht-cc${near}${p.off ? ' ht-cc-off' : ''}" data-cid="${esc(p.id)}">
            <div class="ht-cc-top">${avaHtml(ava[p.id], name)}${romSet ? `<i class="fa-solid fa-heart ht-cc-heart" title="${esc([p.rom.user && `${u}: ${L().rom[p.rom.user]}`, p.rom.char && `${c}: ${L().rom[p.rom.char]}`].filter(Boolean).join(' · '))}"></i>` : ''}</div>
            <b class="ht-cc-name${p.name ? '' : ' ht-cc-noname'}">${esc(name)}</b>
            ${roles.length ? `<span class="ht-cc-role">${roles.map(esc).join('<br>')}</span>` : ''}
            ${d != null && d <= 30 ? `<span class="ht-cc-bd"><i class="fa-solid fa-cake-candles"></i>${esc(L().bdayIn(d, daysWord))}</span>` : ''}
            <div class="ht-cc-bars">${miniBar(uA, u, p.rel?.user ?? 0, p.note?.user)}${miniBar(cA, c, p.rel?.char ?? 0, p.note?.char)}</div>
            <details class="ht-cc-status"><summary>${L().status}<i class="fa-solid fa-chevron-down"></i></summary>
                <p><b>${esc(u)}:</b> ${esc(p.note?.user || L().rel[relLevel(p.rel?.user ?? 0)])}</p>
                <p><b>${esc(c)}:</b> ${esc(p.note?.char || L().rel[relLevel(p.rel?.char ?? 0)])}</p>
            </details>
            ${live ? `<div class="ht-cc-tools">
                <button data-act="cast-eye" data-cid="${esc(p.id)}" title="${esc(p.off ? L().castOn : L().castOff)}" aria-pressed="${!p.off}"><i class="fa-solid ${p.off ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
                <button data-act="cast-edit" data-cid="${esc(p.id)}" title="${esc(L().edit)}"><i class="fa-solid fa-pen"></i></button>
                <button class="${confirm ? 'ht-del-confirm' : ''}" data-act="cast-del" data-cid="${esc(p.id)}" title="${esc(confirm ? L().removeSure : L().remove)}"><i class="fa-solid ${confirm ? 'fa-check' : 'fa-trash-can'}"></i></button>
            </div>` : ''}
        </div>`;
    };
    const shown = list.filter(p => inCastTab(p, tab));
    // в «Все» — общая семья, родня {{user}}, родня {{char}}, потом остальные
    const order = { kin_both: 0, kin_user: 1, kin_char: 2, friend: 3, acquaintance: 4, other: 5 };
    shown.sort((a, b) => (order[a.group] ?? 6) - (order[b.group] ?? 6));
    const cards = shown.map(card).join('');
    // кого часто называют в истории, а в списке нет — добавить одним нажатием (роли допишет ИИ)
    const hints = live && tab === 'all' ? castHint().slice(0, 6) : [];
    const hintRow = hints.length ? `<div class="ht-hints"><span><i class="fa-solid fa-user-plus"></i>${L().hintTitle}</span>${hints.map(x =>
        `<button data-act="cast-hint" data-name="${esc(x.name)}" title="${esc(L().hintAdd(x.name))}">${esc(x.name)}<em>${x.n}</em></button>`).join('')}</div>` : '';
    return `${subtabs}<div class="ht-gallery">${pair}${cards || (pair ? '' : `<p class="ht-mute ht-gallery-empty">${L().castEmpty}</p>`)}</div>${hintRow}`;
}

// Итог праздника — под спойлером «Итог», чтобы список был коротким
function recapSpoiler(text, parts) {
    if (!text && !parts) return '';
    return `<details class="ht-recap"><summary><i class="fa-solid fa-scroll"></i><span>${L().recapTitle}</span><i class="fa-solid fa-chevron-down ht-recap-chev"></i></summary>
        ${text ? `<p>${esc(text)}</p>` : ''}${recapPartsHtml(parts)}</details>`;
}

// Короткий итог праздника по пунктам: сделали · подарки · лучший момент
function recapPartsHtml(p) {
    if (!p) return '';
    const row = (icon, items) => items?.length ? `<li><i class="fa-solid ${icon}"></i><span>${items.map(esc).join(' · ')}</span></li>` : '';
    return `<ul class="ht-recap-parts">${row('fa-list-check', p.done)}${row('fa-gift', p.gifts)}${row('fa-star', p.best ? [p.best] : [])}</ul>`;
}

// Правка человека — отдельным окном поверх таверны: перерисовки чата его не сбрасывают,
// на телефоне — на весь экран, поля крупные
function closeCastEditor() {
    const d = document.querySelector('.ht-modal');
    if (!d) return;
    try { d.close?.(); } catch (e) { /* пусто */ }
    d.remove();
}
function openCastEditor(cid) {
    try { openCastEditorRaw(cid); } catch (e) {
        console.error('[Hearthtide] окно правки:', e);
        window.toastr?.error?.(`${L().editFail}: ${e?.message || e}`, 'Hearthtide');
    }
}
function openCastEditorRaw(cid) {
    closeCastEditor();
    const p = (state.cast || []).find(c => c.id === cid);
    if (!p) { window.toastr?.warning?.(L().editGone, 'Hearthtide'); return; }
    // <dialog> через showModal() браузер кладёт в «верхний слой» — поверх всего, что есть у таверны
    const native = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;
    const wrap = document.createElement(native ? 'dialog' : 'div');
    wrap.className = 'ht-modal';
    if (!native) { wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); }
    const draw = () => {
        wrap.innerHTML = `<div class="ht-modal-card">
            <div class="ht-modal-title"><i class="fa-solid fa-user-pen"></i>${esc(p.name || L().noName)}<button type="button" data-act="edit-cancel" aria-label="${esc(L().cancel)}"><i class="fa-solid fa-xmark"></i></button></div>
            ${castFormHtml(p, avatars()[cid])}</div>`;
    };
    draw();
    wrap.addEventListener('click', (e) => {
        if (e.target === wrap) { closeCastEditor(); return; }      // нажали мимо окна
        const t = e.target.closest('[data-act]');
        if (!t) return;
        const f = wrap.querySelector('.ht-edit');
        const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
        if (t.dataset.act === 'edit-cancel') closeCastEditor();
        else if (t.dataset.act === 'cast-rom') {
            t.parentElement.querySelectorAll('button').forEach(b => { b.classList.toggle('ht-on', b === t); b.setAttribute('aria-pressed', String(b === t)); });
        } else if (t.dataset.act === 'cast-photo-del') {
            delete avatars()[cid];
            saveChatDebounced();
            wrap.querySelector('.ht-cast-photo .ht-ava')?.replaceWith(Object.assign(document.createElement('span'), { className: 'ht-ava ht-ava-none', textContent: initials(p.name) }));
            t.remove();
            renderAll();
        } else if (t.dataset.act === 'cast-save') {
            const rom = (w) => f?.querySelector(`.ht-rom-pick[data-who="${w}"] .ht-on`)?.dataset.key || '';
            if (saveCast(cid, { name: val('name'), toU: val('toU'), toC: val('toC'), group: val('group'), bday: val('bday'), relU: val('relU'), relC: val('relC'), noteU: val('noteU'), noteC: val('noteC'), romU: rom('user'), romC: rom('char') })) {
                closeCastEditor();
                renderAll();
            }
        }
    });
    wrap.addEventListener('change', async (e) => {
        const inp = e.target.closest?.('input[data-act="cast-photo"]');
        if (!inp?.files?.[0]) return;
        try {
            avatars()[cid] = await shrinkImage(inp.files[0]);
            saveChatDebounced();
            const img = document.createElement('span');
            img.className = 'ht-ava';
            img.innerHTML = `<img src="${avatars()[cid]}" alt="">`;
            wrap.querySelector('.ht-cast-photo .ht-ava')?.replaceWith(img);
            renderAll();
        } catch (err) {
            console.error('[Hearthtide] картинка:', err);
            window.toastr?.warning?.(L().badPhoto, 'Hearthtide');
        }
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCastEditor(); } });
    wrap.addEventListener('cancel', (e) => { e.preventDefault(); closeCastEditor(); });
    document.body.appendChild(wrap);
    if (native) wrap.showModal();
}

function castFormHtml(p, photo) {
    const groups = CAST_GROUPS.map(g => `<option value="${g}" ${p.group === g ? 'selected' : ''}>${esc(L().castGroup(g, getUserName(), getCharName()))}</option>`).join('');
    const romRow = (who, cur) => `<div class="ht-rom-pick" data-who="${who}">${['', ...ROM_KEYS].map(k =>
        `<button type="button" data-act="cast-rom" data-who="${who}" data-key="${k}" class="${(cur || '') === k ? 'ht-on' : ''}" aria-pressed="${(cur || '') === k}">${k ? '<i class="fa-solid fa-heart"></i>' : ''}${esc(k ? L().rom[k] : L().rom.none)}</button>`).join('')}</div>`;
    return `<div class="ht-edit ht-cast-edit" data-cid="${esc(p.id)}">
        <div class="ht-cast-photo">${avaHtml(photo, p.name)}
            <label class="ht-btn"><i class="fa-solid fa-image"></i>${L().photo}<input type="file" accept="image/*" data-act="cast-photo" data-cid="${esc(p.id)}" hidden></label>
            ${photo ? `<button class="ht-btn ht-btn-quiet" data-act="cast-photo-del" data-cid="${esc(p.id)}" title="${esc(L().remove)}"><i class="fa-solid fa-xmark"></i></button>` : ''}
        </div>
        <label>${L().fName}<input class="text_pole" data-ed="name" value="${esc(p.name || '')}"></label>
        <div class="ht-edit-two">
            <label>${esc(L().toWhom(getUserName()))}<input class="text_pole" data-ed="toU" value="${esc(p.toU || '')}"></label>
            <label>${esc(L().toWhom(getCharName()))}<input class="text_pole" data-ed="toC" value="${esc(p.toC || '')}"></label>
        </div>
        <label>${L().fGroup}<select class="text_pole" data-ed="group">${groups}</select></label>
        <label>${L().fBday}<input class="text_pole" data-ed="bday" value="${esc(bdayText(p.bday))}" inputmode="numeric" placeholder="${esc(L().unknown)}"></label>
        <div class="ht-edit-two">
            <label>${esc(getUserName())} −100…100<input class="text_pole" data-ed="relU" type="number" min="-100" max="100" value="${p.rel?.user ?? 0}"></label>
            <label>${esc(getCharName())} −100…100<input class="text_pole" data-ed="relC" type="number" min="-100" max="100" value="${p.rel?.char ?? 0}"></label>
        </div>
        <div class="ht-edit-two">
            <label>${esc(L().howWith(getUserName()))}<input class="text_pole" data-ed="noteU" value="${esc(p.note?.user || '')}"></label>
            <label>${esc(L().howWith(getCharName()))}<input class="text_pole" data-ed="noteC" value="${esc(p.note?.char || '')}"></label>
        </div>
        ${isKin(p.group) ? '' : `<div class="ht-rom-field"><span><i class="fa-solid fa-heart"></i> ${esc(getUserName())}</span>${romRow('user', p.rom?.user)}
            <span><i class="fa-solid fa-heart"></i> ${esc(getCharName())}</span>${romRow('char', p.rom?.char)}</div>`}
        <div class="ht-edit-actions">
            <button class="ht-btn" data-act="edit-cancel">${L().cancel}</button>
            <button class="ht-btn ht-btn-main" data-act="cast-save" data-cid="${esc(p.id)}"><i class="fa-solid fa-check"></i>${L().save}</button>
        </div>
    </div>`;
}

// Правка человека игроком: переживает свайпы; ИИ после неё не трогает имя, роли и дату, а отношения — если игрок их менял
function saveCast(cid, f) {
    const cur = (state.cast || []).find(c => c.id === cid);
    if (!cur) return false;
    const name = String(f.name || '').trim() || null;
    const bdayRaw = String(f.bday || '').trim();
    const bday = bdayRaw ? parseBday(bdayRaw) : null;
    if (bdayRaw && !bday) { window.toastr?.warning?.(L().badBday, 'Hearthtide'); return false; }
    const relU = clampRel(f.relU), relC = clampRel(f.relC);
    const relChanged = relU !== (cur.rel?.user ?? 0) || relC !== (cur.rel?.char ?? 0)
        || String(f.noteU || '').trim() !== (cur.note?.user || '') || String(f.noteC || '').trim() !== (cur.note?.char || '');
    const group = CAST_GROUPS.includes(f.group) ? f.group : cur.group;
    const fix = {
        name, toU: String(f.toU || '').trim() || null, toC: String(f.toC || '').trim() || null, group, bday, edited: true,
        rom: isKin(group) ? { user: null, char: null } : { user: ROM_KEYS.includes(f.romU) ? f.romU : null, char: ROM_KEYS.includes(f.romC) ? f.romC : null },
    };
    const apply = (st) => {
        const x = (st.cast || []).find(c => c.id === cid);
        if (!x) return;
        Object.assign(x, fix);
        if (relChanged) {
            x.rel = { user: relU ?? 0, char: relC ?? 0 };
            x.note = { user: String(f.noteU || '').trim() || null, char: String(f.noteC || '').trim() || null };
            x.relLock = true;
        }
    };
    apply(state);
    applyToSnapshots(apply);
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().saved, 'Hearthtide');
    return true;
}

// Человек из «часто упоминаются»: вносим с именем, роли и отношения ИИ допишет при следующей проверке людей
function addCastByHand(name) {
    const n = String(name || '').trim();
    if (!n || findCast(state, n)) return;
    state.castNo = (state.castNo || []).filter(x => !samePerson(x, n));
    const c = { id: `c-${state.turn}-h-${Math.random().toString(36).slice(2, 6)}`, name: n, group: 'other', toU: null, toC: null, bday: null,
        rel: { user: 0, char: 0 }, note: { user: null, char: null }, rom: { user: null, char: null }, scale: 2, turn: state.turn, byHand: true };
    const apply = (st) => { st.cast = st.cast || []; if (!st.cast.some(x => samePerson(x.name, n))) st.cast.push(clone(c)); };
    apply(state);
    applyToSnapshots(apply);
    state.lastCastTurn = -99;            // спросить о нём в ближайшем ответе
    saveState();
    injectPrompts();
    renderAll();
}

// «Глазок»: выключенный человек не идёт в промпт, но остаётся в списке — ИИ не внесёт его заново
function toggleCastOff(cid) {
    const x = (state.cast || []).find(c => c.id === cid);
    if (!x) return;
    const off = !x.off;
    const apply = (st) => { const y = (st.cast || []).find(c => c.id === cid); if (y) y.off = off; };
    apply(state);
    applyToSnapshots(apply);
    saveState();
    injectPrompts();
    renderAll();
}

function removeCast(cid) {
    const cur = (state.cast || []).find(c => c.id === cid);
    if (!cur) return;
    if (cur.name) state.castNo = [...(state.castNo || []).filter(n => !samePerson(n, cur.name)), cur.name].slice(-60);
    const apply = (st) => { st.cast = (st.cast || []).filter(c => c.id !== cid && !(cur.name && samePerson(c.name, cur.name))); };
    apply(state);
    applyToSnapshots(apply);
    delete avatars()[cid];
    saveChatDebounced();
    saveState();
    injectPrompts();
    renderAll();
}

// ─── Пара {{char}} и {{user}}: правка игроком ───
// Ответы до правки её не перезаписывают (свайп, повторная обработка); дальше модель ведёт пару от новых значений
function savePair(f, r, note) {
    const pair = { scale: 2, f: clampRel(f) ?? 0, r: clampRel(r) ?? 0, note: String(note || '').trim().slice(0, 60) || null };
    state.pairSet = { pair, at: lastProcessedMsg() };
    state.pair = clone(pair);
    state.lastBondTurn = state.turn;
    state.bondMiss = 0;
    saveState();
    injectPrompts();
    window.toastr?.success?.(L().saved, 'Hearthtide');
    renderAll();
}

function openPairEditor() {
    try { openPairEditorRaw(); } catch (e) {
        console.error('[Hearthtide] окно правки пары:', e);
        window.toastr?.error?.(`${L().editFail}: ${e?.message || e}`, 'Hearthtide');
    }
}
function openPairEditorRaw() {
    closeCastEditor();
    const pr = state.pair || { ...PAIR_DEFAULT };
    const u = getUserName(), c = getCharName();
    const native = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;
    const wrap = document.createElement(native ? 'dialog' : 'div');
    wrap.className = 'ht-modal';
    if (!native) { wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); }
    const word = (k, v) => (k === 'f' ? L().rel[relLevel(v)] : L().rom[romLevel(v)]);
    const range = (k, icon, label, v) => `<label class="ht-range${k === 'r' ? ' ht-range-rom' : ''}">
        <span><i class="fa-solid ${icon}"></i>${esc(label)}<b data-out="${k}">${signed(v)} · ${esc(word(k, v))}</b></span>
        <input type="range" min="-100" max="100" step="1" data-ed="${k}" value="${v}" aria-label="${esc(label)}"></label>`;
    wrap.innerHTML = `<div class="ht-modal-card">
        <div class="ht-modal-title"><i class="fa-solid fa-heart"></i>${esc(L().pairTitle(c, u))}<button type="button" data-act="edit-cancel" aria-label="${esc(L().cancel)}"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="ht-edit ht-pair-edit">
            <span class="ht-portrait ht-portrait-lg">${avaHtml(charAvatarUrl(), c)}<span class="ht-ava-pin">${avaHtml(userAvatarUrl(), u, 'ht-ava-round')}</span></span>
            ${range('f', 'fa-handshake', L().friendship, pr.f)}
            ${range('r', 'fa-heart', L().romance, pr.r)}
            <label>${esc(L().pairNote)}<input class="text_pole" data-ed="note" value="${esc(pr.note || '')}" maxlength="60"></label>
            <div class="ht-edit-actions">
                <button type="button" class="ht-btn" data-act="edit-cancel">${L().cancel}</button>
                <button type="button" class="ht-btn ht-btn-main" data-act="pair-save"><i class="fa-solid fa-check"></i>${L().save}</button>
            </div>
        </div></div>`;
    const val = (k) => wrap.querySelector(`[data-ed="${k}"]`)?.value ?? '';
    wrap.addEventListener('input', (e) => {
        const k = e.target?.dataset?.ed;
        if (k !== 'f' && k !== 'r') return;
        const out = wrap.querySelector(`[data-out="${k}"]`);
        if (out) out.textContent = `${signed(+e.target.value)} · ${word(k, +e.target.value)}`;
    });
    wrap.addEventListener('click', (e) => {
        if (e.target === wrap) { closeCastEditor(); return; }
        const t = e.target.closest('[data-act]');
        if (!t) return;
        if (t.dataset.act === 'edit-cancel') closeCastEditor();
        else if (t.dataset.act === 'pair-save') { savePair(val('f'), val('r'), val('note')); closeCastEditor(); }
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeCastEditor(); } });
    wrap.addEventListener('cancel', (e) => { e.preventDefault(); closeCastEditor(); });
    document.body.appendChild(wrap);
    if (native) wrap.showModal();
}

/** Будет ли свидание после ответа и почему нет — для карточки пары и настроек */
function dateWhyText() {
    if (!state) return '';
    const di = dateChanceInfo(state, state.turn || 0, dateChanceSetting());
    const w = L().dateWhy;
    if (di.why === 'norom') return w.norom(di.r);
    if (di.why === 'cooldown') return w.cooldown(di.left, plural);
    if (di.why === 'ok' || di.why === 'quarrel') return w[di.why](di.chance);
    return w[di.why] || '';
}
function updateDateWhy() {
    const el = document.getElementById('ht-date-why');
    if (el) el.textContent = state ? dateWhyText() : '';
}

// ─── {{char}} зовёт на свидание: короткое уведомление сверху, по нажатию — к карточке ───
const inviteToasted = new Set();
function showDateInvite(d) {
    if (!d || inviteToasted.has(d.id) || typeof document?.createElement !== 'function') return;
    inviteToasted.add(d.id);
    document.querySelector('.ht-invite-toast')?.remove();
    const el = document.createElement('div');
    el.className = 'ht-invite-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<button type="button" class="ht-invite-card">
        <span class="ht-invite-hearts" aria-hidden="true"><i class="fa-solid fa-heart"></i><i class="fa-solid fa-heart"></i><i class="fa-solid fa-heart"></i></span>
        <span class="ht-invite-text"><b>${esc(L().dateInvite(getCharName()))}</b><span>${esc(d.title)}</span><em>${esc(L().dateTap)}</em></span>
    </button>`;
    let gone = false;
    const close = () => { if (gone) return; gone = true; el.classList.add('ht-out'); setTimeout(() => el.remove(), 320); };
    el.querySelector('button').addEventListener('click', () => {
        close();
        const card = document.querySelector('.ht-cards .ht-date');
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('ht-pulse');
        void card.offsetWidth;                       // перезапуск анимации
        card.classList.add('ht-pulse');
    });
    document.body.appendChild(el);
    setTimeout(close, 8000);
}

// ─── Случайный ивент: карточка под шапкой последнего инфоблока, видна и в свёрнутом ───
function eventCardHtml() {
    const e = state && offeredEvent(state);
    if (!e) return '';
    const fresh = !ui.offerSeen.has(e.id);
    ui.offerSeen.add(e.id);
    const party = e.kind === 'party';
    return `<div class="ht-offer ht-evcard${party ? ' ht-evcard-party' : ''}${fresh ? ' ht-offer-new' : ''}">
        <div class="ht-offer-cause"><i class="fa-solid ${party ? 'fa-champagne-glasses' : 'fa-dice'}"></i><span>${party ? L().evParty : L().evNew}${e.who ? ` · ${esc(e.who)}` : ''}</span></div>
        <div class="ht-offer-hol"><span><b>${esc(e.title)}</b></span></div>
        ${e.hook ? `<p class="ht-offer-mean">${esc(e.hook)}</p>` : ''}
        <div class="ht-offer-actions ht-two">
            <button class="ht-btn ht-btn-main" data-act="ev-yes" data-eid="${esc(e.id)}" title="${esc(party ? L().evGo : L().accept)}"><i class="fa-solid fa-check"></i><span>${party ? L().evGo : L().accept}</span></button>
            <button class="ht-btn ht-btn-quiet" data-act="ev-no" data-eid="${esc(e.id)}" title="${esc(L().decline)}"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
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
            <button class="ht-btn ht-btn-main" data-act="offer-yes" data-oid="${esc(o.id)}" title="${esc(L().accept)}"><i class="fa-solid fa-check"></i><span>${L().accept}</span></button>
            <button class="ht-btn" data-act="offer-edit" data-oid="${esc(o.id)}" title="${esc(L().edit)}"><i class="fa-solid fa-pen"></i><span>${L().edit}</span></button>
            <button class="ht-btn ht-btn-quiet" data-act="offer-no" data-oid="${esc(o.id)}" title="${esc(L().decline)}"><i class="fa-solid fa-xmark"></i><span>${L().decline}</span></button>
        </div>
    </div>`;
}

function bodyHtml(view, live, tab = 'now') {
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
    // в сам праздник место и дата — одной короткой строкой, эпоха и вера не занимают место
    const worldMini = [view.place || s.place, view.when].filter(Boolean).map(esc).join(' · ');

    let main = '';
    const h = view.h;
    // перо — помощник читает историю; стрелка — запрос упал, нажать, чтобы повторить
    const sideMark = live ? sideMarkHtml() : '';
    if (view.kind === 'today' && h) {
        const plan = view.plan;
        if (plan) {
            const rows = ['morning', 'day', 'evening', 'night'].filter(p => plan[p]).map(p => `
                <div class="ht-part${p === view.part ? ' ht-now' : ''}">
                    <i class="fa-solid ${PART_ICON[p]}"></i>
                    <div><b>${L().part[p]}${p === view.part ? L().now : ''}</b><span>${esc(plan[p])}</span></div>
                </div>`).join('');
            main = section('main', 'fa-fire', plan.title && !namesMatch(plan.title, h.name) ? esc(plan.title) : L().festiveDay, `<div class="ht-parts">${rows}</div>`, sideMark + editBtn(h.id) + delBtn(h.id));
        } else {
            main = section('main', 'fa-fire', L().festiveDay, `<p class="ht-text">${esc(h.meaning || '')}</p>${apiOn() ? '' : `<p class="ht-mute">${L().planSoon}</p>`}`, sideMark + editBtn(h.id) + delBtn(h.id));
        }
    } else if (view.kind === 'prep' && h) {
        const p = view.prep;
        main = section('main', 'fa-wand-magic-sparkles', L().prep, p ? `
            ${p.people ? `<p class="ht-text">${esc(p.people)}</p>` : ''}
            ${p.mood ? `<p class="ht-mood"><i class="fa-solid fa-feather-pointed"></i>${esc(p.mood)}</p>` : ''}`
            : `<p class="ht-text">${esc(h.meaning || '')}</p>${apiOn() ? '' : `<p class="ht-mute">${L().prepSoon}</p>`}`, sideMark + editBtn(h.id) + delBtn(h.id));
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
            <div><span>${esc(L().giftForUser(view.giftTo || getUserName()))}</span><b>${esc(g?.done ? (g.text || L().giftGiven) : (g?.text || L().giftUndecided))}</b></div></div>` : '';
        // прошлые шаги в инфоблок не выводим — они нужны только модели, чтобы цепочка шла дальше
        charCard = `<div class="ht-char${live && view.care === 'high' ? ' ht-glow' : ''}">
            <div class="ht-char-head"><i class="fa-solid fa-user"></i><b>${esc(getCharName())}</b><span class="ht-care ht-care-${view.care}">${esc(L().care[view.care])}</span></div>
            ${view.care !== 'low' ? `<div class="ht-char-now"><span>${L().thinks}</span>${view.charNow ? `«${esc(view.charNow.replace(/^[«"“]+|[»"”]+$/g, ''))}»` : esc(L().charIdle)}</div>` : ''}
            ${gift}
        </div>`;
    }

    // Близкие и знакомые: по группам, один человек — одна строка, подарок прямо в строке
    const groups = ['relative', 'friend', 'acquaintance'].map(gk => {
        const list = (view.people || []).filter(p => p.group === gk);
        if (!list.length) return '';
        return `<div class="ht-group"><div class="ht-group-title">${L().groups[gk]}</div>${list.map(p => `
            <div class="ht-person"><b>${esc(p.name)}</b>${p.now ? `<span><i class="fa-solid fa-comment-dots"></i>${esc(p.now)}</span>` : ''}${p.gift ? `<em class="ht-chip"><i class="fa-solid fa-gift"></i>${esc(p.gift)}</em>` : ''}</div>`).join('')}</div>`;
    }).join('');
    const standout = (view.highlights || []).length ? `<div class="ht-group ht-standout"><div class="ht-group-title"><i class="fa-solid fa-star"></i>${L().standout}</div>${view.highlights.map(x => `
            <div class="ht-person"><b>${esc(x.name)}</b><span>${esc(x.text)}</span></div>`).join('')}</div>` : '';
    const peopleSec = section('people', 'fa-users', L().people, groups + standout);
    // События дня: идущее сверху, мероприятие — своей раскрывающейся карточкой
    const evRows = (view.evts || []).filter(e => e.status !== 'offered' && e.status !== 'missed').slice().reverse().map(e => {
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
    const eventsSec = section('events', 'fa-dice', L().events, evRows);

    // Текущий год: по порядку дат; отмеченные — с итогом, прошедшие мимо — приглушены
    const yearRows = (view.year || []).map(i => {
        const [, m, d] = i.iso.split('-');
        const res = i.type === 'date' && i.result ? i.result : null;
        return `<div class="ht-yr${i.kept ? '' : ' ht-yr-missed'}${res ? ` ht-res-${res}` : ''}">
            <time>${d}.${m}</time><i class="fa-solid ${TYPE_ICON[i.type] || 'fa-star'}"></i>
            <div><b>${esc(i.name)}</b>${recapSpoiler(i.recap, i.parts)}</div>
            <em>${res ? (res === 'missed' ? L().yearMissed : L().dateResult[res]) : i.kept ? L().yearKept : L().yearMissed}</em></div>`;
    }).join('');

    // Воспоминания: в контекст только по кнопке «вспомнить»
    const memories = (view.flashbacks || []).map(f => {
        const queued = view.recall === f.id;
        const btn = live ? `<button class="ht-recall${queued ? ' ht-on' : ''}" data-act="recall" data-fb="${esc(f.id)}" title="${queued ? L().recallQueued : L().recall}">
            <i class="fa-solid fa-clock-rotate-left"></i><span>${queued ? L().recallShort : L().recall}</span></button>` : '';
        return `<div class="ht-fb"><div><b>${esc(f.title)}</b>${f.when ? `<span class="ht-mute"> · ${esc(f.when)}</span>` : ''}${recapSpoiler(f.text, f.parts)}</div>${btn}</div>`;
    }).join('');

    // Вкладки сверху: праздник сейчас и прошедшие за год — год не растягивает инфоблок вниз
    const n = view.year?.length || 0;
    const nc = view.cast?.length || 0;
    const tabs = `<div class="ht-tabs" role="tablist">
        <button role="tab" class="ht-tab${tab === 'now' ? ' ht-on' : ''}" data-act="tab" data-tab="now" aria-selected="${tab === 'now'}"><i class="fa-solid fa-holly-berry"></i><span>${L().tabNow}</span></button>
        <button role="tab" class="ht-tab${tab === 'cast' ? ' ht-on' : ''}" data-act="tab" data-tab="cast" aria-selected="${tab === 'cast'}"><i class="fa-solid fa-people-group"></i><span>${L().tabPeople}</span>${nc ? `<em class="ht-count">${nc}</em>` : ''}</button>
        <button role="tab" class="ht-tab${tab === 'year' ? ' ht-on' : ''}" data-act="tab" data-tab="year" aria-selected="${tab === 'year'}"><i class="fa-solid fa-calendar-check"></i><span>${L().year}</span>${n ? `<em class="ht-count">${n}</em>` : ''}</button>
    </div>`;
    if (tab === 'cast') return `<div class="ht-body">${tabs}${castTabHtml(view, live)}</div>`;
    if (tab === 'year') {
        return `<div class="ht-body">${tabs}<div class="ht-year">${yearRows || `<p class="ht-mute">${L().yearEmpty}</p>`}</div>
            ${section('memories', 'fa-clock-rotate-left', L().flashbacks, memories)}</div>`;
    }

    const planned = view.planned ? `<div class="ht-planned"><i class="fa-solid fa-heart"></i><div>
            <span>${L().datePlanned}${view.planned.when ? ` · ${esc(view.planned.when)}` : ''}</span>
            <b>${esc(view.planned.title)}${view.planned.where ? ` · ${esc(view.planned.where)}` : ''}</b>
            ${view.planned.goal ? `<em>${esc(view.planned.goal)}</em>` : ''}</div></div>` : '';
    return `<div class="ht-body">
        ${tabs}
        ${planned}
        ${view.kind === 'today' ? (worldMini ? `<div class="ht-world-mini"><i class="fa-solid fa-location-dot"></i>${worldMini}</div>` : '') : (world ? `<div class="ht-world">${world}</div>` : '')}
        ${charCard}
        ${eventsSec}
        ${main}
        ${peopleSec}
        ${section('upcoming', 'fa-calendar-days', L().upcoming, upcoming)}
        ${live ? `<div class="ht-actions"><button class="ht-btn" data-act="rebuild" title="${L().rebuildTip}"><i class="fa-solid fa-arrows-rotate"></i>${L().rebuild}</button></div>` : ''}
    </div>`;
}

function bindBlock(block) {
    // своя картинка человеку: ужимаем и храним в чате отдельно от снимков
    block.addEventListener('change', async (e) => {
        const inp = e.target.closest?.('input[data-act="cast-photo"]');
        if (!inp?.files?.[0]) return;
        try {
            avatars()[inp.dataset.cid] = await shrinkImage(inp.files[0]);
            saveChatDebounced();
            renderBlock(Number(block.dataset.mesid));
        } catch (err) {
            console.error('[Hearthtide] картинка:', err);
            window.toastr?.warning?.(L().badPhoto, 'Hearthtide');
        }
    });
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
        } else if (t.dataset.act === 'ev-yes' || t.dataset.act === 'ev-no') {
            decideEvent(t.dataset.eid, t.dataset.act === 'ev-yes' ? 'accepted' : 'declined');
        } else if (t.dataset.act === 'date-yes' || t.dataset.act === 'date-no') {
            decideDate(t.dataset.act === 'date-yes');
        } else if (t.dataset.act === 'date-step') {
            const n = Number(t.dataset.n);
            changeDate(st => toggleStep(st.date, n, st.turn, dateLevel()));
        } else if (t.dataset.act === 'date-end') {
            endDateNow();
        } else if (t.dataset.act === 'cast-tab') {
            ui.castTab = t.dataset.tab;
            renderBlock(id);
        } else if (t.dataset.act === 'cast-eye') {
            toggleCastOff(t.dataset.cid);
        } else if (t.dataset.act === 'cast-rom') {
            // выбор в форме — сохранится по «Сохранить»
            t.parentElement.querySelectorAll('button').forEach(b => { b.classList.toggle('ht-on', b === t); b.setAttribute('aria-pressed', String(b === t)); });
        } else if (t.dataset.act === 'cast-photo-del') {
            delete avatars()[t.dataset.cid];
            saveChatDebounced();
            renderBlock(id);
        } else if (t.dataset.act === 'cast-hint') {
            addCastByHand(t.dataset.name);
        } else if (t.dataset.act === 'pair-edit') {
            openPairEditor();
        } else if (t.dataset.act === 'cast-edit') {
            ui.confirmDel = null;
            openCastEditor(t.dataset.cid);
        } else if (t.dataset.act === 'cast-del') {
            const key = `cast:${t.dataset.cid}`;
            if (ui.confirmDel !== key) { ui.confirmDel = key; renderBlock(id); return; }
            ui.confirmDel = null;
            removeCast(t.dataset.cid);
        } else if (t.dataset.act === 'cast-save') {
            const f = t.closest('.ht-edit');
            const val = (k) => f?.querySelector(`[data-ed="${k}"]`)?.value ?? '';
            const rom = (w) => f?.querySelector(`.ht-rom-pick[data-who="${w}"] .ht-on`)?.dataset.key || '';
            if (saveCast(t.dataset.cid, { name: val('name'), toU: val('toU'), toC: val('toC'), group: val('group'), bday: val('bday'), relU: val('relU'), relC: val('relC'), noteU: val('noteU'), noteC: val('noteC'), romU: rom('user'), romC: rom('char') })) {
                ui.editing = null;
                renderAll();
            }
        } else if (t.dataset.act === 'tab') {
            ui.tab.set(id, t.dataset.tab);
            renderBlock(id);
        } else if (t.dataset.act === 'side-retry') {
            sideErr = null;
            maybeSide(lastProcessedMsg(), true);
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
            <div class="inline-drawer-content">
              <div class="ht-set">
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-sliders"></i>Основное</div>
                    <label class="checkbox_label"><input type="checkbox" id="ht-set-enabled" ${isEnabled() ? 'checked' : ''}>Включить</label>
                    <div class="ht-set-row"><span>Инфоблок</span>
                        <div class="ht-seg" id="ht-set-position" role="radiogroup">
                            ${[['top', 'сверху', 'fa-arrow-up'], ['middle', 'посередине', 'fa-grip-lines'], ['bottom', 'снизу', 'fa-arrow-down']].map(([v, t, i]) =>
                                `<button type="button" role="radio" data-pos="${v}" aria-checked="${position() === v}" class="${position() === v ? 'ht-on' : ''}"><i class="fa-solid ${i}"></i><span>${t}</span></button>`).join('')}
                        </div>
                    </div>
                    <label class="checkbox_label"><input type="checkbox" id="ht-set-prev" ${showPrev() ? 'checked' : ''}>В предыдущих ответах тоже</label>
                    <div class="ht-set-row"><span>Язык</span>
                        <select id="ht-set-lang" class="text_pole">
                            <option value="ru" ${langMode() === 'ru' ? 'selected' : ''}>русский</option>
                            <option value="en" ${langMode() === 'en' ? 'selected' : ''}>English</option>
                        </select>
                    </div>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-feather-pointed"></i>Помощник</div>
                    <div class="ht-set-row"><span>Профиль</span>
                        <select id="ht-set-api" class="text_pole"><option value="auto">текущий профиль</option></select>
                        <div class="menu_button menu_button_icon" id="ht-set-refresh" title="Обновить список профилей"><i class="fa-solid fa-arrows-rotate"></i></div>
                        <div class="menu_button menu_button_icon" id="ht-set-ping" title="Проверить подключение"><i class="fa-solid fa-plug-circle-check"></i></div>
                    </div>
                    <div class="ht-set-row"><span>Помнит сообщений</span>
                        <select id="ht-set-depth" class="text_pole">
                            ${[5, 10, 20, 30].map(n => `<option value="${n}" ${sideDepth() === n ? 'selected' : ''}>${n}</option>`).join('')}
                        </select>
                    </div>
                    <div class="menu_button ht-set-wide" id="ht-set-scan"><i class="fa-solid fa-magnifying-glass"></i> Проверить историю</div>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-hourglass-half"></i>Мир <small id="ht-era-who"></small></div>
                    <div class="ht-set-row"><span>Эпоха</span>
                        <select id="ht-set-era" class="text_pole">
                            <option value="auto" ${eraMode() === 'auto' ? 'selected' : ''}>по карточке</option>
                            <option value="ancient" ${eraMode() === 'ancient' ? 'selected' : ''}>прошлое и вымышленные миры</option>
                            <option value="modern" ${eraMode() === 'modern' ? 'selected' : ''}>наши дни</option>
                        </select>
                    </div>
                    <div class="ht-set-row" id="ht-row-faith" ${eraMode() === 'modern' ? '' : 'style="display:none"'}><span>Праздники</span>
                        <select id="ht-set-faith" class="text_pole">
                            <option value="faith" ${faithMode() === 'faith' ? 'selected' : ''}>с верой</option>
                            <option value="secular" ${faithMode() === 'secular' ? 'selected' : ''}>светские</option>
                        </select>
                    </div>
                </section>
                <section class="ht-set-sec">
                    <div class="ht-set-title"><i class="fa-solid fa-heart"></i>Романтика</div>
                    <div class="ht-set-row" title="Как часто чар сам зовёт на свидание после ответа. После ссоры — в 2,5 раза чаще. Свидания из самого ролплея от этого не зависят.">
                        <span>Случайные свидания</span>
                        <input type="range" id="ht-set-datechance" min="0" max="30" step="1" value="${dateChanceSetting()}">
                        <b class="ht-set-val" id="ht-set-datechance-val">${dateChanceSetting() ? `${dateChanceSetting()}%` : 'выкл.'}</b>
                    </div>
                    <small class="ht-set-note"><i class="fa-solid fa-heart"></i><span>Сейчас: <span id="ht-date-why"></span></span></small>
                    <div class="ht-set-row" title="Сколько дают шаги свидания и сколько их нужно, чтобы открылась главная цель">
                        <span>Сложность свиданий</span>
                        <select id="ht-set-datelevel" class="text_pole">
                            <option value="easy" ${dateLevel() === 'easy' ? 'selected' : ''}>лёгкая</option>
                            <option value="hard" ${dateLevel() === 'hard' ? 'selected' : ''}>сложная</option>
                        </select>
                    </div>
                </section>
              </div>
            </div>
        </div>`);
        document.getElementById('ht-set-enabled')?.addEventListener('change', e => {
            localStorage.setItem(LS.enabled, e.target.checked ? 'true' : 'false');
            injectPrompts();
            renderAll();
        });
        document.getElementById('ht-set-position')?.addEventListener('click', e => {
            const b = e.target.closest('[data-pos]');
            if (!b) return;
            localStorage.setItem(LS.position, b.dataset.pos);
            document.querySelectorAll('#ht-set-position [data-pos]').forEach(x => {
                x.classList.toggle('ht-on', x === b);
                x.setAttribute('aria-checked', String(x === b));
            });
            document.querySelectorAll('.ht-ib, .ht-cards').forEach(x => x.remove());
            ui.nodes.clear();
            renderAll();
        });
        document.getElementById('ht-set-datechance')?.addEventListener('input', e => {
            localStorage.setItem(LS.dateChance, e.target.value);
            const v = document.getElementById('ht-set-datechance-val');
            if (v) v.textContent = +e.target.value ? `${e.target.value}%` : 'выкл.';
            updateDateWhy();
            scheduleRenderAll();          // строка о свидании в карточке пары
        });
        document.getElementById('ht-set-datelevel')?.addEventListener('change', e => {
            localStorage.setItem(LS.dateLevel, e.target.value);
            injectPrompts();
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
        document.getElementById('ht-set-refresh')?.addEventListener('click', async () => {
            await fillProfiles();
            window.toastr?.info?.(L().profilesRefreshed, 'Hearthtide');
        });
        document.getElementById('ht-set-ping')?.addEventListener('click', pingProfile);
        document.getElementById('ht-set-depth')?.addEventListener('change', e => {
            localStorage.setItem(LS.depth, e.target.value);
        });
        document.getElementById('ht-set-scan')?.addEventListener('click', () => {
            if (!apiOn()) { window.toastr?.info?.(L().noProfile, 'Hearthtide'); return; }
            if (!state || lastProcessedMsg() < 0) { window.toastr?.info?.(L().scanNothing, 'Hearthtide'); return; }
            window.toastr?.info?.(L().scanToast, 'Hearthtide');
            maybeSide(lastProcessedMsg(), true, ['census']);     // заодно — перепись людей истории
        });
        syncCharSettings();
        updateDateWhy();
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

// Проверка подключения: крошечный запрос к выбранному профилю
let pinging = false;
async function pingProfile() {
    if (pinging) return;
    const id = apiProfile();
    if (!id) { window.toastr?.info?.(L().noProfile, 'Hearthtide'); return; }
    const btn = document.getElementById('ht-set-ping');
    pinging = true;
    btn?.classList.add('ht-pinging');
    const t0 = Date.now();
    try {
        await sendSide(id, [{ role: 'system', content: 'Reply with the single word OK.' }, { role: 'user', content: 'Ping' }], null, 300);
        window.toastr?.success?.(L().pingOk(((Date.now() - t0) / 1000).toFixed(1)), 'Hearthtide');
    } catch (e) {
        const why = reasonOf(e);
        console.error('[Hearthtide] проверка подключения:', why, e);
        window.toastr?.error?.(`${L().pingFail}: ${why}`, 'Hearthtide', { timeOut: 12000 });
    } finally {
        pinging = false;
        btn?.classList.remove('ht-pinging');
    }
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

// Новый персонаж: эпоха не наследуется от прошлого — её определит ИИ по карточке в первом календаре
function noteCharSettings() {
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
    closeCastEditor();
    ui.nodes.clear();
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
            if (t.nodeType === 1 && t.closest?.('.ht-ib, .ht-cards')) continue;          // наши собственные изменения
            const nodes = [...m.addedNodes, ...m.removedNodes];
            if (nodes.length && nodes.every(n => n.nodeType === 1 && (n.classList?.contains('ht-ib') || n.classList?.contains('ht-cards')))) continue;
            changed = true;
            break;
        }
        if (!changed) return;
        reattach();
        scheduleEnsure();
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
        // стёрли инфоблок или карточки под текстом (перерисовка .mes_text) — вернуть
        const lostCards = id === lastBotIndex() && cardsDue() && !el.querySelector('.ht-cards');
        if (shouldShow(id) && (!has || lostCards)) renderBlock(id);
        // что-то вклинилось между текстом и инфоблоком — вернуть к тексту (на месте — не трогаем)
        else if (has && shouldShow(id)) placeBlock(el, has, el.querySelector('.ht-cards'));
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
