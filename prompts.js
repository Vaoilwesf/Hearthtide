// Hearthtide — prompts.js
// Весь инджект — на английском; ИИ отвечает на языке ролплея.

import { isoOf } from './dates.js';

const PART_EN = { morning: 'morning', day: 'daytime', evening: 'evening', night: 'night' };

function hName(h, ctx) {
    if (!h) return '';
    if (h.birthday) return `${h.who === 'user' ? ctx.userName : ctx.charName}'s birthday`;
    return h.name;
}

// ─── 1. Состояние календаря (поглубже в контексте) ───
export function buildStatePrompt(ctx) {
    const { state, phase, userName, charName } = ctx;
    const s = state.setting || {};
    const lines = ['[Hearthtide — the world\'s calendar and festive life; background for the story, not its topic]'];
    const where = [s.era && `Setting: ${s.era}`, s.faith && `faith: ${s.faith}`, (state.place || s.place) && `place: ${state.place || s.place}`, state.when && `date: ${state.when}`].filter(Boolean);
    if (where.length) lines.push(where.join(' · ') + '.');

    const h = phase.h;
    if (phase.kind === 'far' && h) {
        lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days${h.meaning ? ` (${h.meaning})` : ''}. Not relevant yet — don't bring it up.`);
    }
    if (phase.kind === 'prep' && h) {
        lines.push(`Coming: ${hName(h, ctx)} in ${phase.daysTo} day${phase.daysTo === 1 ? '' : 's'}${h.meaning ? ` (${h.meaning})` : ''}.`);
        const p = state.prep && state.prep.hid === h.id ? state.prep : null;
        if (p) {
            const bits = [p.people && `around ${userName}: ${p.people}`, p.mood && `mood: ${p.mood}`, p.char && `${charName}: ${p.char}`].filter(Boolean);
            if (bits.length) lines.push(`Preparations — ${bits.join(' · ')}`);
        }
        if (h.birthday && h.who === 'user') {
            lines.push(`People close to ${userName} are secretly preparing a surprise — keep it hidden from ${userName}; hints and whispers at most.`);
        }
        lines.push(state.mentionNow
            ? 'This reply: let the preparations show once, naturally — someone busy with them, a remark, a smell from an oven. Never force it.'
            : 'This reply: keep the preparations in the background; don\'t mention them.');
    }
    if (phase.kind === 'today' && h) {
        const plan = state.days?.[`${h.id}#${phase.dayIndex}`];
        const part = ctx.part;
        const dayInfo = h.days > 1 ? `, day ${phase.dayIndex} of ${h.days}` : '';
        lines.push(`TODAY: ${hName(h, ctx)}${dayInfo}${plan?.title ? ` — ${plan.title}` : ''}.`);
        if (plan && part && plan[part]) lines.push(`Now (${PART_EN[part]}): ${plan[part]}`);
        else if (h.meaning) lines.push(`Traditions: ${h.meaning}`);
        lines.push(`The celebration fills the day around the scene: people celebrate, invite, tease, involve; ${charName} takes part in character. Follow the day's order from morning to night — don't jump ahead.`);
        if (h.birthday && h.who === 'user') lines.push(`It is ${userName}'s birthday: the prepared surprise comes out today.`);
    }
    if (phase.kind === 'after' && phase.ended) {
        lines.push(`Yesterday ${hName(phase.ended, ctx)} ended: tiredness, leftovers, cleanup, talk of how it went.`);
        if (h) lines.push(`Next: ${hName(h, ctx)} in ${phase.daysTo} days.`);
    }
    // Свежее событие ленты (за последние 2 ответа) — чтобы сцена могла его подхватить
    if ((phase.kind === 'prep' || phase.kind === 'today') && h) {
        const last = (state.events?.[h.id] || []).slice(-1)[0];
        if (last && (state.turn || 0) - (last.turn || 0) <= 2) {
            lines.push(`Happening now: ${last.who ? `${last.who} — ` : ''}${last.text} (let it surface if it fits the scene; ${charName} may act on it).`);
        }
    }
    const mem = (state.recaps || []).slice(-2);
    if (mem.length) lines.push(`Remembered: ${mem.map(r => `${r.name} — ${r.text}`).join(' · ')}`);

    if (phase.kind === 'prep' || phase.kind === 'today') {
        lines.push(`If ${userName} is away from people (road, wilds, danger), the feast stays distant — a thought, a far-off sound. The calendar never overrides the scene: an urgent or dramatic moment always comes first. Never write ${userName}'s thoughts, feelings, words or choices.`);
    }
    return lines.join('\n');
}

