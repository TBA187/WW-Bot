'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    countryRegistrySize,
    resolveCountryName
} = require('../features/guild-applications/parsing/countryRegistry.js');

test('country registry contains the full ISO dataset and requested geographic identities', () => {
    assert.ok(countryRegistrySize >= 250);
    assert.equal(resolveCountryName('Singapore'), 'Singapore');
    assert.equal(resolveCountryName('Kosovo'), 'Kosovo');
    assert.equal(resolveCountryName('Vatican City'), 'Vatican City');
    assert.equal(resolveCountryName('San Marino'), 'San Marino');
    assert.equal(resolveCountryName('San Morino'), 'San Marino');
    assert.equal(resolveCountryName('Isle of Man'), 'Isle of Man');
    assert.equal(resolveCountryName('Man of Isle'), 'Isle of Man');
    assert.equal(resolveCountryName('East Timor'), 'Timor-Leste');
    assert.equal(resolveCountryName('Catalonia'), 'Catalonia');
});

test('country registry rejects unrelated games and ordinary text', () => {
    assert.equal(resolveCountryName('PokeMMO'), null);
    assert.equal(resolveCountryName('Pokemon Revolution Online'), null);
    assert.equal(resolveCountryName('last month'), null);
});
