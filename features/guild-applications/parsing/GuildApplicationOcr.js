'use strict';

// Uses trainer-card screenshots as a fallback when the forum text does not give us a reliable IGN.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { MAX_OCR_IMAGES } = require('../constants.js');

function normalizeIdentity(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();
}

function cleanIgnCandidate(value) {
    const cleaned = String(value || '')
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_.-]+$/gu, '')
        .trim();
    if (!/^[\p{L}\p{N}_.-]{2,32}$/u.test(cleaned)) return null;
    return cleaned;
}

function extractIgnFromOcr(text) {
    const normalized = String(text || '').replace(/\r/g, '');
    const labelled = normalized.match(/\bname\s*[:\-]?\s*([\p{L}\p{N}_.-]{2,32})/iu);
    if (labelled) return { value: cleanIgnCandidate(labelled[1]), labelled: true };

    const lines = normalized.split(/\n+/).map(line => cleanIgnCandidate(line)).filter(Boolean);
    return { value: lines[0] || null, labelled: false };
}

function prioritizeImagesFromOcr(imageUrls, ocrOutput) {
    const scores = new Map();
    for (const result of Array.isArray(ocrOutput) ? ocrOutput : []) {
        if (!result?.url || !result.text) continue;
        const text = String(result.text);
        let score = scores.get(result.url) || 0;
        if (/\bname\s*[:\-]/iu.test(text)) score += 100;
        if (/\btrainer\b|\bplay\s*time\b|\bpok(?:e|é)dex\b|\bbadges?\b/iu.test(text)) score += 30;
        scores.set(result.url, score);
    }

    return [...(imageUrls || [])]
        .map((url, index) => ({ url, index, score: scores.get(url) || 0 }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(item => item.url);
}

class GuildApplicationOcr {
    constructor(options = {}) {
        this.sharp = options.sharp || sharp;
        this.workerFactory = options.workerFactory || null;
        this.worker = options.worker || null;
        this.workerPromise = null;
        this.queue = Promise.resolve();
        this.maxImages = options.maxImages || MAX_OCR_IMAGES;
        this.cachePath = options.cachePath || path.join(process.cwd(), 'data', 'tesseract-cache');
    }

    enqueue(task) {
        const pending = this.queue.then(task, task);
        this.queue = pending.catch(() => {});
        return pending;
    }

    async getWorker() {
        if (this.worker) return this.worker;
        if (!this.workerPromise) {
            this.workerPromise = (async () => {
                if (this.workerFactory) return this.workerFactory();
                const { createWorker } = require('tesseract.js');
                fs.mkdirSync(this.cachePath, { recursive: true });
                return createWorker('eng', 1, { logger: () => {}, cachePath: this.cachePath });
            })();
        }
        this.worker = await this.workerPromise;
        return this.worker;
    }

    async preprocessCrop(buffer) {
        const image = this.sharp(buffer).rotate();
        const metadata = await image.metadata();
        const width = metadata.width || 1;
        const height = metadata.height || 1;
        const cropWidth = Math.max(1, Math.floor(width * 0.62));
        const cropHeight = Math.max(1, Math.floor(height * 0.38));

        return image
            .extract({ left: 0, top: 0, width: cropWidth, height: cropHeight })
            .resize({ width: Math.min(2400, cropWidth * 3), withoutEnlargement: false })
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
    }

    async preprocessFull(buffer) {
        return this.sharp(buffer)
            .rotate()
            .resize({ width: 2200, withoutEnlargement: true })
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
    }

    async recognizeBuffer(buffer) {
        const worker = await this.getWorker();
        const result = await worker.recognize(buffer);
        return result?.data?.text || result?.text || '';
    }

    identitySupports(candidate, post) {
        const normalized = normalizeIdentity(candidate);
        if (!normalized) return false;
        return [post.forumUsername, post.profileSlug]
            .map(normalizeIdentity)
            .filter(Boolean)
            .some(identity => identity === normalized || identity.includes(normalized) || normalized.includes(identity));
    }

    async resolveIgn(post, parserResult, downloadedImages = []) {
        if (parserResult.fields.ign) {
            return {
                ign: parserResult.fields.ign,
                source: parserResult.ignSource,
                confidence: parserResult.ignConfidence,
                output: null
            };
        }

        return this.enqueue(async () => {
            const outputs = [];
            for (const image of downloadedImages.filter(item => item?.buffer).slice(0, this.maxImages)) {
                for (const mode of ['crop', 'full']) {
                    try {
                        const prepared = mode === 'crop'
                            ? await this.preprocessCrop(image.buffer)
                            : await this.preprocessFull(image.buffer);
                        const text = await this.recognizeBuffer(prepared);
                        outputs.push({ url: image.url, mode, text });
                        const extracted = extractIgnFromOcr(text);
                        if (!extracted.value) continue;

                        let confidence = extracted.labelled ? 0.86 : 0.7;
                        if (this.identitySupports(extracted.value, post)) confidence += 0.08;
                        if (confidence >= 0.78) {
                            return {
                                ign: extracted.value,
                                source: extracted.labelled ? `ocr_${mode}` : `ocr_${mode}_unlabelled`,
                                confidence: Math.min(0.98, confidence),
                                output: outputs
                            };
                        }
                    } catch (error) {
                        outputs.push({ url: image.url, mode, error: error.message });
                    }
                }
            }

            return { ign: null, source: null, confidence: 0, output: outputs };
        });
    }

    async close() {
        await this.queue.catch(() => {});
        const worker = this.worker || (this.workerPromise ? await this.workerPromise.catch(() => null) : null);
        if (worker?.terminate) await worker.terminate();
        this.worker = null;
        this.workerPromise = null;
    }
}

module.exports = {
    GuildApplicationOcr,
    cleanIgnCandidate,
    extractIgnFromOcr,
    normalizeIdentity,
    prioritizeImagesFromOcr
};
