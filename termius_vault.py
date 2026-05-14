"""Walk Termius's Chromium IndexedDB and surface session records + user info."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import plyvel

from inspect_v8 import Reader, decode_value


def _cmp(a: bytes, b: bytes) -> int:
    return (a > b) - (a < b)


def open_idb(db_path: Path) -> plyvel.DB:
    return plyvel.DB(
        str(db_path),
        create_if_missing=False,
        comparator=_cmp,
        comparator_name=b"idb_cmp1",
    )


@dataclass
class SessionRecord:
    local_id: int | None
    remote_id: int | None
    log_status: str | None
    status: str | None
    timestamp: str | None
    connected_at: float | None
    disconnected_at: float | None
    name_blob: str | None
    secretkey_blob: str | None
    command_blob: str | None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def has_local_key(self) -> bool:
        return bool(self.name_blob and self.secretkey_blob)


def iter_session_records(db: plyvel.DB) -> Iterator[SessionRecord]:
    for k, v in db:
        if b"session_log_data" not in v:
            continue
        ssv = v.find(b"\xff")
        if ssv < 0:
            continue
        try:
            obj = decode_value(Reader(v[ssv:]))
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        sld = obj.get("session_log_data") or {}
        yield SessionRecord(
            local_id=obj.get("local_id"),
            remote_id=obj.get("id"),
            log_status=obj.get("log_status"),
            status=obj.get("status"),
            timestamp=obj.get("timestamp"),
            connected_at=obj.get("connected_at"),
            disconnected_at=obj.get("disconnected_at"),
            name_blob=sld.get("name") if isinstance(sld, dict) else None,
            secretkey_blob=sld.get("secretKey") if isinstance(sld, dict) else None,
            command_blob=obj.get("command"),
            raw=obj,
        )


def find_user_email(db: plyvel.DB) -> str | None:
    """Termius user email lives in Local Storage, not IndexedDB; best effort here."""
    for _, v in db:
        m = re.search(rb"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}", v)
        if m:
            return m.group(0).decode()
    return None


def find_user_id(db: plyvel.DB) -> int | None:
    for k, v in db:
        if b"\x04user" not in v:
            continue
        ssv = v.find(b"\xff")
        try:
            obj = decode_value(Reader(v[ssv:]))
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("user_id"), int):
            return obj["user_id"]
    return None
