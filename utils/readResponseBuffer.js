'use strict';

async function cancelResponseBody(response) {
    try { await response.body?.cancel(); } catch { /* Preserve the original request error. */ }
}

// Enforce attachment limits while streaming, even without Content-Length.
async function readResponseBuffer(response, maxBytes, limitError) {
    if (Number(response.headers.get('content-length') || 0) > maxBytes) {
        await cancelResponseBody(response);
        throw limitError();
    }
    if (!response.body?.getReader) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > maxBytes) throw limitError();
        return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw limitError();
            chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
        return Buffer.concat(chunks, size);
    } catch (error) {
        try { await reader.cancel(); } catch { /* Preserve the download error. */ }
        throw error;
    } finally {
        reader.releaseLock();
    }
}

module.exports = { readResponseBuffer, cancelResponseBody };
