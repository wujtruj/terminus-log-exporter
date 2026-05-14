'use strict';
// Walk Chromium IndexedDB entries and surface Termius session records.
// See termius_vault.py for the reference implementation.

const { Reader, decodeValue } = require('./v8_ssv');

const NEEDLE = Buffer.from('session_log_data');

function _decode(v) {
    const ssvStart = v.indexOf(0xff);
    if (ssvStart < 0) return null;
    try {
        return decodeValue(new Reader(v.slice(ssvStart)));
    } catch {
        return null;
    }
}

function _recordFromObj(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const sld = obj.session_log_data;
    const hasSld = sld && typeof sld === 'object';
    const nameBlob = hasSld ? sld.name : null;
    const secretKeyBlob = hasSld ? sld.secretKey : null;
    return {
        local_id: obj.local_id ?? null,
        remote_id: obj.id ?? null,
        log_status: obj.log_status ?? null,
        status: obj.status ?? null,
        timestamp: obj.timestamp ?? null,
        connected_at: obj.connected_at ?? null,
        disconnected_at: obj.disconnected_at ?? null,
        name_blob: typeof nameBlob === 'string' ? nameBlob : null,
        secretkey_blob: typeof secretKeyBlob === 'string' ? secretKeyBlob : null,
        command_blob: obj.command ?? null,
        raw: obj,
    };
}

function* iterSessionRecords(entries) {
    const seen = new Map(); // local_id -> record (last-write wins by scan order)
    for (const { value } of entries) {
        if (value.indexOf(NEEDLE) < 0) continue;
        const obj = _decode(value);
        if (!obj) continue;
        const rec = _recordFromObj(obj);
        if (!rec) continue;
        if (rec.local_id == null) {
            yield rec;
            continue;
        }
        seen.set(rec.local_id, rec);
    }
    for (const rec of seen.values()) yield rec;
}

function hasLocalKey(rec) {
    return Boolean(rec.name_blob && rec.secretkey_blob);
}

module.exports = { iterSessionRecords, hasLocalKey };
