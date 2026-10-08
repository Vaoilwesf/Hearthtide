// Hearthtide — prompts.js
// Весь инджект — на английском. Значения для инфоблока ИИ пишет на выбранном языке.

import { isoOf, fromDayNum, easterJulian, easterGregorian } from './dates.js';
import { hasGifts, charDue, isIntimate, openEvent, dateHoursLeft, giftJoint } from './calendar.js';
import { openSteps, goalOpen, DATE_OPEN } from './romance.js';
import { ageOf } from './cast.js';

const PART_EN = { morning: 'morning', day: 'daytime', evening: 'evening', night: 'night' };

function hName(h, ctx) {
    if (!h) return '';
    if (h.npc) return `${h.name}'s birthday`;
    if (h.birthday) return `${h.who === 'user' ? ctx.userName : ctx.charName}'s birthday`;
    return h.name;
}

// ─── День рождения человека из истории ───
const npcOf = (state, h) => (h?.npc ? (state.cast || []).find(c => c.id === h.cid) || null : null);
/** «turns 30; to Anna: mother; to Ivan: mother-in-law» */
function npcAbout(ctx, h) {
    const c = npcOf(ctx.state, h);
    if (!c) return '';
    const age = ageOf(c, h.start);
    return [age != null && `turns ${age}`, c.toU && `to ${ctx.userName}: ${c.toU}`, c.toC && `to ${ctx.charName}: ${c.toC}`].filter(Boolean).join('; ');
}
/** Ждут ли там {{char}} и {{user}} и почему */
function npcExpect(ctx, h) {
    const { state, userName, charName } = ctx;
    const c = npcOf(state, h);
    if (state.bdDecisions?.[`${h.cid}@${h.start}`] === 'accepted') return `${userName} accepted the invitation: ${charName} and ${userName} are expected`;
    if (c?.group === 'kin_both') return `it is family to both — ${charName} and ${userName} are among those who keep the day, not guests`;
    if (c?.group === 'kin_user' || c?.group === 'kin_char') return `as ${c.group === 'kin_user' ? userName : charName}'s family, custom expects ${charName} and ${userName} there`;
    return `${h.name} is close to them, so an invitation is likely; until it comes, they aren't expected`;
}
const langOf = (ctx) => ctx.lang || "the roleplay's language";

// Кому по обычаю дарят на этом празднике: виновнику торжества (из подготовки), иначе {{user}}
export function giftTarget(state, h, userName, charName) {
    if (!h) return userName;
    if (h.npc) return h.name;
    if (h.birthday) return h.who === 'user' ? userName : charName;
    return state.giftTo?.[h.id] || userName;
}
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Подарок персонажа уместен, если праздник с подарками и дарят не самому персонажу
function charGiftActive(ctx) {
    const { state, phase } = ctx;
    const h = phase.h;
    if (!h || (phase.kind !== 'prep' && phase.kind !== 'today')) return false;
    if (!hasGifts(state, h) || sameName(giftTarget(state, h, ctx.userName, ctx.charName), ctx.charName)) return false;
    if (state.care?.[h.id] === 'low' && !(h.birthday && h.who === 'user')) return false;
    return !(state.charGift?.hid === h.id && state.charGift.done);
}
/** Подарок {{user}} имениннику: что вписал игрок или что {{user}} сам сказал в истории */
const userGiftOf = (state, h) => (h?.npc && !giftJoint(state, h) ? state.userGift?.[h.id] || null : null);

