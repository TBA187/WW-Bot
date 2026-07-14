'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
    GuildApplicationOcr,
    prioritizeImagesFromOcr
} = require('../features/guild-applications/parsing/GuildApplicationOcr.js');

test('uses a labelled trainer-card OCR result and reuses one worker', async () => {
    let workerCreates = 0;
    let recognizes = 0;
    const worker = {
        async recognize() {
            recognizes++;
            return { data: { text: 'Trainer Card\nName: Rega\nPlaytime: 200h' } };
        },
        async terminate() {}
    };
    const ocr = new GuildApplicationOcr({
        workerFactory: async () => {
            workerCreates++;
            return worker;
        }
    });
    const image = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const parserResult = { fields: { ign: null }, ignSource: null, ignConfidence: 0 };
    const post = { forumUsername: 'Rega', profileSlug: 'rega' };

    const first = await ocr.resolveIgn(post, parserResult, [{ url: 'card.png', buffer: image }]);
    const second = await ocr.resolveIgn(post, parserResult, [{ url: 'card.png', buffer: image }]);

    assert.equal(first.ign, 'Rega');
    assert.ok(first.confidence >= 0.9);
    assert.equal(second.ign, 'Rega');
    assert.equal(workerCreates, 1);
    assert.equal(recognizes, 2);
    await ocr.close();
});

test('trainer-card OCR evidence promotes the matching image without disturbing ties', () => {
    const ordered = prioritizeImagesFromOcr(
        ['team.png', 'card.png', 'other.png'],
        [
            { url: 'team.png', text: 'A team screenshot' },
            { url: 'card.png', text: 'Trainer Card\nName: Rega\nPlaytime: 200h' }
        ]
    );

    assert.deepEqual(ordered, ['card.png', 'team.png', 'other.png']);
});
