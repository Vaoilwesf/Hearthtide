// Hearthtide — side.js
// Отдельный запрос через профиль подключения таверны (Connection Manager).
// Пресет не используется: только наш промпт с карточкой, персоной, лорбуком и последними сообщениями.

import { chat, this_chid, characters } from '../../../../script.js';

const ctxST = () => globalThis.SillyTavern?.getContext?.() || null;

let shared = null;
async function service() {
    const fromCtx = ctxST()?.ConnectionManagerRequestService;
    if (fromCtx) return fromCtx;
    if (!shared) shared = await import('../../shared.js').catch(() => null);
    return shared?.ConnectionManagerRequestService || null;
}

/** Профили подключения, которые подходят для запроса (chat и text completion) */
export async function listProfiles() {
    try {
        const svc = await service();
        const list = svc?.getSupportedProfiles?.() || ctxST()?.extensionSettings?.connectionManager?.profiles || [];
        return list.map(p => ({ id: p.id, name: p.name || p.id }));
    } catch (e) {
        return [];
    }
}

const cut = (t, n) => {
    const s = String(t || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

// Сколько чего отдаём модели — промпт должен оставаться лёгким
const LIMIT = { card: 1400, persona: 600, lore: 1800, msg: 800, perMsg: 650 };

/** Карточка, персона, сработавшие записи лорбука и последние сообщения */
/** newFrom — сообщения после этого номера помечаются [NEW]: помощник судит ход свидания только по ним */
/** newLimit — сколько символов отдать от каждого [NEW]-сообщения: ход свидания судят по ним, обрезать нельзя */
export async function gatherSources(upTo, depth = 10, newFrom = null, loreLimit = LIMIT.lore, newLimit = LIMIT.msg) {
    const c = ctxST();
    const sub = (t) => { try { return c?.substituteParams ? c.substituteParams(t) : t; } catch (e) { return t; } };
    let fields = {};
    try { fields = c?.getCharacterCardFields?.() || {}; } catch (e) { fields = {}; }
    const ch = this_chid !== undefined ? characters[this_chid] : null;
    const card = cut(sub([fields.description ?? ch?.description, fields.personality ?? ch?.personality, fields.scenario ?? ch?.scenario].filter(Boolean).join('\n')), LIMIT.card);
    const persona = cut(sub(fields.persona ?? c?.powerUserSettings?.persona_description ?? ''), LIMIT.persona);

    const msgs = chat.slice(0, upTo + 1).map((m, i) => (m && m.mes && !m.is_system ? { ...m, ht_i: i } : null)).filter(Boolean).slice(-depth);
    // последние сообщения важнее: идём с конца, пока влезает
    const parts = [];
    let total = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const fresh = newFrom != null && msgs[i].ht_i > newFrom;
        const line = `${fresh ? '[NEW] ' : ''}${msgs[i].name || (msgs[i].is_user ? 'User' : 'Character')}: ${cut(msgs[i].mes, fresh ? newLimit : LIMIT.msg)}`;
        // новые — всегда целиком; старые — пока влезают (в среднем ~650 символов на сообщение)
        if (!fresh && total + line.length > depth * LIMIT.perMsg && parts.length) break;
        parts.unshift(line);
        total += line.length;
    }

    // Лорбук: что сработало бы на эти сообщения (пробный проход — без побочных эффектов)
    let lore = '';
    try {
        if (c?.getWorldInfoPrompt) {
            const scan = msgs.map(m => `${m.name}: ${m.mes}`).reverse();
            const wi = await c.getWorldInfoPrompt(scan, 8192, true);
            lore = cut(sub(wi?.worldInfoString || `${wi?.worldInfoBefore || ''}\n${wi?.worldInfoAfter || ''}`), loreLimit);
        }
    } catch (e) { lore = ''; }

    return { card, persona, lore, story: parts.join('\n\n') };
}

/** Один запрос. Ошибка — с понятной причиной (для уведомления и логов) */
// 4000: у моделей с рассуждениями 2000 не хватало — блоки в конце ответа (люди истории) обрезались
export async function sendSide(profileId, messages, signal, maxTokens = 4000) {
    const svc = await service();
    if (!svc) throw new Error('Connection Manager недоступен (расширение выключено или таверна слишком старая)');
    const res = await svc.sendRequest(profileId, messages, maxTokens, {
        stream: false, signal, extractData: true, includePreset: false, includeInstruct: true,
    });
    const text = typeof res === 'string' ? res : (res?.content ?? '');
    if (!String(text).trim()) throw new Error('пустой ответ модели');
    return String(text);
}

/** Причина ошибки целиком: таверна заворачивает её в «API request failed» */
export function reasonOf(e) {
    const chain = [];
    for (let x = e; x && chain.length < 4; x = x.cause) {
        const m = x?.error?.message || x?.message || (typeof x === 'string' ? x : '');
        if (m && !chain.includes(m)) chain.push(m);
    }
    return chain.join(' → ') || 'неизвестная ошибка';
}

/**
 * Записи лорбука, которые сработали бы на этот текст (например, на место и цель задуманного свидания).
 * Пробный проход, без побочных эффектов. Пусто, если ничего не сработало.
 */
export async function loreFor(text, limit = 2400) {
    const c = ctxST();
    try {
        if (!c?.getWorldInfoPrompt || !String(text || '').trim()) return '';
        const wi = await c.getWorldInfoPrompt([String(text)], 8192, true);
        const raw = wi?.worldInfoString || `${wi?.worldInfoBefore || ''}\n${wi?.worldInfoAfter || ''}`;
        const sub = (t) => { try { return c.substituteParams ? c.substituteParams(t) : t; } catch (e) { return t; } };
        return cut(sub(raw), limit);
    } catch (e) { return ''; }
}
