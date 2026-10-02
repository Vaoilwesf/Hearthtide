// Hearthtide — prompts.js
// Весь инджект — на английском. Значения для инфоблока ИИ пишет на выбранном языке.

import { isoOf } from './dates.js';
import { hasGifts, charDue, isIntimate, openEvent } from './calendar.js';

const PART_EN = { morning: 'morning', day: 'daytime', evening: 'evening', night: 'night' };

function hName(h, ctx) {
    if (!h) return '';
    if (h.birthday) return `${h.who === 'user' ? ctx.userName : ctx.charName}'s birthday`;
    return h.name;
}
const langOf = (ctx) => ctx.lang || "the roleplay's language";

// Подарок персонажа игроку уместен, если праздник с подарками и это не день рождения самого персонажа
function charGiftActive(ctx) {
    const { state, phase } = ctx;
    const h = phase.h;
    if (!h || (phase.kind !== 'prep' && phase.kind !== 'today')) return false;
    if (!hasGifts(state, h) || (h.birthday && h.who === 'char')) return false;
    if (state.care?.[h.id] === 'low' && !(h.birthday && h.who === 'user')) return false;
    return !(state.charGift?.hid === h.id && state.charGift.done);
}

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
        lines.push(`Coming: ${hName(h, ctx)} in ${phase.daysTo} day${phase.daysTo === 1 ? '' : 's'}${h.meaning ? ` (${h.meaning})` : ''}.`);
        const p = state.prep && state.prep.hid === h.id ? state.prep : null;
        if (p) {
            const bits = [p.people && `around ${ctx.placeName || userName}: ${p.people}`, p.mood && `mood: ${p.mood}`].filter(Boolean);
            if (bits.length) lines.push(`Preparations — ${bits.join(' · ')}`);
        }
        if (h.birthday && h.who === 'user') {
            lines.push(`People close to ${userName} are secretly preparing a surprise — keep it hidden from ${userName}; hints at most.`);
        }
        lines.push(state.mentionNow
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
        lines.push(`The celebration fills the day around the scene: people celebrate, invite, tease, involve. Follow the day's order — don't jump ahead.`);
        if (h.birthday && h.who === 'user') lines.push(`It is ${userName}'s birthday: the prepared surprise comes out today.`);
    }
    if (phase.kind === 'after' && phase.ended) {
        lines.push(`Yesterday ${hName(phase.ended, ctx)} ended: tiredness, leftovers, talk of how it went.`);
        if (h) lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days.`);
    }

    if (active) {
        // Персонаж: насколько праздник для него важен
        const care = state.care?.[h.id];
        const steps = (state.charLog?.[h.id] || []).slice(-4).map(x => x.text);
        const trail = steps.length ? ` Steps so far: ${steps.join(' → ')}.` : '';
        if (care === 'high') lines.push(`${charName} cares about this a lot.${trail} ${charName} acts on it in small steps across replies when the scene allows; each step follows from the previous ones — no reversal without a reason shown in the story.`);
        else if (care === 'normal') lines.push(`For ${charName} it matters moderately.${trail}`);
        else if (care === 'low') lines.push(`For ${charName} it means little — a passing remark at most.`);
        // Подарок персонажа
        if (charGiftActive(ctx)) {
            const g = state.charGift?.hid === h.id ? state.charGift.text : null;
            lines.push(`${charName}'s gift for ${userName}: ${g || 'not decided yet'} — it moves forward in small steps when the scene allows, never all at once.`);
        }
        // Кто уже отличился — помним до конца праздника
        const hl = (state.highlights?.[h.id] || []).slice(-5);
        if (hl.length) lines.push(`So far: ${hl.map(x => `${x.name} — ${x.text}`).join(' · ')}.`);
        // Люди: по одной строке на человека
        const people = (ctx.peopleSeen || state.people || []).filter(p => p.now).slice(0, 4);
        if (people.length) {
            lines.push(`People: ${people.map(p => `${p.name} (${p.group}) — ${p.now}${p.gift ? `; gift: ${p.gift}` : ''}`).join(' · ')}. They live their own lives in the background; one may cross paths with the scene.`);
        }
    }

    // Воспоминание по кнопке «вспомнить» — один раз
    const fb = state.recall && (state.flashbacks || []).find(f => f.id === state.recall);
    if (fb) lines.push(`${charName} suddenly remembers: ${fb.title} — ${fb.text} Let it surface naturally in this reply.`);
    // Что сейчас в игре: ивент, приглашение или мероприятие
    const ev = h && phase.kind === 'today' ? openEvent(state, h.id) : null;
    if (ev) {
        const who = ev.who ? ` (${ev.who})` : '';
        if (ev.status === 'invited') lines.push(`Invitation pending: ${ev.title}${who}. ${userName} decides whether to go.`);
        else if (ev.kind === 'party') lines.push(`At the gathering: ${ev.title}${who}${ev.moments?.length ? `; so far: ${ev.moments.slice(-2).map(m => m.title).join('; ')}` : ''}. It unfolds around the scene.`);
        else lines.push(`In play: ${ev.title}${who}. Let it unfold over the next replies; ${userName} chooses whether to take part.`);
    }
    if (active) {
        lines.push(`If ${userName} is away from people (road, wilds, danger), the feast stays distant. The calendar never overrides the scene: an urgent or dramatic moment always comes first. Never write ${userName}'s thoughts, feelings, words or choices.`);
    }
    return lines.join('\n');
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
    return `HT-PEOPLE replaces the previous list. P lines: up to 6 people already in the story (not ${charName}, not ${userName}) taking part in this holiday right now. GROUP: relative | friend | acquaintance (to ${userName}). NOW: what they do for THIS holiday — preparing, celebrating, a gift; nothing else. GIFT: their gift while still pending, else empty. Only what the story has shown — no secret plans, no one who has left. D lines: people whose part is done (gave their gift, did their bit) — what they did; they leave the P list. Skip the block if nobody qualifies.`;
}
const PEOPLE_BLOCK = '<!-- HT-PEOPLE\nP | NAME | GROUP | NOW | GIFT\nD | NAME | WHAT_THEY_DID\n-->';

