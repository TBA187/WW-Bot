'use strict';

// Classifies forum posts and pulls application details out of the many formats people actually use.
const { CLASSIFICATIONS, IGNORED_FORUM_USER_ID, IGNORED_FORUM_USERNAME } = require('../constants.js');
const { resolveCountryAtStart, resolveCountryName } = require('./countryRegistry.js');

const BOILERPLATE_PATTERNS = [
    /we(?:'|’)ll review and respond with next steps!?/gi,
    /screen\s*shot of (?:your\s+)?pok(?:e|é)mon id\s*:?/gi
];

const EDIT_METADATA_PATTERN = /^[ \t]*edited\b.*\bby\s+.+$/gim;
const ATTACHMENT_FILENAME_PATTERN = /\b[\w-]+(?:\.[\w-]+)*\.(?:png|jpe?g|gif|webp)(?:\.[a-f0-9]{32})?\b/giu;

const TEMPLATE_PLACEHOLDER_PATTERNS = [
    /^(?:in[\s-]*game(?:[\s-]*name)?|ign|age|country)\s*:?$/i,
    /^screen\s*shot of (?:your\s+)?pok(?:e|é)mon id\s*:?$/i,
    /^what (?:do )?you love to do in pro\s*:?$/i
];

const SHORT_REPLY_PATTERNS = [
    /^(?:bump|up|nvm|never\s*mind|thanks?|thank\s*you|accepted|declined|rejected|good\s*luck)[.!\s]*$/i,
    /^(?:is|are) there (?:still )?(?:room|space)/i,
    /^(?:can|may|could) i (?:join|apply)/i
];

function normalizeValue(value) {
    const cleaned = String(value || '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return cleaned || null;
}

function normalizeLine(value) {
    return String(value || '')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/[ \u00a0]{2,}/g, ' ')
        .trim();
}

function removeAttachmentFilenames(value) {
    return String(value || '').replace(ATTACHMENT_FILENAME_PATTERN, '');
}

function stripLinePrefix(line) {
    return String(line || '')
        .replace(/^[\s📌•*]+/u, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^(?:image|screenshot)\S+\s+(?=(?:ig|ign|in\s*game)\b)/i, '')
        .trim();
}

function recognizeLabel(line) {
    const value = stripLinePrefix(line);
    const valueFirstIgn = value.match(/^([\p{L}\p{N}_.-]{2,32})\s*[-–—]\s*ign\s*(?:&|and)\s*discord\s*$/iu);
    if (valueFirstIgn) return { key: 'ign', value: valueFirstIgn[1], label: 'IGN' };
    const patterns = [
        ['ign', /^(?:in[\s-]*game(?:[\s-]*name)?|ign(?:\s+game(?:\s+name)?)?|ig(?:\s+name)?)(?:\s*\/\s*discord)?\s*(?::|[-–—])\s*(.*)$/i],
        ['age', /^age\s*(?::|[-–—])\s*(.*)$/i],
        ['country', /^(?:country|location|from)\s*(?::|[-–—])\s*(.*)$/i],
        ['image', /^(?:screen\s*shot(?:\s+of\s+(?:your\s+)?pok(?:e|é)mon\s+id)?|pok(?:e|é)mon\s+id|trainer\s*card|id)\s*(?::|[-–—])?\s*(.*)$/i],
        ['interests', /^(?:what\s+(?:do\s+)?you\s+love\s+to\s+do\s+in\s+pro|what\s+i\s+love\s+to\s+do\s+in\s+pro|interests?(?:\s+in\s+game)?|about\s+me|what\s+i\s+love\s+about\s+pro|purpose(?:\s+of\s+playing)?|why\s+(?:do\s+)?you\s+(?:play|want\s+to\s+join))\s*(?::|[-–—])?\s*(.*)$/i],
        ['discord', /^(?:discord|disc)(?:\s+(?:name|username|id))?\s*(?::|[-–—])\s*(.*)$/i],
        ['former_guilds', /^(?:old|former|previous)\s+guilds?\s*(?::|[-–—])?\s*(.*)$/i],
        ['playtime', /^(?:play\s*time|hours?\s+played|activity)\s*(?::|[-–—])\s*(.*)$/i],
        ['gender', /^(?:gender|sex)\s*(?::|[-–—])\s*(.*)$/i],
        ['real_name', /^(?:real\s+name|my\s+name)\s*(?::|[-–—])\s*(.*)$/i]
    ];

    for (const [key, pattern] of patterns) {
        const match = value.match(pattern);
        if (match) return { key, value: normalizeValue(match[1]), label: value.split(/[:–—-]/, 1)[0].trim() };
    }
    return null;
}

function splitIgnNotes(value) {
    const text = normalizeValue(value);
    if (!text) return { ign: null, note: null };
    const match = text.match(/^([\p{L}\p{N}_.-]{2,32})\s*(\(.+\))$/u);
    return match ? { ign: match[1], note: match[2] } : { ign: text, note: null };
}

function looksLikeImageReference(line) {
    return /(?:https?:\/\/\S+|\b(?:image|screenshot)[^\s]*\.(?:png|jpe?g|webp|gif)\b)/i.test(line);
}

function extractAgeAndCountry(value) {
    const text = normalizeValue(value);
    if (!text) return { age: null, country: null };
    const match = text.match(/^(\d{1,3})(?:\s*(?:years?\s*old|y\/?o|yo))?(?:\s+from\s+(.+))?$/i);
    if (!match) return { age: null, country: null };
    return { age: match[1], country: normalizeCountryCandidate(match[2]) };
}

function joinCountries(values) {
    const result = [];
    const seen = new Set();
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result.length ? result.join('/') : null;
}

function countriesFromCandidate(value, allowTrailingText = false) {
    const cleaned = normalizeValue(value);
    if (!cleaned) return [];

    const exact = resolveCountryName(cleaned);
    if (exact) return [exact];

    const result = [];
    const parts = cleaned.split(/\s*(?:\/|\||,|;|\bor\b|\band\b)\s*/iu).filter(Boolean);
    for (const part of parts) {
        const country = allowTrailingText ? resolveCountryAtStart(part) : resolveCountryName(part);
        if (country) result.push(country);
    }
    return result;
}

function normalizeCountryCandidate(value) {
    return joinCountries(countriesFromCandidate(value));
}

function extractCountryFromText(value) {
    const body = String(value || '');
    const narrativeCandidate = `([^\\n,.!?;]{2,100}?)`;
    const narrativeStop = `(?=\\s+(?:but|who|where|while|because|although|and\\s+(?:i|we|live(?:d)?|reside(?:d)?|was|am)\\b|i(?:['\\u2019]?m|\\s+am)\\b)|[,.!?;\\n]|$)`;
    const narrativePatterns = [
        new RegExp(`\\b(?:from|based\\s+in|living\\s+in|live(?:d)?\\s+in|reside(?:d)?\\s+in|located\\s+in|hailing\\s+from|born\\s+in|raised\\s+in)\\s+(?:the\\s+)?${narrativeCandidate}${narrativeStop}`, 'giu'),
        new RegExp(`\\bcountry\\s*(?:is|:)\\s*(?:the\\s+)?${narrativeCandidate}${narrativeStop}`, 'giu')
    ];
    const found = [];

    for (const pattern of narrativePatterns) {
        for (const match of body.matchAll(pattern)) {
            found.push(...countriesFromCandidate(match[1], true));
        }
    }

    // A country on its own line is common in short, positional applications.
    for (const line of body.split(/\r?\n/)) {
        const standalone = String(line).replace(/^[\s*\-\d.)]+/u, '').trim();
        if (standalone.length <= 80) found.push(...countriesFromCandidate(standalone));
    }

    return joinCountries(found);
}