// ─── Какие праздники брать: зависит от эпохи и веры из настроек ───
function holidayGuide(ctx) {
    if (ctx.eraMode !== 'modern') {
        return `Think beyond the famous ones: for this era, place and faith list what people really kept — church feasts, folk and seasonal festivals, fasts, memorial days, local customs. Take the character card, world info and lore into account, including supernatural nights and rites if the setting has spirits or magic.`;
    }
    const faith = ctx.faithMode === 'secular'
        ? `No religious feasts at all — these characters live secular lives.`
        : `Religious feasts: only the biggest ones of the main faith of the place and of the characters (e.g. Orthodox Christmas on Jan 7, Easter on its correct date that year) — not every church feast.`;
    return `MODERN SETTING: only what most people in this country actually celebrate today — major public holidays and days off, big festive days everyone knows, and personal dates. Skip minor official days, professional days, awareness and memorial days, and niche imported holidays, unless one matters to these characters personally. For Russia, for example: New Year (Dec 31 and the January holidays), Defender of the Fatherland Day (Feb 23), International Women's Day (Mar 8), Spring and Labour Day (May 1), Victory Day (May 9), Russia Day (Jun 12), National Unity Day (Nov 4); also widely kept: Valentine's Day, Maslenitsa, Knowledge Day (Sep 1). ${faith} Take the character card and lore into account.`;
}

