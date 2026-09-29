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
    const mem = (state.recaps || []).slice(-2);
    if (mem.length) lines.push(`Remembered: ${mem.map(r => `${r.name} — ${r.text}`).join(' · ')}`);

    if (phase.kind === 'prep' || phase.kind === 'today') {
        lines.push(`If ${userName} is away from people (road, wilds, danger), the feast stays distant — a thought, a far-off sound. The calendar never overrides the scene: an urgent or dramatic moment always comes first. Never write ${userName}'s thoughts, feelings, words or choices.`);
    }
    return lines.join('\n');
}

// ─── 2. Правило тега (конец промпта) ───
export function buildTagPrompt(ctx) {
    const { state, phase, request, userName, charName } = ctx;
    const out = [`[Hearthtide tag — required]
End every reply with one hidden line:
<!-- HT date=YYYY-MM-DD | time=HH:MM | when=DATE_TEXT -->
date: the in-world date, numeric, in the story's own calendar (map fictional months to 1–12). time: the in-world clock now. when: the same date as the story would say it, short, in the roleplay's language. Add place=KIND NAME (e.g. "village Smolyanka", "Novgorod", "the prince's court in Kiev") only when ${userName} moves somewhere else${ctx.placeUnnamed ? ` — and THIS reply, because the current place has no name yet: use the name the story gives it (or a fitting one if the story never named it)` : ''}.`];

    if (state.missed > 0) out.push(`Your previous reply had no HT line — include it now.`);
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
- S: ERA_AND_YEAR in words, as people of that time would say it plus our reckoning (e.g. "Ancient Rus, year 6658 from Creation (1150 AD)") — no bare numbers or dates; FAITH — the faith(s) people actually live by; PLACE — the kind of place and its proper name as the story gives it (e.g. "village Smolyanka"; never invent a different name for a place the story already named).
- H: the next 5 holidays from the current date, in date order${known.length ? `, continuing after: ${known.join(', ')}` : ''}. Think beyond the famous ones: for this era, place and faith list what people really kept — church feasts, folk and seasonal festivals, fasts, memorial days, local customs. Take the character card, world info and lore into account, including supernatural nights and rites if the setting has spirits or magic. Compute movable feasts properly for that year and calendar. DAYS = how many days it lasts. TYPE: religious | folk | seasonal | state | supernatural | fast | memorial.${needB ? `\n- B: birthdays of ${userName} and ${charName} from the card and persona; if not stated, choose plausible ones.` : ''}
- NAME and MEANING in the roleplay's language.${ctx.banned?.length ? `\n- NEVER include these (the player removed them): ${ctx.banned.join(', ')}.` : ''}`);
    }
    if (request === 'prep' && h) {
        out.push(`ALSO add after the HT line: <!-- HT-PREP people=… | mood=… | char=… -->
How ${ctx.placeName || `the place around ${userName}`} gets ready for ${hName(h, ctx)} (in ${phase.daysTo} day${phase.daysTo === 1 ? '' : 's'}): people — what the locals are busy with; mood — the general feeling; char — what ${charName} is doing or thinking about it. One or two vivid sentences each, true to the customs of this era and place, in the roleplay's language.${h.birthday && h.who === 'user' ? ` People secretly prepare a surprise for ${userName} — describe it from outside without spoiling it.` : ''}`);
    }
    if (request === 'day' && h) {
        out.push(`ALSO add after the HT line: <!-- HT-DAY title=… | morning=… | day=… | evening=… | night=… -->
How ${hName(h, ctx)} is celebrated TODAY${h.days > 1 ? ` (day ${phase.dayIndex} of ${h.days} — each day may have its own meaning)` : ''} by the traditions of this era and place, from morning to night: rites, food, games, songs, what the people and ${charName} do. title = this day's name or meaning. One or two sentences per part, in the roleplay's language.`);
    }
    if (request === 'recap' && phase.ended) {
        out.push(`ALSO add after the HT line: <!-- HT-RECAP one sentence, in the roleplay's language: how ${hName(phase.ended, ctx)} went for ${userName} and ${charName} -->`);
    }
    out.push('Never skip, mention or explain these comments.');
    return out.join('\n');
}