function extractNarrativeDetails(value) {
    const body = String(value || '');
    const ageMatch = body.match(/\b(?:i(?:['’]?m|\s+am))\s+(\d{1,3})\s+years?\s+old(?:\s+this\s+year)?/iu);
    return {
        age: ageMatch?.[1] || null,
        country: extractCountryFromText(body)
    };
}

function positionalApplication(lines, consumed) {
    const candidates = lines
        .map((line, index) => ({ line: normalizeValue(line), index }))
        .filter(item => item.line && !consumed.has(item.index) && !looksLikeImageReference(item.line));

    for (let index = 0; index <= candidates.length - 3; index++) {
        const first = candidates[index];
        const second = candidates[index + 1];
        const third = candidates[index + 2];
        if (!/^[\p{L}\p{N}_.-]{2,32}$/u.test(first.line)) continue;
        if (!/^\d{1,3}(?:\s*(?:years?\s*old|y\/?o|yo))?$/i.test(second.line)) continue;
        if (!/^[\p{L}][\p{L}\p{M}\s.'-]{1,50}$/u.test(third.line)) continue;
        const country = normalizeCountryCandidate(third.line);
        if (!country) continue;
        return {
            ign: first.line,
            age: second.line.match(/\d{1,3}/)?.[0] || null,
            country,
            indexes: [first.index, second.index, third.index]
        };
    }
    return null;
}

function isIgnoredAuthor(post, ignoredUsernames = []) {
    const names = new Set([
        IGNORED_FORUM_USERNAME,
        ...(Array.isArray(ignoredUsernames) ? ignoredUsernames : [])
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
    return String(post.forumUserId || '') === IGNORED_FORUM_USER_ID
        || names.has(String(post.forumUsername || '').trim().toLowerCase());
}

class GuildApplicationParser {
    constructor(options = {}) {
        this.ignoredUsernames = Array.isArray(options.ignoredUsers) ? options.ignoredUsers : [];
    }

    parse(post) {
        if (isIgnoredAuthor(post, this.ignoredUsernames)) {
            return this.result(CLASSIFICATIONS.IGNORED_AUTHOR, 1, ['ignored_forum_author']);
        }

        let body = removeAttachmentFilenames(String(post.bodyText || '')).replace(EDIT_METADATA_PATTERN, '');
        for (const pattern of BOILERPLATE_PATTERNS) body = body.replace(pattern, '');
        const lines = body.split(/\n+/).map(normalizeLine).filter(Boolean);

        if (!lines.length) {
            return this.result(CLASSIFICATIONS.NON_APPLICATION, 0, ['empty_post']);
        }
        if (lines.length <= 2 && SHORT_REPLY_PATTERNS.some(pattern => pattern.test(lines.join(' ')))) {
            return this.result(CLASSIFICATIONS.NON_APPLICATION, 0.05, ['short_reply']);
        }

        const fields = { ign: null, age: null, country: null, interests: null, extraInformation: null };
        const consumed = new Set();
        const reasons = [];
        const extraParts = [];
        let labelledIgn = false;
        let labelledFields = 0;
        let interestLabelFound = false;

        for (let index = 0; index < lines.length; index++) {
            const label = recognizeLabel(lines[index]);
            if (!label) continue;
            labelledFields++;
            consumed.add(index);

            let value = label.value;
            if (!value && index + 1 < lines.length && !recognizeLabel(lines[index + 1])) {
                value = lines[index + 1];
                consumed.add(index + 1);
            }

            if (label.key === 'ign' && value) {
                const ignValue = splitIgnNotes(value);
                fields.ign = ignValue.ign;
                if (ignValue.note) extraParts.push(`IGN note: ${ignValue.note}`);
                labelledIgn = true;
                reasons.push('labelled_ign');
                continue;
            }

            if (label.key === 'age' && value) {
                const combined = extractAgeAndCountry(value);
                fields.age = combined.age || normalizeValue(value.match(/\d{1,3}/)?.[0]);
                if (!fields.country && combined.country) fields.country = combined.country;
                reasons.push('labelled_age');
                continue;
            }

            if (label.key === 'country' && value) {
                fields.country = normalizeCountryCandidate(value) || extractCountryFromText(value);
                if (fields.country) reasons.push('labelled_country');
                continue;
            }

            if (label.key === 'interests') {
                interestLabelFound = true;
                const interestLines = value ? [value] : [];
                let cursor = index + 1;
                if (value && consumed.has(cursor)) cursor++;
                while (cursor < lines.length && !recognizeLabel(lines[cursor])) {
                    if (!looksLikeImageReference(lines[cursor])) interestLines.push(lines[cursor]);
                    consumed.add(cursor);
                    cursor++;
                }
                fields.interests = normalizeValue(interestLines.join('\n'));
                if (fields.interests) reasons.push('interests_section');
                continue;
            }

            if (label.key === 'image') {
                if (value && !looksLikeImageReference(value)) extraParts.push(`${label.label}: ${value}`);
                reasons.push('trainer_card_label');
                continue;
            }

            if (value) extraParts.push(`${label.label}: ${value}`);
        }

        const positional = positionalApplication(lines, consumed);
        if (positional) {
            fields.ign ||= positional.ign;
            fields.age ||= positional.age;
            fields.country ||= positional.country;
            positional.indexes.forEach(index => consumed.add(index));
            reasons.push('positional_identity');
        }

        if (!fields.ign || !fields.age) {
            const candidates = lines
                .map((line, index) => ({ line: normalizeValue(line), index }))
                .filter(item => item.line && !consumed.has(item.index) && !looksLikeImageReference(item.line));
            for (let index = 0; index < candidates.length - 1; index++) {
                const name = candidates[index];
                const age = candidates[index + 1];
                if (!/^[\p{L}\p{N}_.-]{2,32}$/u.test(name.line)) continue;
                if (!/^\d{1,3}(?:\s*(?:years?\s*old|y\/?o|yo))?$/i.test(age.line)) continue;
                fields.ign ||= name.line;
                fields.age ||= age.line.match(/\d{1,3}/)?.[0] || null;
                consumed.add(name.index);
                consumed.add(age.index);
                reasons.push('partial_positional_identity');
                break;
            }
        }

        if (!fields.age || !fields.country) {
            const pair = lines.find(line => {
                const match = line.match(/^\d{1,3}\s+([\p{L}][\p{L}\p{M}\s.'-]{1,50})$/u);
                return match && !/^years?\s+old$/i.test(match[1]);
            });
            if (pair) {
                const match = pair.match(/^(\d{1,3})\s+(.+)$/u);
                fields.age ||= match?.[1] || null;
                fields.country ||= normalizeCountryCandidate(match?.[2]);
                consumed.add(lines.indexOf(pair));
                reasons.push('unlabelled_age_country');
            }
        }

        if (!fields.age || !fields.country) {
            for (let index = 0; index < lines.length - 1; index++) {
                if (consumed.has(index) || consumed.has(index + 1)) continue;
                const age = lines[index].match(/^(\d{1,3})(?:\s*(?:years?\s*old|y\/?o|yo))?$/i);
                const country = lines[index + 1].match(/^[\p{L}][\p{L}\p{M}\s.'-]{1,50}$/u);
                if (!age || !country) continue;
                const normalizedCountry = normalizeCountryCandidate(country[0]);
                if (!normalizedCountry) continue;
                fields.age ||= age[1];
                fields.country ||= normalizedCountry;
                consumed.add(index);
                consumed.add(index + 1);
                reasons.push('positional_age_country');
                break;
            }
        }

        if (!fields.country) {
            const combined = lines.find(line => /^\d{1,3}(?:\s*(?:years?\s*old|y\/?o|yo))?\s+from\s+.+$/i.test(line));
            if (combined) {
                const parsed = extractAgeAndCountry(combined);
                fields.age ||= parsed.age;
                fields.country ||= parsed.country;
                consumed.add(lines.indexOf(combined));
                reasons.push('combined_age_country');
            }
        }

        const narrative = extractNarrativeDetails(body);
        if (narrative.age || narrative.country) {
            fields.age ||= narrative.age;
            fields.country ||= narrative.country;
            reasons.push('narrative_age_country');
        }

        const remaining = lines.filter((line, index) => {
            if (consumed.has(index) || looksLikeImageReference(line)) return false;
            if (/^(?:application|guild application)$/i.test(line)) return false;
            if (TEMPLATE_PLACEHOLDER_PATTERNS.some(pattern => pattern.test(stripLinePrefix(line)))) return false;
            return !BOILERPLATE_PATTERNS.some(pattern => {
                pattern.lastIndex = 0;
                return pattern.test(line);
            });
        });

        if (!fields.interests && interestLabelFound && remaining.length) {
            fields.interests = normalizeValue(remaining.join('\n'));
            remaining.length = 0;
        }
        if (!fields.interests && remaining.length) {
            const activityPattern = /\b(?:pro|pok(?:e|é)mon|pvp|pve|hunt(?:ing)?|boss(?:es)?|dungeons?|teambuild(?:ing)?|collect(?:ing)?|services?|level(?:ing)?|daycare|guild|community|game)\b/i;
            const activityLines = remaining.filter(line => line.length >= 20 && activityPattern.test(line) && !/^edited\b/i.test(line));
            if (activityLines.length) {
                fields.interests = normalizeValue(activityLines.join('\n'));
                for (const line of activityLines) remaining.splice(remaining.indexOf(line), 1);
                reasons.push('inferred_interests');
            }
        }
        extraParts.push(...remaining);
        fields.extraInformation = normalizeValue(extraParts.join('\n'));

        const imageCount = Array.isArray(post.imageUrls) ? post.imageUrls.length : 0;
        const coreCount = [fields.ign, fields.age, fields.country, fields.interests].filter(Boolean).length;
        let score = 0;
        if (fields.ign) score += labelledIgn ? 3 : 2;
        if (fields.age) score += 2;
        if (fields.country) score += 2;
        if (fields.interests) score += 2;
        if (imageCount) score += 1;
        if (labelledFields >= 3) score += 1;
        if (positional) score += 2;
        if (/\b(?:join|guild|application|pvp|pve|dungeon|boss|hunt(?:ing)?)\b/i.test(body)) score += 0.5;

        const confidentApplication = score >= 5
            && (coreCount >= 2 || (coreCount >= 1 && imageCount > 0) || Boolean(positional));
        if (!confidentApplication) {
            return this.result(CLASSIFICATIONS.NON_APPLICATION, Math.min(0.49, score / 10), [
                ...reasons,
                'insufficient_application_evidence'
            ], fields, { structuredFieldCount: coreCount, labelledIgn });
        }

        return this.result(CLASSIFICATIONS.APPLICATION, Math.min(0.99, 0.5 + score / 20), reasons, fields, {
            structuredFieldCount: coreCount,
            labelledIgn,
            ignSource: fields.ign ? (labelledIgn ? 'labelled_text' : 'positional_text') : null,
            ignConfidence: fields.ign ? (labelledIgn ? 0.98 : 0.88) : 0
        });
    }

    result(classification, confidence, reasons, fields = {}, extra = {}) {
        return {
            classification,
            confidence,
            reasons,
            fields: {
                ign: fields.ign || null,
                age: fields.age || null,
                country: fields.country || null,
                interests: fields.interests || null,
                extraInformation: fields.extraInformation || null
            },
            structuredFieldCount: extra.structuredFieldCount || 0,
            labelledIgn: extra.labelledIgn === true,
            ignSource: extra.ignSource || null,
            ignConfidence: Number(extra.ignConfidence || 0)
        };
    }
}

module.exports = {
    GuildApplicationParser,
    extractAgeAndCountry,
    extractCountryFromText,
    extractNarrativeDetails,
    normalizeCountryCandidate,
    isIgnoredAuthor,
    normalizeValue,
    normalizeLine,
    removeAttachmentFilenames,
    positionalApplication,
    recognizeLabel,
    splitIgnNotes
};