// ─── 1. Состояние календаря (поглубже в контексте) ───
export function buildStatePrompt(ctx) {
    const { state, phase, userName, charName } = ctx;
    const s = state.setting || {};
    const lines = ['[Hearthtide — the world\'s calendar and festive life; background for the story, not its topic]'];
    const where = [s.era && `Setting: ${s.era}`, s.faith && `faith: ${s.faith}`, (state.place || s.place) && `place: ${state.place || s.place}`, state.when && `date: ${state.when}`].filter(Boolean);
    if (where.length) lines.push(where.join(' · ') + '.');

    const h = phase.h;
    const active = (phase.kind === 'prep' || phase.kind === 'today') && h;
    if (phase.kind === 'far' && h) {
        lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days${h.meaning ? ` (${h.meaning})` : ''}. Not relevant yet — don't bring it up.`);
    }
    if (phase.kind === 'prep' && h) {
        // срок — словами и датой: иначе модель говорит «завтра» о празднике через пять дней
        const when = phase.daysTo === 1 ? 'tomorrow' : phase.daysTo === 2 ? 'the day after tomorrow' : `in ${phase.daysTo} days, not sooner`;
        lines.push(`Coming: ${hName(h, ctx)} — ${when} (on ${isoOf(h.start)}; today is ${isoOf(state.today)})${h.meaning ? ` (${h.meaning})` : ''}. Whoever mentions it keeps the timing right.`);
        const p = state.prep && state.prep.hid === h.id ? state.prep : null;
        if (p) {
            const bits = [p.people && `around ${ctx.placeName || userName}: ${p.people}`, p.mood && `mood: ${p.mood}`].filter(Boolean);
            if (bits.length) lines.push(`Preparations — ${bits.join(' · ')}`);
        }
        if (h.npc) {
            const about = npcAbout(ctx, h);
            lines.push(`It is ${h.name}'s own occasion${about ? ` (${about})` : ''}, kept by ${h.name}'s household and close circle — a small family affair, not the whole place's; ${npcExpect(ctx, h)}.`);
        }
        if (h.birthday && h.who === 'user') {
            lines.push(`People close to ${userName} are secretly preparing a surprise — keep it hidden from ${userName}; hints at most.`);
        }
        if (!state.beat) lines.push(state.mentionNow
            ? 'This reply: let the preparations show once, indirectly — as a consequence of them or a brief encounter with someone involved, never a restatement. Pick an angle not used before; never force it.'
            : 'This reply: keep the preparations in the background.');
    }
    if (phase.kind === 'today' && h) {
        const plan = state.days?.[`${h.id}#${phase.dayIndex}`];
        const part = ctx.part;
        const dayInfo = h.days > 1 ? `, day ${phase.dayIndex} of ${h.days}` : '';
        lines.push(`TODAY: ${hName(h, ctx)}${dayInfo}${plan?.title ? ` — ${plan.title}` : ''}.`);
        if (plan && part && plan[part]) lines.push(`Now (${PART_EN[part]}): ${plan[part]}`);
        else if (h.meaning) lines.push(`Traditions: ${h.meaning}`);
        if (h.npc) {
            // чужой день рождения — свой распорядок у именинника; {{char}} и {{user}} — гости, а не хозяева дня
            const about = npcAbout(ctx, h);
            lines.push(`It is ${h.name}'s day${about ? ` (${about})` : ''}: a small household occasion, kept by ${h.name} and their close ones on their own schedule${plan?.where ? ` (${plan.where})` : ''}; ${npcExpect(ctx, h)}. When the scene allows, the day draws ${charName} and ${userName} in — a reminder, someone sent for them, time to set off with a gift; the story's own events come first, and if they can't come, it goes on without them. Follow the day's order — don't jump ahead.`);
        } else lines.push(`The holiday keeps its own course: ${charName} and the people around follow today's plan as custom expects — they gather, call, wait, come to fetch ${userName}, carry on without ${userName} if need be. The story's own events come first and can move or shorten a part, but they don't cancel the day; once a scene settles, the day pulls them back in. Follow the day's order — don't jump ahead.`);
        if (h.birthday && h.who === 'user') lines.push(`It is ${userName}'s birthday: the prepared surprise comes out today.`);
    }
    if (phase.kind === 'after' && phase.ended) {
        lines.push(`Yesterday ${hName(phase.ended, ctx)} ended: tiredness, leftovers, talk of how it went.`);
        if (h) lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days.`);
    }

    if (active) {
        // Персонаж: насколько праздник для него важен
        const care = state.care?.[h.id];
        const steps = (state.charLog?.[h.id] || []).slice(-3).map(x => x.text);
        const trail = steps.length ? ` On ${charName}'s mind lately: ${steps.join(' / ')}.` : '';
        if (care === 'high') lines.push(`${charName} cares about this a lot.${trail} ${charName} acts on it in small steps across replies when the scene allows.`);
        else if (care === 'normal') lines.push(`For ${charName} it matters moderately.${trail}`);
        else if (care === 'low') lines.push(`For ${charName} it means little — a passing remark at most.`);
        // Подарок персонажа
        if (charGiftActive(ctx)) {
            const g = state.charGift?.hid === h.id ? state.charGift.text : null;
            const near = phase.kind === 'today' || phase.daysTo <= 2;
            const joint = giftJoint(state, h);
            lines.push(joint
                ? `${charName} and ${userName} give ${h.name} one gift together: ${g || 'not decided yet'} — ${charName} moves ${charName}'s share in small steps when the scene allows (an idea, asking ${userName}'s view, finding or making it); ${userName}'s say and share are ${userName}'s own.${near && !state.charGift?.done ? ` Time is short: ${g ? 'the next step' : `${charName} brings up what to give`} in this reply if the scene allows.` : ''}`
                : `${charName}'s gift for ${giftTarget(state, h, userName, charName)}: ${g || 'not decided yet'} — it moves forward in small steps when the scene allows, never all at once.${near && !state.charGift?.done ? ` Time is short: ${g ? 'the next step' : `${charName} settles on it`} in this reply if the scene allows.` : ''}`);
        }
        // свой подарок {{user}} — выбор игрока: модель его не двигает, только видит
        const ug = userGiftOf(state, h);
        if (ug?.text) lines.push(`${userName}'s own gift for ${h.name}: ${ug.text}${ug.done ? ' — already given' : ''} (${userName}'s choice; never move it on ${userName}'s behalf — when ${userName} gives it, ${h.name} and those around react).`);
        // Кто уже отличился — помним до конца праздника
        const hl = (state.highlights?.[h.id] || []).slice(-5);
        if (hl.length) lines.push(`So far: ${hl.map(x => `${x.name} — ${x.text}`).join(' · ')}.`);
        // Люди: по одной строке на человека
        const people = (ctx.peopleSeen || state.people || []).filter(p => p.now).slice(0, 4);
        if (people.length) {
            lines.push(`People: ${people.map(p => `${p.name} (${p.group}) — wants: ${p.now}${p.gift ? `; gift: ${p.gift}` : ''}`).join(' · ')}. They live their own lives and act on what they want; one may cross paths with the scene.`);
        }
    }

    // игрок только что отказался — без нажима
    const evNo = h ? (state.evts || []).find(e => e.hid === h.id && e.status === 'declined' && e.lastUpdate >= state.turn) : null;
    if (evNo) lines.push(`${userName} let "${evNo.title}" pass — it goes on without ${userName} or fades; don't push it.`);
    if (state.dateDeclined?.turn >= state.turn) lines.push(`${userName} said no to the date (${state.dateDeclined.title}) — ${charName} takes it in ${charName}'s own way.`);

    // {{char}} и {{user}}: как они сейчас
    if (state.pair) lines.push(`${charName} and ${userName}: friendship ${state.pair.f}, romance ${state.pair.r} (both −100…100, 0 neutral)${state.pair.note ? ` — ${state.pair.note}` : ''}.`);
    // Свидание: намечено (понимание, что скоро; напомнить, только если {{char}} о нём забыл) или идёт (шаги {{char}} и общие)
    lines.push(...dateStateLines(ctx));

    // Люди истории, которые сейчас рядом: кто кому кем приходится и как ладят (0 — вражда, 100 — близки)
    if (ctx.castSeen?.length) {
        lines.push(`Who is who: ${ctx.castSeen.map(c => `${c.name || c.toU || c.toC} (to ${userName}: ${c.toU || c.who || '—'}; to ${charName}: ${c.toC || '—'}) — with ${userName} ${c.rel?.user ?? 0}${c.note?.user ? ` (${c.note.user})` : ''}, with ${charName} ${c.rel?.char ?? 0}${c.note?.char ? ` (${c.note.char})` : ''}${c.rom?.user ? `; romance with ${userName}: ${c.rom.user}` : ''}${c.rom?.char ? `; romance with ${charName}: ${c.rom.char}` : ''}`).join(' · ')}. Relations −100…100, 0 neutral; they show in how people speak and act.`);
    }
    // Дни рождения людей вокруг: позовут или промолчат — по отношениям
    for (const b of ctx.castBdays || []) {
        const inv = state.bdInv?.cid === b.cid ? state.bdInv : null;
        // день рождения уже идёт как свой праздник (подготовка или сам день) — эта строка его только повторила бы
        if (active && h.npc && h.cid === b.cid && (inv?.status === 'accepted' || (!inv && b.kin))) continue;
        const ties = [b.toU && `to ${userName}: ${b.toU}`, b.toC && `to ${charName}: ${b.toC}`].filter(Boolean).join('; ');
        const day = b.days === 0 ? 'is today' : b.days === 1 ? 'is tomorrow' : `is in ${b.days} days, not sooner`;
        if (inv?.status === 'accepted') lines.push(`${b.name}'s birthday ${day}${ties ? ` (${ties})` : ''}. ${userName} accepted the invitation; ${charName} knows${b.days === 0 ? ` — today they are expected; lead there when the scene allows` : ''}.`);
        else if (inv?.status === 'declined') lines.push(`${b.name}'s birthday ${day}. ${userName} declined the invitation — ${b.name} takes it in their own way; don't push it.`);
        else {
            // близкие любому из двоих (родня, друг, тёплые отношения) по обычаю зовут обоих — и делают это вслух, не дожидаясь дня
            const close = b.kin || b.relU >= 20 || b.relC >= 20;
            const invite = close && b.days <= 5 && b.nudge;
            lines.push(`${b.name}'s birthday ${day}${ties ? ` (${ties})` : ''}. ${close
                ? `${b.name} is close to ${b.relC >= b.relU ? charName : userName}, so by custom ${b.name} invites ${charName} and ${userName} together — whoever ${b.name} is to ${userName} on their own.`
                : `Whether ${b.name} brings it up or invites — and whom — follows how they get on (with ${userName} ${b.relU}, with ${charName} ${b.relC}); on bad terms they keep quiet or leave someone out.`}${invite
                ? ` This reply: ${b.name}, or someone close to them, invites ${charName} and ${userName} to it — in person, by a word passed on or a note; plainly, with the day${b.days <= 1 ? '' : ' and the time'}. If the scene is urgent, the next calm moment.`
                : b.nudge ? ` This reply, if the scene allows: ${b.name} or someone close to them brings it up.` : ''}${b.days <= 5 ? ` If someone actually invites ${userName} to it out loud in this reply, add invite=${b.name} to the HT line.` : ''}`);
        }
    }

    // Воспоминание по кнопке «вспомнить» — один раз
    const fb = state.recall && (state.flashbacks || []).find(f => f.id === state.recall);
    if (fb) lines.push(`${charName} suddenly remembers: ${fb.title} — ${fb.text} Let it surface naturally in this reply.`);
    // Что сейчас в игре: ивент, приглашение или мероприятие
    const ev = h && (phase.kind === 'today' || phase.kind === 'prep') ? openEvent(state, h.id) : null;
    if (ev) {
        const who = ev.who ? ` (${ev.who})` : '';
        if (ev.status === 'invited') lines.push(`Invitation pending: ${ev.title}${who}. ${userName} decides whether to go.`);
        else if (ev.kind === 'party' && !ev.moments?.length) lines.push(`${userName} accepted the invitation: ${ev.title}${who}. Lead there when the scene allows; it unfolds around the scene.`);
        else if (ev.kind === 'party') lines.push(`At the gathering: ${ev.title}${who}${ev.moments?.length ? `; so far: ${ev.moments.slice(-2).map(m => m.title).join('; ')}` : ''}. It unfolds around the scene.`);
        else lines.push(`${userName} joins: ${ev.title}${who}${ev.hook ? ` (it began: ${ev.hook})` : ''}. ${ev.turn >= state.turn - 1 ? 'Carry on from where it began' : 'Let it unfold'} over the next replies; ${userName} still makes every own choice.`);
    }
    // Кто может зайти в этот ответ — по очереди из людей праздника (дёшево, без отдельного запроса)
    if (!state.beat && state.nudge) {
        lines.push(state.nudge.name
            ? `If the scene allows, ${state.nudge.name} can come into this reply, acting on what they want (${state.nudge.now})${phase.kind === 'today' ? ` or drawing ${userName} into what the day holds now` : ''} — in person or by word; one person, never a crowd.`
            : `If the scene allows, someone the occasion involves — kin or those its custom calls for — can come into this reply; one person, never a crowd.`);
    }
    // Что праздник может принести в этот ответ — придумал отдельный запрос по истории
    if (state.beat) lines.push(`This reply, if the scene allows (it comes first; skip it if it doesn't fit): ${state.beat}`);
    if (active) {
        lines.push(`If ${userName} is away from people (road, wilds, danger), the feast stays distant. The calendar never overrides the scene: an urgent or dramatic moment always comes first. Never write ${userName}'s thoughts, feelings, words or choices.`);
    }
    return lines.join('\n');
}