// ─── 2. Правило тега (конец промпта) ───
export function buildTagPrompt(ctx) {
    const { state, phase, request, userName, charName } = ctx;
    const out = [`[Hearthtide tag — required]
End every reply with one hidden line:
<!-- HT date=YYYY-MM-DD | time=HH:MM | when=DATE_TEXT -->
date: the in-world date, numeric, in the story's own calendar (map fictional months to 1–12). time: the in-world clock now. when: the same date as the story would say it, short, in ${ctx.lang || 'the roleplay\'s language'}. Add place=KIND NAME (e.g. "village Smolyanka", "Novgorod", "the prince's court in Kiev") only when ${userName} moves somewhere else${ctx.placeUnnamed ? ` — and THIS reply, because the current place has no name yet: use the name the story gives it (or a fitting one if the story never named it)` : ''}.`];

    if (state.missed > 0) out.push(`Your previous reply had no HT line — include it now.`);
    if (request !== 'cal') {
        out.push(`If the story sets a new personal or family occasion (a wedding day, a christening, a name day, an anniversary), add once after the HT line: <!-- HT-CAL\nH | YYYY-MM-DD | DAYS | NAME | MEANING | family\n-->`);
    }
    const h = phase.h;

    if (request === 'cal') {
        const known = (state.holidays || []).filter(x => state.today == null || x.start + x.days - 1 >= state.today)
            .map(x => `${x.name} (${isoOf(x.start)})`).slice(0, 5);
        const needB = !state.birthdays?.user || !state.birthdays?.char;
        out.push(`ALSO, this reply only — after the HT line add the calendar block:
<!-- HT-CAL
S | ERA_AND_YEAR | FAITH | PLACE
H | YYYY-MM-DD | DAYS | NAME | MEANING | TYPE
${needB ? `B | user | MM-DD\nB | char | MM-DD\n` : ''}-->
- S: ERA_AND_YEAR in words${ctx.eraMode === 'modern' ? ' (e.g. "modern Russia, 2026")' : `, as people of that time would say it plus our reckoning (e.g. "Ancient Rus, year 6658 from Creation (1150 AD)")`} — no bare numbers or dates; FAITH — ${ctx.eraMode === 'modern' && ctx.faithMode === 'secular' ? 'write "secular"' : 'the faith(s) people actually live by'}; PLACE — the kind of place and its proper name as the story gives it (e.g. "village Smolyanka"; never invent a different name for a place the story already named).
- H: the next 5 holidays from the current date, in date order${known.length ? `, continuing after: ${known.join(', ')}` : ''}. ${holidayGuide(ctx)} Compute movable feasts properly for that year and calendar. Also add personal and family occasions the story gives grounds for: birthdays and name days of the characters and people close to them, weddings, anniversaries, a christening or a baby's naming, memorial days of relatives, a housewarming. DAYS = how many days it lasts. TYPE: religious | folk | seasonal | state | family | supernatural | fast | memorial.${needB ? `\n- B: birthdays of ${userName} and ${charName} from the card and persona; if not stated, choose plausible ones.` : ''}
- NAME and MEANING in ${ctx.lang || 'the roleplay\'s language'}.${ctx.banned?.length ? `\n- NEVER include these (the player removed them): ${ctx.banned.join(', ')}.` : ''}`);
    }
    if (request === 'prep' && h) {
        out.push(`ALSO add after the HT line: <!-- HT-PREP people=… | mood=… | char=… -->
How ${ctx.placeName || `the place around ${userName}`} gets ready for ${hName(h, ctx)} (in ${phase.daysTo} day${phase.daysTo === 1 ? '' : 's'}): people — what the locals are busy with; mood — the general feeling; char — what ${charName} is doing or thinking about it. One or two vivid sentences each, true to the customs of this era and place, in ${ctx.lang || 'the roleplay\'s language'}.${h.birthday && h.who === 'user' ? ` People secretly prepare a surprise for ${userName} — describe it from outside without spoiling it.` : ''}`);
    }
    if (request === 'day' && h) {
        out.push(`ALSO add after the HT line: <!-- HT-DAY title=… | morning=… | day=… | evening=… | night=… -->
How ${hName(h, ctx)} is celebrated TODAY${h.days > 1 ? ` (day ${phase.dayIndex} of ${h.days} — each day may have its own meaning)` : ''} by the traditions of this era and place, from morning to night: rites, food, games, songs, what the people and ${charName} do. title = this day's name or meaning. One or two sentences per part, in ${ctx.lang || 'the roleplay\'s language'}.`);
    }
    if (request === 'event' && h) {
        const recent = (state.events?.[h.id] || []).slice(-3).map(e => e.text);
        out.push(`ALSO add after the HT line: <!-- HT-EVENT who=NAME | kind=KIND | text=… -->
One fresh small happening around ${hName(h, ctx)} right now in ${ctx.placeName || 'this place'}, one sentence, in ${ctx.lang || 'the roleplay\'s language'}. Prefer people already known in the story (${charName}, family, neighbours, friends); only if there are none, a fitting local. Vary it: a gift being made or hidden, a wish or fortune-telling, gossip, a family custom, a mishap in the preparations, or ${charName}'s own thought or plan about the day or about ${userName}. KIND: gift | wish | rumor | prep | family | custom | mishap | thought.${recent.length ? ` Something different from: ${recent.join(' / ')}` : ''}`);
    }
    if (request === 'recap' && phase.ended) {
        out.push(`ALSO add after the HT line: <!-- HT-RECAP one sentence, in ${ctx.lang || 'the roleplay\'s language'}: how ${hName(phase.ended, ctx)} went for ${userName} and ${charName} -->`);
    }
    out.push('Never skip, mention or explain these comments.');
    return out.join('\n');
}
