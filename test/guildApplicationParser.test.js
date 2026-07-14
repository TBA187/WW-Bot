'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GuildApplicationParser } = require('../features/guild-applications/parsing/GuildApplicationParser.js');
const { CLASSIFICATIONS } = require('../features/guild-applications/constants.js');

const parser = new GuildApplicationParser();

function post(bodyText, overrides = {}) {
    return {
        forumUserId: '9001',
        forumUsername: 'Applicant',
        bodyText,
        imageUrls: ['https://example.com/card.png'],
        ...overrides
    };
}

test('parses labelled applications with reordered fields and multiline interests', () => {
    const result = parser.parse(post(`
        Country: Argentina
        In-Game Name: Rolandito
        Screenshot of Your Pokemon ID:
        image.png
        Age: 25
        What you love to do in PRO: Playing PvP battles.
        I also enjoy dungeons with friends.
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.ign, 'Rolandito');
    assert.equal(result.fields.age, '25');
    assert.equal(result.fields.country, 'Argentina');
    assert.match(result.fields.interests, /Playing PvP battles/);
    assert.match(result.fields.interests, /dungeons with friends/);
    assert.equal(result.ignSource, 'labelled_text');
});

test('parses compact aliases and combined age/country values', () => {
    const result = parser.parse(post(`
        Ign- Astreius
        Disc- sera_thelynx
        Age- 26 from India
        What I love to do in PRO- I love PVE and dungeons.
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.ign, 'Astreius');
    assert.equal(result.fields.age, '26');
    assert.equal(result.fields.country, 'India');
    assert.match(result.fields.extraInformation, /Disc: sera_thelynx/i);
});

test('parses positional name, age, and country applications', () => {
    const result = parser.parse(post(`
        Paarth
        31
        india
        Screenshot 2026-06-18 125006.png
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.ign, 'Paarth');
    assert.equal(result.fields.age, '31');
    assert.equal(result.fields.country, 'India');
    assert.equal(result.ignSource, 'positional_text');
});

test('parses empty label lines and free-form age values', () => {
    const result = parser.parse(post(`
        In game name:
        Darkviper29401
        Age:
        Im currently 19
        Country:
        India
        What you love to do in PRO
        I mostly like doing bosses, dungeons, and PvP.
    `));
    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.ign, 'Darkviper29401');
    assert.equal(result.fields.age, '19');
    assert.equal(result.fields.country, 'India');
});

test('parses value-first IGN and positional age/country lines', () => {
    const result = parser.parse(post(`
        Solosolow - IGN & Discord
        25
        USA
        I enjoy the online community and interacting with other players.
    `));
    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.ign, 'Solosolow');
    assert.equal(result.fields.age, '25');
    assert.equal(result.fields.country, 'USA');
});

test('parses numbered labels and narrative age/country formats', () => {
    const numbered = parser.parse(post(`
        1. Ingame Name:
        Infamousro
        2. Age:
        19
        3. Country:
        India
        About me:
        I mainly play PVE and I am practicing PvP.
    `));
    const narrative = parser.parse(post(`
        Hey my name is Nicholas im 29 Years old from germany im studying to become a teacher.
        I love PvP, PVE, hunting, and daycare services in PRO.
    `));
    assert.equal(numbered.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(numbered.fields.ign, 'Infamousro');
    assert.equal(narrative.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(narrative.fields.age, '29');
    assert.equal(narrative.fields.country.toLowerCase(), 'germany');
    assert.equal(narrative.fields.ign, null);
});

test('infers a country from narrative Extra Information', () => {
    const result = parser.parse(post(`
        IGN: Aaronlee191
        Age: 23
        Discord: Aaronlee191#6381
        I’m 23 years old and from Singapore.
        I am online every day and enjoy helping other players.
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.country, 'Singapore');
});

test('skips game names and keeps a later valid narrative country', () => {
    const result = parser.parse(post(`
        IGN: Aaronlee191
        Age: 23
        I am a competitive PvP player who transitioned to Pokemon Revolution Online from PokeMMO.
        I am 23 years old and from Singapore.
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.country, 'Singapore');
});

test('accepts standalone countries and preserves multiple valid countries', () => {
    const standalone = parser.parse(post(`
        IGN: NordicPlayer
        Age: 25
        Denmark
        I enjoy PvP and dungeons in PRO.
    `));
    const multiple = parser.parse(post(`
        IGN: BorderPlayer
        Age: 26
        Country: Denmark/Germany
        I enjoy hunting Pokemon with the guild.
    `));
    const narrative = parser.parse(post(`
        IGN: MovingPlayer
        Age: 27
        I was born in Denmark and live in Germany.
        I enjoy PvP and PRO dungeons.
    `));

    assert.equal(standalone.fields.country, 'Denmark');
    assert.equal(multiple.fields.country, 'Denmark/Germany');
    assert.equal(narrative.fields.country, 'Denmark/Germany');
});

test('removes attachment filenames from application text', () => {
    const result = parser.parse(post(`
        IGN: Guhan
        Age: 22
        Country: India
        I enjoy PvP and interacting with people IMG_20250122_063112.jpg.058478e8c100841d3be51d449139e89b2.jpg
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.doesNotMatch(result.fields.interests, /IMG_20250122|\.jpg/i);
});

test('does not mistake "years old" for a country in a partial positional application', () => {
    const result = parser.parse(post(`
        Guhan
        22 years old
        I love interacting with people and playing PvP in PRO.
    `));
    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.equal(result.fields.age, '22');
    assert.equal(result.fields.country, null);
});

test('moves optional details into Extra Information', () => {
    const result = parser.parse(post(`
        IGN - Infamousro
        Age - 19
        Country - India
        Old Guilds: Bullet Club, Eternal, Slytherins
        Discord: infamous.pro
        About me: I mainly enjoy PVE and I am learning PvP.
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.match(result.fields.extraInformation, /Old Guilds: Bullet Club/i);
    assert.match(result.fields.extraInformation, /Discord: infamous\.pro/i);
});

test('removes copied template boilerplate from application values', () => {
    const result = parser.parse(post(`
        In-Game Name: Lulanisme
        Age: 32
        Country: TAIWAN
        What you love to do in PRO: We'll review and respond with next steps!
        Collect various high-value Pokemon and chat with the guild.
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.doesNotMatch(result.fields.interests, /review and respond/i);
    assert.match(result.fields.interests, /Collect various/);
});

test('removes forum edit metadata and trainer-card placeholder text', () => {
    const result = parser.parse(post(`
        In game name: foxcomeback
        Age: 37
        Country: viet nam
        Screen shot of your pokemon ID
        What you love to do in PRO: Hunt, training, daycare, collect and go dungeon with friend
        With me PRO is truth pokemon world
        Edited August 1, 2025Aug 1 by Foxcomeback
    `));

    assert.equal(result.classification, CLASSIFICATIONS.APPLICATION);
    assert.doesNotMatch(result.fields.interests, /Edited August/i);
    assert.equal(result.fields.extraInformation, null);
});

test('rejects questions and short discussion replies', () => {
    const result = parser.parse(post('Is there still room in the guild?', { imageUrls: [] }));
    assert.equal(result.classification, CLASSIFICATIONS.NON_APPLICATION);
});

test('always ignores Vangogsan by ID or username', () => {
    const byId = parser.parse(post('IGN: Fake\nAge: 20\nCountry: USA', { forumUserId: '163701' }));
    const byName = parser.parse(post('IGN: Fake\nAge: 20\nCountry: USA', { forumUserId: null, forumUsername: 'VANGOgsan' }));
    assert.equal(byId.classification, CLASSIFICATIONS.IGNORED_AUTHOR);
    assert.equal(byName.classification, CLASSIFICATIONS.IGNORED_AUTHOR);
});

test('ignores additional configured forum usernames', () => {
    const configuredParser = new GuildApplicationParser({ ignoredUsers: ['AnotherUniqueForumUser'] });
    const result = configuredParser.parse(post('IGN: Fake\nAge: 20\nCountry: USA', {
        forumUserId: null,
        forumUsername: 'anotheruniqueforumuser'
    }));

    assert.equal(result.classification, CLASSIFICATIONS.IGNORED_AUTHOR);
});