// ─── Пасха на нужный год: считает расширение, ИИ только выбирает, подходит ли она миру ───
function easterHint(ctx) {
    if (ctx.state.today == null || (ctx.eraMode === 'modern' && ctx.faithMode === 'secular')) return '';
    const { y, m } = fromDayNum(ctx.state.today);
    if (y < 33 || y > 2300) return '';
    const one = (yy) => {
        const j = easterJulian(yy);
        if (yy < 1583) return `${yy}: ${yy}-${j.julian} (Julian calendar)`;
        const w = isoOf(easterGregorian(yy)), o = isoOf(j.day);
        return w === o ? `${yy}: ${w}, Western and Orthodox alike` : `${yy}: Western ${w}, Orthodox ${o} (Julian ${j.julian})`;
    };
    const years = m >= 10 ? [y, y + 1] : [y];
    return ` If Christian feasts belong here — Easter ${years.map(one).join('; ')}; movable feasts count from it.`;
}

// ─── Какие праздники брать: зависит от эпохи и веры из настроек ───
function holidayGuide(ctx) {
    if (ctx.eraMode !== 'modern') {
        return `The setting decides the calendar: card, world info and lore first, history second. Weigh faiths as the setting does — old gods, spirits or magic get their nights and rites on par with church feasts; include folk, seasonal and local customs.`;
    }
    const faith = ctx.faithMode === 'secular'
        ? `No religious feasts at all — these characters live secular lives.`
        : `Religious feasts: only the biggest ones of the main faith of the place and of the characters (e.g. Orthodox Christmas on Jan 7, Easter on its correct date that year) — not every church feast.`;
    return `MODERN SETTING: only what most people in this country actually celebrate today — major public holidays and days off, big festive days everyone knows, and personal dates. Skip minor official days, professional days, awareness and memorial days, and niche imported holidays, unless one matters to these characters personally. For Russia, for example: New Year (Dec 31 and the January holidays), Defender of the Fatherland Day (Feb 23), International Women's Day (Mar 8), Spring and Labour Day (May 1), Victory Day (May 9), Russia Day (Jun 12), National Unity Day (Nov 4); also widely kept: Valentine's Day, Maslenitsa, Knowledge Day (Sep 1). ${faith} Take the character card and lore into account.`;
}

// Список людей — общий текст для подготовки и обновлений
function peopleRules(ctx) {
    const { userName, charName } = ctx;
    const h = ctx.phase?.h;
    const who = h?.npc
        ? `up to 5 people at ${h.name}'s birthday (not ${charName}, not ${userName}) — ${h.name} first, it is their day, then their household and guests the story gives grounds for.`
        : `up to 8 people taking part in this holiday (not ${charName}, not ${userName}) — those in the story, kin first, and for a family occasion also those its custom calls for.`;
    return `HT-PEOPLE replaces the previous list. P lines: ${who} Each person once, under the name the story uses for them (never the same person twice under a name and a role). GROUP: relative = kin of ${userName} or of ${charName}, by blood or marriage (parents, siblings, in-laws); friend; acquaintance — judge by the card, persona and story. WANT: what this person wants, hopes, plans or worries about around the holiday, a few words, the way people speak in this era and setting — something that could draw them into the story; it must fit where they are and what they have just done in the latest messages, never what they are doing in the current scene, each person different. GIFT: their gift while still pending, else empty. No surprise meant for ${userName} spoiled, no one who has left. D lines: people whose part is done (gave their gift, did their bit) — what they did; they leave the P list. Skip the block if nobody qualifies.`;
}
const PEOPLE_BLOCK = '<!-- HT-PEOPLE\nP | NAME | GROUP | WANT | GIFT\nD | NAME | WHAT_THEY_DID\n-->';

// ═══ Правила крупных блоков — общие для инджекта и отдельного запроса ═══