// ─── 2. Правило тега (конец промпта) ───
export function buildTagPrompt(ctx) {
    const { state, phase, request, userName, charName } = ctx;
    const h = phase.h;
    const lang = langOf(ctx);
    const out = [`[Hearthtide tag — required]
End every reply with one hidden line:
<!-- HT date=YYYY-MM-DD | time=HH:MM | when=DATE_TEXT -->
date: in-world date, numeric, in the story's own calendar (fictional months → 1–12). time: in-world clock now. when: the day and month as the story says it, short. Add place=KIND NAME (the settlement or area: its kind word and name as the story says them, not a building) when ${userName} moves or it's wrong${ctx.placeUnnamed ? ` — and THIS reply, because the current place has no name yet: the name the story gives it, or a fitting one` : ''}.
All text values in these comments: ${lang} only.`];

    if (state.langSlip) out.push(`Your last values were not in ${lang} — write them in ${lang}.`);
    if (ctx.fixPlace) out.push(`Add place=… to the HT line THIS reply: the current place rewritten in ${lang}.`);
    if (ctx.fixSetting) out.push(`ALSO add after the HT line: <!-- HT-CAL\nS | ERA_AND_YEAR | FAITH | PLACE\n--> — the current setting rewritten in ${lang}.`);
    if (state.missed > 0) out.push(`Your previous reply had no HT line — include it now.`);
    if (charDue(state, phase)) {
        out.push(`Add char=… to the HT line: ${charName}'s current step about the holiday, a few words — it follows logically from the steps so far, never repeats or reverses them without a reason shown in the story.`);
    }
    if (charGiftActive(ctx)) {
        out.push(`Add gift=… to the HT line: ${charName}'s current step with a gift for ${userName}, a few words; it moves as the story does (idea → finding or making → ready and hidden → given). Add gift_done=true once it is given.`);
    }
    const evOpen = h && phase.kind === 'today' ? openEvent(state, h.id) : null;
    if (evOpen?.status === 'invited') out.push(`Add ev=joined to the HT line if ${userName} accepts the invitation, ev=declined if not.`);
    else if (evOpen) out.push(`When "${evOpen.title}" ends, add ev=done | ev_note=its outcome in one sentence to the HT line${evOpen.kind === 'party' ? '' : `; ev=skipped if ${userName} turned away`}.`);
    if (phase.kind === 'today' && h && request !== 'day' && request !== 'replan' && state.days?.[`${h.id}#${phase.dayIndex}`]) {
        out.push(`If today's plans change in the story, re-send <!-- HT-DAY … --> with the parts still ahead.`);
    }
    if (ctx.meaningFor) out.push(`Add mean=… to the HT line: what "${ctx.meaningFor}" is and how it is kept in this era and place, one sentence.`);
    if (request !== 'cal') {
        const known = ctx.offerNames?.length ? ` Already known: ${ctx.offerNames.join(', ')}.` : '';
        out.push(`If the story sets up a new occasion (someone's life event, an announced celebration, an invitation), add once after the HT line: <!-- HT-NEW CAUSE | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP --> (CAUSE: what happened; TYPE: family|personal|religious|folk|memorial).${known}`);
    }

    if (request === 'cal') {
        const known = (state.holidays || []).filter(x => state.today == null || x.start + x.days - 1 >= state.today)
            .map(x => `${x.name} (${isoOf(x.start)})`).slice(0, 5);
        const needB = !state.birthdays?.user || !state.birthdays?.char;
        out.push(`ALSO, this reply only — after the HT line add the calendar block:
<!-- HT-CAL
S | ERA_AND_YEAR | FAITH | PLACE
H | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE | PREP
${needB ? `B | user | MM-DD | PREP\nB | char | MM-DD | PREP\n` : ''}-->
- S: the era and the year in words${ctx.eraMode === 'modern' ? '' : ', as people of that time would say it, with our reckoning in brackets'} — no bare numbers or dates; FAITH — ${ctx.eraMode === 'modern' && ctx.faithMode === 'secular' ? 'secular' : 'the faith(s) people actually live by'}; PLACE — the kind of place and its proper name exactly as the story gives it (never invent a name the story doesn't use).
- H: the next 4 holidays from the current date, in date order, decided briskly${known.length ? `, continuing after: ${known.join(', ')}` : ''}. ${holidayGuide(ctx)} Compute movable feasts properly for that year and calendar. Occasions the story itself has set up or announced come first. Also add personal and family occasions the story gives grounds for (birthdays and name days of the characters and people close to them, weddings, anniversaries, a newborn's naming, memorial days of relatives, a housewarming). DAYS = how many days it lasts. TYPE: religious | folk | seasonal | state | family | supernatural | fast | memorial. PREP = how many days before it people actually start getting ready or feel it coming (0 for a minor day; a great feast may be weeks). Birthdays of ${userName} and ${charName} go only in B lines, never as H.${needB ? `\n- B: birthdays of ${userName} and ${charName} from the card and persona; if not stated, choose plausible ones.` : ''}${ctx.banned?.length ? `\n- NEVER include these (the player removed them): ${ctx.banned.join(', ')}.` : ''}`);
    }
    if (request === 'prep' && h) {
        const prev = state.prep?.hid === h.id ? state.prep : null;
        const scope = isIntimate(h)
            ? `This is a personal or family occasion: only ${h.birthday && h.who === 'user' ? `the people close to ${userName}` : 'the household and close circle'} get ready — not the whole community.`
            : `This is a public holiday: the community around ${userName} gets ready.`;
        out.push(`ALSO add after the HT line:
<!-- HT-PREP people=… | mood=… | gifts=yes|no | care=high|normal|low -->
How things get ready for ${hName(h, ctx)} (in ${phase.daysTo} day${phase.daysTo === 1 ? '' : 's'}) in ${ctx.placeName || `the place around ${userName}`}. ${scope} people: what is being done now, one or two sentences true to the customs of this era and place; mood: the feeling in the air.${prev?.people ? ` Before it was: "${prev.people}" — show what has moved on since, don't restate it.` : ''} Only what is visible or commonly known — no secret plans the story hasn't shown. gifts: does this holiday involve giving gifts by custom. care: how much it matters to ${charName} personally, judging by who ${charName} is.${h.birthday && h.who === 'user' ? ` A surprise for ${userName} stays unspoiled.` : ''}`);
    }
    if (request === 'day' && h) {
        out.push(`ALSO add after the HT line: <!-- HT-DAY title=… | morning=… | day=… | evening=… | night=… -->
How ${hName(h, ctx)} is celebrated TODAY${h.days > 1 ? ` (day ${phase.dayIndex} of ${h.days} — each day may have its own meaning)` : ''} by the traditions of this era and place, from morning to night: rites, food, games, songs, what people do. title = this day's name or meaning. One or two sentences per part.`);
    }
    if (request === 'replan' && h) {
        const plan = state.days?.[`${h.id}#${phase.dayIndex}`] || {};
        const ahead = ['morning', 'day', 'evening', 'night'];
        const from = Math.max(0, ahead.indexOf(ctx.part));
        out.push(`ALSO add after the HT line: <!-- HT-DAY ${ahead.slice(from).map(p => `${p}=…`).join(' | ')} -->
The day has moved on: rewrite the parts from now on so they follow from what has actually happened today — what is done is not repeated, changed plans are kept. One or two sentences each.${plan[ahead[from]] ? ` The plan was: ${ahead.slice(from).filter(p => plan[p]).map(p => `${p}: ${plan[p]}`).join('; ')}.` : ''}`);
    }
    if (request === 'event' && h) {
        const past = (state.evts || []).filter(e => e.hid === h.id && e.kind !== 'moment').map(e => e.title).slice(-3);
        out.push(`ALSO, this reply: let something that fits ${hName(h, ctx)} and this place come up in the scene and draw ${charName} and ${userName} in — someone involves them, by chance or on purpose; ${userName} still chooses. It must actually appear in your narration. About one time in three make it a gathering someone hosts or invites them to (kind=party — it starts as an invitation). Then add after the HT line: <!-- HT-EV kind=event|party | title=… | who=… -->, title in ${lang}.${past.length ? ` Something different from: ${past.join(' / ')}.` : ''}`);
    }
    if (request === 'moment' && h) {
        const ev = openEvent(state, h.id);
        out.push(`ALSO, this reply: something new happens at "${ev?.title || 'the gathering'}" that involves ${charName} or ${userName}, shown in your narration. Then add after the HT line: <!-- HT-EV kind=moment | title=… -->, a few words in ${lang}.`);
    }
    if (request === 'people' && h) {
        out.push(`ALSO add after the HT line:
${PEOPLE_BLOCK}
${peopleRules(ctx)}`);
    }
    if (request === 'recap' && phase.ended) {
        const e = phase.ended;
        const hl = (state.highlights?.[e.id] || []).map(x => `${x.name} — ${x.text}`).join('; ');
        const g = state.charGift?.hid === e.id && state.charGift.done ? state.charGift.text : null;
        out.push(`ALSO add after the HT line: <!-- HT-RECAP 2–3 sentences in ${lang}: how ${hName(e, ctx)} went for ${userName} and ${charName}, the gifts given and who stood out -->${hl || g ? ` Facts: ${[g && `${charName}'s gift: ${g}`, hl].filter(Boolean).join('; ')}.` : ''}`);
    }
    out.push('Never skip, mention or explain these comments.');
    return out.join('\n');
}
