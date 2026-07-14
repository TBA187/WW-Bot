'use strict';

// Normalizes the country names applicants tend to write, including common spelling variants.
const { countries } = require('countries-list');

function countryKey(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

const COUNTRY_NAMES = new Map();

function registerCountry(name, canonicalName = name) {
    const key = countryKey(name);
    if (key) COUNTRY_NAMES.set(key, canonicalName);
}

// ISO 3166-1 includes sovereign states and territories such as the Isle of Man.
for (const country of Object.values(countries)) {
    registerCountry(country.name, country.name);
    registerCountry(country.native, country.name);
}

const COUNTRY_ALIASES = [
    ['US', 'USA'],
    ['USA', 'USA'],
    ['U.S.A.', 'USA'],
    ['United States of America', 'United States'],
    ['America', 'United States'],
    ['UK', 'United Kingdom'],
    ['U.K.', 'United Kingdom'],
    ['Great Britain', 'United Kingdom'],
    ['Britain', 'United Kingdom'],
    ['UAE', 'United Arab Emirates'],
    ['U.A.E.', 'United Arab Emirates'],
    ['DRC', 'Democratic Republic of the Congo'],
    ['DR Congo', 'Democratic Republic of the Congo'],
    ['Congo-Kinshasa', 'Democratic Republic of the Congo'],
    ['Congo-Brazzaville', 'Republic of the Congo'],
    ['Republic of Korea', 'South Korea'],
    ['Korea', 'South Korea'],
    ['DPRK', 'North Korea'],
    ['Democratic People\'s Republic of Korea', 'North Korea'],
    ['Russian Federation', 'Russia'],
    ['Viet Nam', 'Vietnam'],
    ['Cabo Verde', 'Cape Verde'],
    ['Cote d Ivoire', 'Ivory Coast'],
    ['Cote d\'Ivoire', 'Ivory Coast'],
    ['Czechia', 'Czech Republic'],
    ['Myanmar', 'Myanmar'],
    ['Burma', 'Myanmar'],
    ['Eswatini', 'Eswatini'],
    ['Swaziland', 'Eswatini'],
    ['North Macedonia', 'North Macedonia'],
    ['Macedonia', 'North Macedonia'],
    ['Türkiye', 'Turkey'],
    ['Turkiye', 'Turkey'],
    ['The Netherlands', 'Netherlands'],
    ['Holland', 'Netherlands'],
    ['The Bahamas', 'Bahamas'],
    ['The Gambia', 'Gambia'],
    ['State of Palestine', 'Palestine'],
    ['Palestinian Territories', 'Palestine'],
    ['Holy See', 'Vatican City'],
    ['Vatican', 'Vatican City'],
    ['Vatican City State', 'Vatican City'],
    ['East Timor', 'Timor-Leste'],
    ['Man of Isle', 'Isle of Man'],
    ['Republic of Kosovo', 'Kosovo'],
    ['Kosova', 'Kosovo'],
    ['San Morino', 'San Marino'],
    ['Sahrawi Arab Democratic Republic', 'Western Sahara'],
    ['Federated States of Micronesia', 'Micronesia'],
    ['Republic of Moldova', 'Moldova'],
    ['Lao People\'s Democratic Republic', 'Laos'],
    ['Brunei Darussalam', 'Brunei'],
    ['Syrian Arab Republic', 'Syria'],
    ['Islamic Republic of Iran', 'Iran'],
    ['Plurinational State of Bolivia', 'Bolivia'],
    ['United Republic of Tanzania', 'Tanzania'],
    ['Bolivarian Republic of Venezuela', 'Venezuela'],
    ['Republic of China', 'Taiwan'],
    ['Macau', 'Macao'],
    ['Signapore', 'Singapore'],
    ['Phillipines', 'Philippines'],
    ['Philipines', 'Philippines']
];

for (const [alias, canonicalName] of COUNTRY_ALIASES) registerCountry(alias, canonicalName);

// These are common non-ISO or constituent-country identities applicants may use.
const ADDITIONAL_GEOGRAPHIC_IDENTITIES = [
    'Abkhazia',
    'Artsakh',
    'Catalonia',
    'England',
    'Kurdistan',
    'Nagorno-Karabakh',
    'Northern Cyprus',
    'Northern Ireland',
    'Scotland',
    'Somaliland',
    'South Ossetia',
    'Transnistria',
    'Wales'
];

for (const name of ADDITIONAL_GEOGRAPHIC_IDENTITIES) registerCountry(name);

function resolveCountryName(value) {
    let key = countryKey(value);
    if (key.startsWith('the ')) key = key.slice(4);
    return COUNTRY_NAMES.get(key) || null;
}

function resolveCountryAtStart(value) {
    const exact = resolveCountryName(value);
    if (exact) return exact;

    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    for (let end = Math.min(words.length, 8); end > 0; end--) {
        const country = resolveCountryName(words.slice(0, end).join(' '));
        if (country) return country;
    }
    return null;
}

module.exports = {
    countryKey,
    countryRegistrySize: COUNTRY_NAMES.size,
    resolveCountryAtStart,
    resolveCountryName
};