// Люди истории: каждого — один раз; потом только изменения отношений
function castRule(ctx) {
    const { state, userName, charName } = ctx;
    const known = (state.cast || []).map(c => c.name || `? (${[c.toU, c.toC].filter(Boolean).join(' / ')})`);
    const no = state.castNo || [];
    const hint = (ctx.castHint || []).map(x => `${x.name} (${x.n})`);
    const bare = (state.cast || []).filter(c => c.name && !c.toU && !c.toC && !c.edited).map(c => c.name);
    return `<!-- HT-CAST
C | NAME | GROUP | TO_USER | TO_CHAR | BIRTHDAY | WITH_USER | WITH_CHAR | HOW_USER | HOW_CHAR
R | NAME | WITH_USER | WITH_CHAR | HOW_USER | HOW_CHAR
-->
C: people of the story not in the list yet (not ${userName}, not ${charName}), once each. NAME: the person's own name only — never a role as a name; if the story hasn't named them yet, write ?. GROUP: kin_user (${userName}'s own blood family) | kin_char (${charName}'s own blood family) | kin_both (family to both: their shared children or grandchildren, or a child of one whom the other raises or treats as their own — TO_USER and TO_CHAR then say who they are to each) | friend | acquaintance | other. TO_USER / TO_CHAR: who they are to ${userName} and to ${charName}, a word or two each, in ${langOf(ctx)}. Work out kinship from the card, persona, lore and story — never guess what they don't support. BIRTHDAY: DD.MM or DD.MM.YYYY only if stated, else empty. WITH_USER / WITH_CHAR: how they get on, −100 (enmity) … 0 (neutral) … 100 (very close). HOW_USER / HOW_CHAR: how they are with each, 2–4 words of your own, specific to these two people — not a generic label, in ${langOf(ctx)}.
R: only someone whose relations clearly changed in the latest messages — the new numbers and words.${ctx.census ? `
Census: go through the card, persona, world info and the whole story above and list everyone who matters and isn't listed yet, up to 10 C lines — kin of both sides first, then those the story names most often.` : ''}
${bare.length ? `Listed without roles yet: ${bare.join(', ')} — send C lines for them too, with what the story shows.\n` : ''}Leave the block out if there is nothing.${hint.length ? ` Often named in the story: ${hint.join(', ')} — add those who are people.` : ''}${known.length ? ` Already listed: ${known.join(', ')}.` : ''}${no.length ? ` Never add: ${no.join(', ')}.` : ''}`;
}

// ═══ Свидания ═══
const whoName = (ctx, w) => (w === 'user' ? ctx.userName : w === 'char' ? ctx.charName : 'either of them');
/** Когда назначено — словами для модели */
export function dateAtText(state, at) {
    if (!at) return 'soon';
    if (at.now) return 'right now';
    const day = at.day ?? state.today;
    const d = state.today != null && day != null ? day - state.today : null;
    const hh = at.clock != null ? `${String(Math.floor(at.clock)).padStart(2, '0')}:${String(Math.round((at.clock % 1) * 60)).padStart(2, '0')}` : '';
    const dayTxt = d == null ? isoOf(day) : d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 0 ? 'earlier' : `in ${d} days (${isoOf(day)})`;
    return `${dayTxt}${hh ? ` at ${hh}` : ''}`;
}
function dateStateLines(ctx) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const out = [];
    if (state.dateMissed?.turn >= state.turn) out.push(`The planned date (${state.dateMissed.title}) never happened — ${charName} notices it in ${charName}'s own way.`);
    // свидание только что кончилось — его исход окрашивает следующие ответы
    const last = (state.datesDone || []).slice(-1)[0];
    if (last && d?.status === 'ended' && d.id === last.id && state.turn - (d.endTurn ?? -99) <= 3) {
        const feel = { great: `it went wonderfully — ${charName} is warm, bold and light, closer than before`, good: `it went well — ${charName} is pleased and a little closer`, awkward: `it was awkward — ${charName} is unsure, replays moments, wants to make it right`, bad: `it went badly — ${charName} is stung or withdrawn, careful with ${userName}`, terrible: `it went terribly — ${charName} is hurt, cold or ashamed; the distance shows` }[last.result] || '';
        out.push(`The date (${last.title}) has just ended: ${feel}.${d.recap ? ` ${d.recap}` : ''} Let it color how ${charName} speaks and acts in the next replies.`);
    }
    if (!d) return out;
    if (d.status === 'scheduled') {
        const left = dateHoursLeft(state);
        if (left == null || left > 30) return out;
        out.push(`Planned: ${charName} and ${userName} have a date — ${d.title}${d.where ? `, ${d.where}` : ''}, ${dateAtText(state, d.at)}${d.goal ? `; it is meant to ${d.goal}` : ''}. ${charName} knows it and gets ready in ${charName}'s own way; if the story brings it on earlier, it begins then.`);
        // помним — не подталкиваем; забыл, а срок близко — напомнить
        if (left <= 4 && !ctx.dateMentioned) out.push(`It is close and ${charName} hasn't given it a thought lately — let ${charName} remember it now and act on it.`);
        return out;
    }
    if (d.status !== 'active') return out;
    const open = openSteps(d);
    const mine = open.filter(s => s.who === 'char').map(s => s.t);
    const both = open.filter(s => s.who === 'both').map(s => s.t);
    const goal = d.goal ? ` Its point: ${d.goal}${d.goalDone ? ' — reached.' : goalOpen(d, ctx.dateLevel) ? ' — within reach now; let it come when the moment is right.' : ' — not yet; first more closeness.'}` : '';
    // шкала растёт с нуля, поэтому «плохо» — это срывы, а не малый процент в начале
    const fails = (d.steps || []).filter(x => x.state === 'failed').length, dones = (d.steps || []).filter(x => x.state === 'done').length;
    const how = fails > dones ? (d.score < 10 ? 'badly' : 'poorly') : d.score >= 60 ? 'wonderfully' : d.score >= 30 ? 'well' : fails ? 'unevenly, a little awkward' : 'it is just warming up';
    out.push(`${userName} and ${charName} are on a date: ${d.title}${d.where ? `, ${d.where}` : ''}.${d.startTurn >= state.turn - 1 ? ' It begins now.' : ''}${goal}${mine.length ? ` ${charName}'s next steps: ${mine.join('; ')} — gently, one at a time, as the scene allows.` : ''}${both.length ? ` Either may: ${both.join('; ')}.` : ''} So far: ${how}${d.vibe ? ` (${d.vibe})` : ''} — ${charName}'s mood, boldness and warmth follow it.${d.thought ? ` ${charName} thinks: ${d.thought}` : ''} ${userName} decides everything of ${userName}'s own.`);
    return out;
}

/** Ход свидания — для отдельного запроса помощника (по [NEW]) и для основной модели без помощника (по этому ответу) */
function dateUpRule(ctx, main = false) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const lang = langOf(ctx);
    const scope = main ? 'in this reply' : 'in the messages marked [NEW]';
    if (d.status === 'scheduled') {
        return `<!-- HT-DATE-UP\nSTART\nNEW | STEP TEXT | char|both\n-->\nOnly if the date "${d.title}" (planned ${dateAtText(state, d.at)}; meant to ${d.goal || 'be together'}) has actually begun ${scope}: START, then ${DATE_OPEN} NEW first steps — short concrete actions in words, small romantic things or moments of closeness that fit this date and the moment; char — only ${charName} does it, both — either of them may; never a step for ${userName} alone, never chores or anything off the date; real names. Otherwise write nothing.`;
    }
    const open = openSteps(d);
    const list = open.map(s => `${s.n}. ${s.t} (${s.who === 'char' ? charName : 'either of them'})`).join('\n');
    const need = DATE_OPEN - open.length;
    const goal = d.goalDone ? 'reached' : goalOpen(d, ctx.dateLevel) ? 'within reach — GOAL once the story reaches it' : 'locked until more steps are done';
    return `<!-- HT-DATE-UP
STEP | N | done|failed|open | NOTE
NEW | STEP TEXT | char|both
MOMENT | …
MOOD | up|down
VIBE | …
THOUGHT | …
GOAL
END
-->
The date: ${d.title}${d.where ? `, ${d.where}` : ''}; goal: ${d.goal || '—'} (${goal}); success so far ${d.score}%.
Open steps:
${list || '(none yet)'}

Judge only what happens ${scope}:
- One STEP line for EVERY open step above, by its number: done — it clearly happened (for "either of them" — when ${charName} or ${userName} did it); failed — it was tried but met a refusal, coldness or a bad reaction; open — not yet (no NOTE). NOTE for done or failed: what came of it, past tense, one line, real names declined properly (who learned, felt or gave what).
- NEW: ${need > 0 ? `exactly ${need} new step${need > 1 ? 's' : ''} now, ` : ''}one for each step closed in this check, so that ${DATE_OPEN} stay open. Each is a short concrete action in words (never a number, never a copy of an open step): a small romantic thing or a moment of closeness that grows out of this date and what is happening right now — getting to know each other, attention, tenderness, touch, shared moments, confessions; true to its goal and kind (a first meeting may end in asking to meet again, or for a way to reach each other in a modern setting; making up may bring a gift or an apology from ${charName}). After a failed step, one NEW step grows out of it and softens the moment — never named as fixing it. Never chores, errands, children or anything off the date. Who: char — something only ${charName} does; both — either of them may (asking, sharing, touching). Never a step for ${userName} alone. Weigh who leads and who is shy by the card, persona, lore and how they stand. Real names; never (user), (char) or {{…}}.
- MOMENT: something notable for them that clearly happened outside the open steps — a gift, a confession, a kiss, a brave or tender gesture; one line each, past tense, real names; at most two, none if nothing stood out.
- MOOD only if it clearly went better or worse beyond the steps and moments. VIBE: how the date goes overall, 2–5 words. THOUGHT: ${charName}'s private thought about the date now, in ${charName}'s own manner, under 15 words.
- GOAL only when the story itself reaches the goal. END only when the date is over in the story.
Text in ${lang}.`;
}

/** Отдельный запрос помощника о свидании: каждый ответ, коротко, только про свидание */
export function buildDateSideMessages(ctx, src) {
    const { state, userName, charName } = ctx;
    const d = state.date;
    const task = [];
    if (d && (d.status === 'active' || d.status === 'scheduled')) task.push(dateUpRule(ctx));
    if (state.dateRecapFor && !(d?.status === 'active')) task.push(dateRecapRule(ctx));
    return [
        { role: 'system', content: `You track a date between ${charName} and ${userName} in an ongoing roleplay for an extension. Answer only with the requested hidden block, nothing else. Be strict: count only what the story actually shows.` },
        { role: 'user', content: [
            src.card && `[${charName}]\n${src.card}`,
            src.persona && `[${userName}]\n${src.persona}`,
            src.lore && `[World info]\n${src.lore}`,
            `[Story — latest messages; [NEW] marks those since the last check]\n${src.story || '—'}`,
            task.join('\n\n'),
        ].filter(Boolean).join('\n\n') },
    ];
}

function dateRecapRule(ctx) {
    const last = (ctx.state.datesDone || []).slice(-1)[0];
    return `<!-- HT-DATE-UP\nRECAP | TEXT | BEST\n-->\nThe date "${last?.title || ''}" is over: TEXT — how it went for ${ctx.userName} and ${ctx.charName}, one or two sentences, only what the story showed; BEST — the moment worth remembering, a few words. In ${langOf(ctx)}.`;
}

// ─── Приглашение на свидание ───
// Кубик выпал → помощник составляет план (место, время, цель) по карточке, персоне, лорбуку и истории и сверяет
// его с записями лорбука о выбранном месте → основная модель только произносит приглашение по плану.
// Без помощника (или если он не успел) — основная модель придумывает сама, по тем же правилам здравого смысла.
const hhmm = (c) => `${String(Math.floor(c)).padStart(2, '0')}:${String(Math.round((c % 1) * 60)).padStart(2, '0')}`;
function dateSense(ctx) {
    const { state, userName, charName } = ctx;
    const now = `${state.today != null ? isoOf(state.today) : 'today'}${state.clock != null ? ` ${hhmm(state.clock)}` : ''}`;
    return `It must make sense right here and now:
- where: a place that exists in this world (card, world info, story) or is ordinary for this era and place; never one the world info or the story marks as dangerous, forbidden, cursed or hostile, nor one the story has just made unsafe;
- who: fits both of them as they are now — body and health (pregnancy, injury, illness, tiredness), mood, what just happened between them and around them, duties and threats in the story; ${charName} cares about ${userName} and would not lead ${userName} into harm;
- when: ahead of now (${now}), at a sensible hour for this kind of outing, the season, the weather and daylight; not at night or at dawn unless the story itself points there;
- what: true to ${charName}'s character and means and to the customs of the era — something ${charName} would really think of for ${userName}.`;
}
const DATE_FORMAT = '<!-- HT-DATE title=… | goal=… | hook=… | where=… | at=YYYY-MM-DD HH:MM -->';
const dateFields = (ctx) => `title: what it is, a few words; goal: what it is meant to mend, say, begin or celebrate, from the story; hook: how ${ctx.charName} will ask, one sentence; where: the place; at: when, in the story's calendar (now — if right away).`;

/** Помощнику: составить план свидания */
function datePlanRule(ctx) {
    const { state, userName, charName } = ctx;
    const past = (state.datesDone || []).slice(-3).map(d => d.title);
    return `${DATE_FORMAT}
Plan the date ${charName} will ask ${userName} on in the next reply. ${dateSense(ctx)}
${dateFields(ctx)}${past.length ? ` Different from: ${past.join(' / ')}.` : ''} In ${langOf(ctx)}.`;
}

/** Помощнику, второй проход: сверить план с записями лорбука о выбранном месте */
export function buildDateReview(ctx, planBlock, lore, src) {
    const { userName, charName } = ctx;
    return [
        { role: 'system', content: `You check a planned date in a roleplay between ${charName} and ${userName} against the world's lore. Answer with a single line.` },
        { role: 'user', content: `[World info about the planned date]\n${lore}\n\n[${charName}]\n${src.card || '—'}\n\n[${userName}]\n${src.persona || '—'}\n\n[Story — latest messages]\n${String(src.story || '').slice(-2500)}\n\n[The plan]\n${planBlock}\n\n${dateSense(ctx)}\nIf the plan clashes with the world info or the story (a dangerous or forbidden place, a wrong hour, it doesn't suit someone's state), answer with a corrected ${DATE_FORMAT} — same format, in ${langOf(ctx)}. Otherwise answer OK.` },
    ];
}

/** Основной модели: позвать по готовому плану */
function dateAskRule(ctx) {
    const { state, userName, charName } = ctx;
    const pl = state.datePlan;
    const p = state.pair || {};
    return `${state.dateRollTry ? 'REQUIRED — your last reply skipped it. ' : ''}This reply ${charName} asks ${userName} on a date ${charName} has in mind: ${pl.title}${pl.where ? ` — ${pl.where}` : ''}, ${dateAtText(state, pl.at)}${pl.goal ? `; meant to ${pl.goal}` : ''}.${pl.hook ? ` How: ${pl.hook}` : ''} Ask in ${charName}'s own way, as fits who ${charName} is and how they stand (friendship ${p.f ?? 0}, romance ${p.r ?? 0}): openly, shyly, in passing or as a half-joke, at a moment that fits the scene. Write only the asking; ${userName} answers. Add date_asked=yes to the HT line only if ${charName} actually said it to ${userName} in this reply — not if ${charName} only thought of it. If the scene is urgent or dangerous, don't ask yet and add nothing.`;
}

/** Основной модели без плана: придумать и позвать самой */
function dateOfferRule(ctx) {
    const { state, userName, charName } = ctx;
    const p = state.pair || {};
    const past = (state.datesDone || []).slice(-3).map(d => d.title);
    const gift = state.charGift && !state.charGift.done && state.charGift.text ? ` ${charName}'s gift is ready (${state.charGift.text}) — it may be part of it.` : '';
    return `${state.dateRollTry ? 'REQUIRED — your last reply skipped it. ' : ''}This reply ${charName} asks ${userName} on a date, in ${charName}'s own way, as fits who ${charName} is and how they stand (friendship ${p.f ?? 0}, romance ${p.r ?? 0}${p.note ? `, ${p.note}` : ''}): openly, shyly, in passing or as a half-joke; after a quarrel — as a way to make up. ${dateSense(ctx)}
Write only the asking; ${userName} answers. Only if ${charName} actually said it to ${userName} in this reply (not just thought of it), add after the HT line: ${DATE_FORMAT} — ${dateFields(ctx)}${gift} In ${langOf(ctx)}.${past.length ? ` Different from: ${past.join(' / ')}.` : ''} If the scene is urgent or dangerous, don't ask yet and add nothing.`;
}

// Случайный ивент: предлагается игроку кнопками, в историю входит, только если он принял
function eventOfferRule(ctx) {
    const { state, phase, userName } = ctx;
    const h = phase.h;
    const past = (state.evts || []).filter(e => e.hid === h.id && e.kind !== 'moment').map(e => e.title).slice(-4);
    return `This reply, if the scene allows: let one chance happening around ${hName(h, ctx)} begin — outside the holiday's own rites and schedule, brought by a person, by chance or by the world around, true to the era, the place and the moment. Show only its start (someone begins it or invites ${userName}) and stop where ${userName} can choose to join. Then add after the HT line: <!-- HT-EV kind=event|party | title=… | who=… | hook=… --> — kind=party if it is an invitation to a gathering; title a few words; who brings it; hook: what has just begun, one sentence; in ${langOf(ctx)}.${past.length ? ` Different in kind from: ${past.join(' / ')}.` : ''} If the scene is urgent or nothing fits, skip it and add nothing.`;
}
function calRule(ctx, lite = false) {
    const { state, userName, charName } = ctx;
    const lang = langOf(ctx);
    if (lite) {
        return `<!-- HT-CAL
S | ERA_AND_YEAR | FAITH | PLACE
H | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP
-->
- S: the era by name and the year; the faith people live by; the place as the story names it.
- H: the next 3 holidays the people around ${userName} actually keep in this era and place, in date order from the current date, none skipped; one holiday per line, under the name they use. TYPE: religious | folk | seasonal | state | family | fast | memorial. PREP: days of getting ready.${ctx.banned?.length ? ` Never: ${ctx.banned.join(', ')}.` : ''}
- All in ${lang}, names translated.`;
    }
    const known = (state.holidays || []).filter(x => state.today == null || x.start + x.days - 1 >= state.today)
        .map(x => `${x.name} (${isoOf(x.start)})`).slice(0, 5);
    // дни рождения спрашиваем один раз: не указаны в карточке — значит, их нет, пока история не скажет
    const needB = (!state.birthdays?.user || !state.birthdays?.char) && !state.bdayAsked;
    const gap = ctx.skipGap;
    const askMode = ctx.eraMode === 'auto';
    return `<!-- HT-CAL
S | ERA_AND_YEAR | FAITH | PLACE${askMode ? ' | MODE' : ''}
H | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP
${needB ? `B | user | MM-DD | PREP\nB | char | MM-DD | PREP\n` : ''}${gap ? `X | YYYY-MM-DD | NAME | TYPE\n` : ''}-->
- S: the era by name and the year${ctx.eraMode === 'modern' ? '' : ', as people of that time would say it (our reckoning in brackets only if theirs differs)'} — not a bare date; FAITH — ${ctx.eraMode === 'modern' && ctx.faithMode === 'secular' ? 'secular' : 'the faith(s) people actually live by'}; PLACE — the kind of place and its proper name exactly as the story gives it (never invent a name the story doesn't use).${askMode ? ' MODE — present if the story is set in our real world today, otherwise past (history, fantasy, other worlds).' : ''}
- H: the next 4 holidays from the current date, in date order, decided briskly${known.length ? `, continuing after: ${known.join(', ')}` : ''}. Only days people there already keep — never something still to happen in the story (a disaster, a death, a battle). ${holidayGuide(ctx)} Compute movable feasts properly for that year and calendar.${easterHint(ctx)} Occasions the story itself has set up or announced come first. Also add personal and family occasions the story gives grounds for (birthdays and name days of the characters and people close to them, weddings, anniversaries, a newborn's naming, memorial days of relatives, a housewarming) — only dates the card, lore or story actually gives, never guessed. DAYS = how many days it lasts. TYPE: religious | folk | seasonal | state | family | supernatural | fast | memorial. PREP = how many days before it people actually start getting ready or feel it coming (0 for a minor day; a great feast may be weeks). Birthdays of ${userName} and ${charName} go only in B lines, never as H; birthdays of other people are tracked separately — not as H.${needB ? `\n- B: birthdays of ${userName} and ${charName} only if the card, persona or story states them; otherwise leave that line out — never guess.` : ''}${gap ? `\n- X: holidays the time skip jumped over, ${gap.from} to ${gap.to}, by the same rules.` : ''}${ctx.passed?.length ? `\n- Already passed this year, don't repeat: ${ctx.passed.join(', ')}.` : ''}${ctx.banned?.length ? `\n- NEVER include these (the player removed them): ${ctx.banned.join(', ')}.` : ''}
- All of it in ${lang}: translate holiday names even if the story's world speaks another language.`;
}

function prepRule(ctx) {
    const { state, phase, userName, charName } = ctx;
    const h = phase.h;
    const prev = state.prep?.hid === h.id ? state.prep : null;
    const scope = h.npc
        ? `This is ${h.name}'s birthday${npcAbout(ctx, h) ? ` (${npcAbout(ctx, h)})` : ''}: only ${h.name}'s household and close circle get ready, modestly, as a family affair; ${npcExpect(ctx, h)}.`
        : isIntimate(h)
        ? `This is a personal or family occasion: only ${h.birthday && h.who === 'user' ? `the people close to ${userName}` : 'the household and close circle'} get ready — not the whole community.`
        : `This is a public holiday: the community around ${userName} gets ready.`;
    return `<!-- HT-PREP people=… | mood=… | gifts=yes|no | gift_to=… | care=high|normal|low -->
How things get ready for ${hName(h, ctx)} (in ${phase.daysTo} day${phase.daysTo === 1 ? '' : 's'}) in ${ctx.placeName || `the place around ${userName}`}. ${scope} people: what those around are doing for it now beyond the current scene — the next stage of the preparations by the customs of this era and place, one or two sentences; never a retelling of what just happened in the story, never about ${userName}; mood: the feeling in the air.${prev?.people ? ` Before it was: "${prev.people}" — show what has moved on since, don't restate it.` : ''} Only what is visible or commonly known — no secret plans the story hasn't shown. gifts: does this holiday involve giving gifts by custom; gift_to: to whom they go by custom here — the one being honoured, as the story names them. care: how much it matters to ${charName} personally, judging by who ${charName} is.${h.birthday && h.who === 'user' ? ` A surprise for ${userName} stays unspoiled.` : ''}`;
}

function dayRule(ctx) {
    const h = ctx.phase.h;
    if (h.npc) {
        const about = npcAbout(ctx, h);
        return `<!-- HT-DAY title=… | where=… | morning=… | day=… | evening=… | night=… -->
How ${h.name}'s birthday is kept TODAY${about ? ` (${about})` : ''} by the customs of this era and place and by who ${h.name} is — a small household occasion, not a public feast. title = what the day is for ${h.name}, a few words; where = where it is kept — whose home or what place, as the story names it. Then only the parts of the day when something happens for it — the gathering, the meal, wishes and gifts, seeing guests off — one sentence each; leave the other parts out. Note: ${npcExpect(ctx, h)}; never decide whether ${ctx.userName} comes.`;
    }
    return `<!-- HT-DAY title=… | morning=… | day=… | evening=… | night=… -->
How ${hName(h, ctx)} is celebrated TODAY${h.days > 1 ? ` (day ${ctx.phase.dayIndex} of ${h.days} — each day may have its own meaning)` : ''} by the traditions of this era and place, from morning to night: rites, food, games, songs, what people do. title = what this day is about, a few words — not the holiday's name. One or two sentences per part.`;
}

function replanRule(ctx) {
    const { state, phase } = ctx;
    const h = phase.h;
    const plan = state.days?.[`${h.id}#${phase.dayIndex}`] || {};
    const ahead = ['morning', 'day', 'evening', 'night'];
    const from = Math.max(0, ahead.indexOf(ctx.part));
    return `<!-- HT-DAY ${ahead.slice(from).map(p => `${p}=…`).join(' | ')} -->
The day has moved on: rewrite the parts from now on so the holiday keeps its own course around what has actually happened — its rites, customs and gatherings still take place (moved, shortened, or going on without someone if they must). Never replace the holiday with the story's other events or retell them; what is done is not repeated. One or two sentences each, about the holiday.${plan[ahead[from]] ? ` The plan was: ${ahead.slice(from).filter(p => plan[p]).map(p => `${p}: ${plan[p]}`).join('; ')}.` : ''}`;
}

function recapRule(ctx) {
    const { state, phase, userName, charName } = ctx;
    const e = phase.ended;
    const hl = (state.highlights?.[e.id] || []).map(x => `${x.name} — ${x.text}`).join('; ');
    const g = state.charGift?.hid === e.id && state.charGift.done ? state.charGift.text : null;
    const ug = e.npc && state.userGift?.[e.id]?.text ? state.userGift[e.id] : null;
    const gl = g && (giftJoint(state, e) ? `${charName} and ${userName}'s gift: ${g}` : `${charName}'s gift: ${g}`);
    const ul = ug && `${userName}'s gift: ${ug.text}${ug.done ? '' : ' (if the story showed it given)'}`;
    return `<!-- HT-RECAP text=… | done=… | gifts=… | best=… --> In ${langOf(ctx)}, only what the story showed: text — how ${hName(e, ctx)} went for ${userName} and ${charName}, one or two short sentences (under 40 words); done — what was done or kept, a few short items separated by ;; gifts — who gave what to whom, separated by ; (empty if none); best — the one moment worth remembering, a few words.${hl || gl || ul ? ` Facts: ${[gl, ul, hl].filter(Boolean).join('; ')}.` : ''}`;
}

// ─── 2. Правило тега (конец промпта) ───
export function buildTagPrompt(ctx) {
    const { state, phase, request, userName, charName } = ctx;
    const h = phase.h;
    const lang = langOf(ctx);
    const pr = state.pair;
    const out = [`[Hearthtide tag — required]
End every reply with one hidden line:
<!-- HT date=YYYY-MM-DD | time=HH:MM | when=DATE_TEXT${pr ? '' : ' | bond=F/R | bond_note=…'} -->
date: in-world date, numeric, in the story's own calendar (fictional months → 1–12). time: in-world clock now. when: the day and month as the story says it, short. Add place=KIND NAME (the settlement or area: its kind word and name as the story says them, not a building) when ${userName} moves or it's wrong${ctx.placeUnnamed ? ` — and THIS reply, because the current place has no name yet: the name the story gives it, or a fitting one` : ''}.
All text values in these comments: ${lang} only.`];

    if (state.langSlip) out.push(`Your last values were not in ${lang} — write them in ${lang}.`);
    if (ctx.fixPlace) out.push(`Add place=… to the HT line THIS reply: the current place rewritten in ${lang}.`);
    if (ctx.fixSetting) out.push(`ALSO add after the HT line: <!-- HT-CAL\nS | ERA_AND_YEAR | FAITH | PLACE\n--> — the current setting rewritten in ${lang}.`);
    if (state.missed > 0) out.push(`Your previous reply had no HT line — include it now.`);
    // {{char}} и {{user}}: дружба / романтика — пока не ясно, в каждом ответе; дальше — когда меняется (и изредка сверить)
    out.push(pr
        ? `Add bond=F/R | bond_note=… to the HT line when this reply changes how ${charName} and ${userName} stand (now ${pr.f}/${pr.r}${pr.note ? `, ${pr.note}` : ''})${ctx.bondStale ? ' — and THIS reply even if unchanged' : ''}.`
        : `${ctx.bondMiss ? 'REQUIRED — your last reply had no bond. ' : ''}bond=F/R: how ${charName} and ${userName} stand now by the card, persona and story, two numbers −100…100 — friendship (enmity … 0 … very close), romance (hatred or exes … 0 none … deep love); spouses, lovers, rivals and strangers all differ. bond_note: a few words of your own, in ${lang}.`);
    const dt = state.date?.status === 'active' ? state.date : null;
    // выпал шанс — ивент или приглашение на свидание начинаются прямо в этом ответе, игрок решает кнопками
    if (state.evRoll && h) out.push(eventOfferRule(ctx));
    if (state.dateRoll && !dt) out.push(state.datePlan ? dateAskRule(ctx) : dateOfferRule(ctx));
    // без помощника ход свидания ведёт основная модель — по своему же ответу
    const dateLive = state.date?.status === 'active' || (state.date?.status === 'scheduled' && (dateHoursLeft(state) ?? 99) <= 30);
    if (!ctx.api && dateLive) out.push(`ALSO add after the HT line:\n${dateUpRule(ctx, true)}`);
    if (!ctx.api && state.dateRecapFor && !dateLive) out.push(`ALSO add after the HT line: ${dateRecapRule(ctx)}`);
    if (charDue(state, phase)) {
        out.push(`Add char=… to the HT line: a short thought of ${charName}'s about the holiday right now, in ${charName}'s own voice, the way people speak in this era, setting and story, under 12 words — about the feast, the people in it or what is coming, never a description of what ${charName} is doing; a new thought each time, not echoing earlier ones.`);
    }
    // один человек праздника за ответ: чего он хочет теперь — желания людей живут вместе с историей
    const ppl = (phase.kind === 'prep' || phase.kind === 'today') && h ? (state.people || []).filter(p => p.name) : [];
    if (ppl.length) {
        const next = ppl[(state.whoIdx || 0) % ppl.length];
        out.push(`Add who=NAME: WANT to the HT line — one holiday person (${next.name}${ppl.length > 1 ? `, or whoever of ${ppl.map(p => p.name).join(', ')} this reply touched` : ''}): what they want or plan around it now, a few words, moved on${next.now ? ` from "${next.now}"` : ''} — not a retelling.`);
    }
    if (charGiftActive(ctx)) {
        if (giftJoint(state, h)) out.push(`Add gift=… to the HT line: the current step with ${charName} and ${userName}'s joint gift for ${h.name}, under 8 words — what ${charName} did or what the two settled on in this story, never ${userName}'s part decided for ${userName}. Add gift_done=true once it is given. Leave gift out until there is a real step.`);
        else out.push(`Add gift=… to the HT line: ${charName}'s current step with a gift for ${giftTarget(state, h, userName, charName)}, under 8 words, no reason clause; it moves as the story does (idea → finding or making → ready and hidden → given). Add gift_done=true once it is given. Leave gift out until there is a real step — never write that it isn't decided.`);
    }
    // свой подарок {{user}} — только записать то, что {{user}} сам написал; игрок мог вписать его сам
    if (h?.npc && (phase.kind === 'prep' || phase.kind === 'today') && !giftJoint(state, h)) {
        const ug = state.userGift?.[h.id];
        if (!ug?.done) out.push(`If ${userName}'s own latest message names, gets or gives ${userName}'s gift for ${h.name}, add ugift=what it is (and ugift_done=true once given) — only what ${userName} wrote, never your guess.`);
    }
    const evOpen = h && (phase.kind === 'today' || phase.kind === 'prep') ? openEvent(state, h.id) : null;
    if (evOpen?.status === 'invited') out.push(`Add ev=joined to the HT line if ${userName} accepts the invitation, ev=declined if not.`);
    else if (evOpen) out.push(`When "${evOpen.title}" ends, add ev=done | ev_note=its outcome in one sentence to the HT line${evOpen.kind === 'party' ? '' : `; ev=skipped if ${userName} turned away`}.`);
    // С отдельным запросом основная модель ведёт только время, шаг персонажа, подарок и ивент — остальное он
    if (ctx.api) {
        out.push('Never skip, mention or explain these comments.');
        return out.join('\n');
    }
    if (phase.kind === 'today' && h && request !== 'day' && request !== 'replan' && state.days?.[`${h.id}#${phase.dayIndex}`]) {
        out.push(`If today's plans change in the story, re-send <!-- HT-DAY … --> with the parts still ahead.`);
    }
    if (ctx.meaningFor) out.push(`Add mean=… to the HT line: what "${ctx.meaningFor}" is and how it is kept in this era and place, one sentence.`);
    if (request !== 'cal') {
        const known = ctx.offerNames?.length ? ` Already known: ${ctx.offerNames.join(', ')}.` : '';
        out.push(`If the story sets up a new occasion (someone's life event, an announced celebration, an invitation), add once after the HT line: <!-- HT-NEW CAUSE | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP --> (CAUSE: what happened; TYPE: family|personal|religious|folk|memorial).${known}`);
    }

    if (request === 'cal') {
        // Модели без рассуждений теряют блок в конце длинного ответа: просим начать с него.
        // Пропустил — напоминаем; пропустил дважды — короткая версия без подробных правил.
        const miss = ctx.calMiss || 0;
        const lead = `${miss ? `REQUIRED — your last ${miss > 1 ? 'replies' : 'reply'} had no calendar block. ` : 'ALSO, this reply only — '}BEGIN your reply with the calendar block, then write the story as usual:`;
        out.push(`${lead}\n${calRule(ctx, miss >= 2)}`);
    }
    if (request === 'prep' && h) out.push(`ALSO add after the HT line:\n${prepRule(ctx)}`);
    if (request === 'day' && h) out.push(`ALSO add after the HT line: ${dayRule(ctx)}`);
    if (request === 'replan' && h) out.push(`ALSO add after the HT line: ${replanRule(ctx)}`);
    if (request === 'cast') out.push(`ALSO add after the HT line:\n${castRule(ctx)}`);
    if (!dt && !['offered', 'scheduled'].includes(state.date?.status)) out.push(`If in this reply ${userName} and ${charName} set off on a date, add after the HT line: <!-- HT-DATE title=… | goal=… | where=… | started=yes -->.`);

    if (request === 'moment' && h) {
        const ev = openEvent(state, h.id);
        out.push(`ALSO, this reply: something new happens at "${ev?.title || 'the gathering'}" that involves ${charName} or ${userName}, shown in your narration. Then add after the HT line: <!-- HT-EV kind=moment | title=… -->, a few words in ${lang}.`);
    }
    if (request === 'people' && h) {
        out.push(`ALSO add after the HT line:
${PEOPLE_BLOCK}
${peopleRules(ctx)}`);
    }
    if (request === 'recap' && phase.ended) out.push(`ALSO add after the HT line: ${recapRule(ctx)}`);
    out.push('Never skip, mention or explain these comments.');
    return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 3. Отдельный запрос: модель читает историю и ведёт заметки о празднике.
// Пресет не входит; входят карточка, персона, лорбук и последние сообщения.
// ═══════════════════════════════════════════════════════════════
export function buildSideMessages(ctx, needs, src) {
    const { state, phase, userName, charName } = ctx;
    const h = phase.h;
    const lang = langOf(ctx);
    const sys = [`You are Hearthtide, the keeper of the holiday calendar for an ongoing roleplay between ${userName} and ${charName}. You do not continue the story. You read it and reply ONLY with the hidden blocks asked for below — no other text. Notes about what happened hold only what the story has shown. Never decide ${userName}'s thoughts, feelings, words or choices.`];
    if (src.card) sys.push(`[${charName}]\n${src.card}`);
    if (src.persona) sys.push(`[${userName}]\n${src.persona}`);
    if (src.lore) sys.push(`[World info]\n${src.lore}`);
    // заметки без указаний основной модели — помощнику нужны только факты
    const notes = buildStatePrompt({ ...ctx, state: { ...state, beat: null, mentionNow: false, recall: null } })
        .split('\n').filter(l => !/^(This reply|If .+ is away from people|If the scene allows)/.test(l)).join('\n');
    sys.push(`[Calendar notes so far]\n${notes}`);
    // точная дата обязательна: от неё считаются все даты в блоках
    if (state.today != null) sys.push(`[Today in the story] ${isoOf(state.today)}${state.when ? ` (${state.when})` : ''}${ctx.part ? `, ${ctx.part}` : ''}. Count every date from it.`);
    sys.push(`[Story — latest messages, the last one is the newest]\n${src.story || '(empty)'}`);

    const task = [`Reply with these blocks, each at most once, nothing else. Values meant for the player in ${lang}; BEAT in English.`];
    if (needs.has('cal')) task.push(calRule(ctx, false));
    if (needs.has('prep') && h) task.push(prepRule(ctx));
    if (needs.has('day') && h) task.push(dayRule(ctx));
    if (needs.has('replan') && h) task.push(replanRule(ctx));
    else if (needs.has('plancheck') && h) task.push(`Only if the latest messages have moved away from today's plan (something happened earlier, later or differently): ${replanRule(ctx)} Leave this block out if the plan still holds.`);
    if (needs.has('cast') || needs.has('census')) task.push(castRule({ ...ctx, census: needs.has('census') }));
    if (needs.has('people') && h) task.push(`${PEOPLE_BLOCK}\n${peopleRules(ctx)}`);
    if (needs.has('recap') && phase.ended) task.push(recapRule(ctx));

    // Короткие поля одной строкой
    const sf = [];
    if (needs.has('char') && h) sf.push(`char=a short thought of ${charName}'s about the holiday right now, in ${charName}'s own voice, the way people speak in this era, setting and story, under 12 words — never a description of what ${charName} is doing; not echoing earlier ones`);
    if (needs.has('char') && h && charGiftActive(ctx)) sf.push(`gift=${giftJoint(state, h) ? `the current step with ${charName} and ${userName}'s joint gift` : `${charName}'s current step with a gift`} for ${giftTarget(state, h, userName, charName)}, under 8 words, no reason clause (idea → finding or making → ready and hidden → given); gift_done=true once the story shows it given. Leave gift out until there is a real step — never write that it isn't decided`);
    // кому дарят — если подготовка не успела сказать
    if (needs.has('giftto') && h) sf.push(`gift_to=to whom gifts go by custom on this occasion — the one being honoured, as the story names them`);
    const evOpen = h && (phase.kind === 'today' || phase.kind === 'prep') ? openEvent(state, h.id) : null;
    if (evOpen?.status === 'invited') sf.push(`ev=joined if ${userName} accepted the invitation "${evOpen.title}", ev=declined if refused; leave out if not decided yet`);
    else if (evOpen) sf.push(`ev=done with ev_note=its outcome in one sentence once "${evOpen.title}" is over in the story${evOpen.kind === 'party' ? '' : `; ev=skipped if ${userName} turned away`}`);
    if (needs.has('mean') && ctx.meaningFor) sf.push(`mean=what "${ctx.meaningFor}" is and how it is kept in this era and place, one sentence`);
    if (needs.has('bond')) sf.push(`bond=FRIENDSHIP/ROMANCE: how ${charName} and ${userName} stand by the card, persona and story, two numbers −100…100 — friendship (enmity … 0 neutral … very close), romance (hatred or exes … 0 none … deep love); spouses, lovers, rivals and strangers all differ; bond_note=a few words on how they are now`);
    const keys = (x) => (x.startsWith('bond=') ? 'bond=F/R | bond_note=…' : `${x.split('=')[0]}=…`);
    if (sf.length) task.push(`<!-- HT-S ${sf.map(keys).join(' | ')} -->\n${sf.map(x => `- ${x}`).join('\n')}`);

    if (needs.has('moments') && h) {
        const ev = openEvent(state, h.id);
        task.push(`<!-- HT-EV kind=moment | title=… -->
Only if the latest messages show something new at "${ev?.title || 'the gathering'}" that ${userName} joined — a few words. Leave it out otherwise.${ev?.moments?.length ? ` Already: ${ev.moments.slice(-3).map(m => m.title).join(' / ')}.` : ''}`);
    }
    if (needs.has('date') && state.date) task.push(dateUpRule(ctx));
    if (needs.has('dateplan')) task.push(datePlanRule(ctx));
    if (needs.has('daterecap') && !(needs.has('date') && state.date?.status === 'active')) task.push(dateRecapRule(ctx));
    if (needs.has('datewatch')) task.push(`<!-- HT-DATE title=… | goal=… | where=… | at=YYYY-MM-DD HH:MM | started=yes -->
Only if the latest messages show ${userName} and ${charName} on a date that isn't tracked yet (started=yes), or agreeing on one for later (at — when, no started). Leave it out otherwise.`);
    if (needs.has('new')) {
        const known = [...(state.holidays || []).map(x => x.name), ...(ctx.offerNames || []), ...(ctx.passed || [])].filter(Boolean).slice(0, 14);
        task.push(`<!-- HT-NEW CAUSE | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP -->
Only if the story has set up a coming occasion not yet in the calendar — someone's life event that custom marks with a celebration or rite, an announced celebration, an invitation to one. CAUSE: what happened, a few words. Date: if the story names the day or how soon (tomorrow, in a week, on some feast), count exactly that from today; otherwise as custom suggests. TYPE: family | personal | religious | folk | memorial. One per line, at most two. Leave the block out if there is none.${known.length ? ` Already known: ${known.join(', ')}.` : ''}`);
    }
    if (needs.has('beat') && h) {
        const what = phase.kind === 'today' ? `the festive day (${hName(h, ctx)})`
            : phase.kind === 'prep' ? `the coming ${hName(h, ctx)} and the preparations`
            : `the coming ${hName(h, ctx)} (in ${phase.daysTo} days — a passing mention at most)`;
        task.push(`<!-- HT-BEAT … -->
One sentence in English for the story model: one concrete small thing ${what} could bring into the NEXT reply, grounded in the notes and what is happening now — through a person, a custom or a word; vary the kind and never repeat an earlier one${state.beatLog?.length ? ` (earlier: ${state.beatLog.join(' / ')})` : ''}. It must fit the current scene. At most one person per beat; for a family occasion, kin and those the custom involves may come in even if not seen yet. Write none if the scene is urgent or tense, ${userName} is away from people, the scene is already full, or nothing fits naturally — leaving room is fine. Never decide what ${userName} does.`);
    }
    task.push('Never write the story, comments outside the blocks, or explanations.');
    return [
        { role: 'system', content: sys.join('\n\n') },
        { role: 'user', content: task.join('\n\n') },
    ];
}
