"""Speaker-aware source ingestion and free YouTube subtitle discovery."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .config import CORPUS_PATH, ROOT

PEOPLE_PATH = ROOT / "config/people.yaml"
KB_PATH = ROOT / "config/kb.yaml"
DISCOVERY_PATH = ROOT / "data/youtube-discovery.json"
SEARCHES = (
    "Everstake", "Everstake staking", "Everstake interview", "Everstake Devcon",
    "Everstake Vasylchuk", "Everstake Petrenko", "@Everstake",
)
SELF_INTRO = re.compile(
    r"\b(?:i am|i['’]m|my name is)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?"
    r".{0,90}\b(?:at|from|with)\s+Everstake\b",
    re.I,
)


def load_yaml_json(path: Path) -> dict:
    """Load the shipped JSON-compatible YAML without a YAML dependency."""
    return json.loads(path.read_text())


def people_registry(path: Path = PEOPLE_PATH) -> list[dict]:
    return load_yaml_json(path)["people"]


def _name_match(text: str, person: dict) -> bool:
    return any(re.search(rf"\b{re.escape(name)}\b", text, re.I)
               for name in [person["name"], *person.get("aliases", [])])


def detect_speakers(title: str, description: str, transcript: str,
                    people: list[dict] | None = None) -> list[dict]:
    """Identify registry people in metadata/transcript and bounded self-introductions."""
    registry = people or people_registry()
    searchable = f"{title}\n{description}\n{transcript}"
    found = [
        {"name": person["name"], "role": person["role"]}
        for person in registry if _name_match(searchable, person)
    ]
    known = {item["name"].lower() for item in found}
    for match in SELF_INTRO.finditer(transcript):
        candidate = " ".join(part for part in match.groups() if part).strip()
        registry_match = next((p for p in registry if _name_match(candidate, p)), None)
        if registry_match and registry_match["name"].lower() not in known:
            found.append({"name": registry_match["name"], "role": registry_match["role"]})
            known.add(registry_match["name"].lower())
    return found


def classify_voice(channel: str, channel_id: str, title: str, description: str,
                   transcript: str, config: dict | None = None,
                   people: list[dict] | None = None) -> tuple[str, list[dict]]:
    cfg = config or load_yaml_json(KB_PATH)
    speakers = detect_speakers(title, description, transcript, people)
    official = (
        channel_id in cfg["official_youtube_channel_ids"]
        or channel.casefold() == "everstake"
        or any(handle.casefold().lstrip("@") == channel.casefold().lstrip("@")
               for handle in cfg["official_youtube_handles"])
    )
    if official:
        return "first_party_channel", speakers
    if speakers:
        return "employee_on_third_party", speakers
    return "third_party", []


def relevant_video(metadata: dict, transcript: str, config: dict | None = None) -> tuple[bool, str]:
    cfg = config or load_yaml_json(KB_PATH)
    haystack = f"{metadata.get('title', '')} {metadata.get('description', '')}".casefold()
    if any(term in haystack for term in cfg["negative_lookalikes"]):
        return False, "lookalike"
    if int(metadata.get("duration") or 0) < cfg["minimum_video_seconds"]:
        return False, "short"
    if not transcript.strip():
        return False, "no_usable_subtitles"
    transcript_mentions = len(re.findall(r"\beverstake\b", transcript, re.I))
    if "everstake" not in haystack and transcript_mentions < cfg["transcript_relevance_mentions"]:
        return False, "irrelevant"
    return True, "accepted"


def vtt_to_minute_transcript(vtt: str) -> str:
    """Collapse repeated auto-caption cues and retain one minute marker per block."""
    cues: list[tuple[int, str]] = []
    lines = vtt.splitlines()
    timestamp = re.compile(r"(?:(\d+):)?(\d{2}):(\d{2})[.,]\d+\s+-->")
    for index, line in enumerate(lines):
        match = timestamp.search(line)
        if not match:
            continue
        seconds = int(match.group(1) or 0) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
        text_lines = []
        cursor = index + 1
        while cursor < len(lines) and lines[cursor].strip():
            clean = re.sub(r"<[^>]+>", "", lines[cursor]).strip()
            if clean:
                text_lines.append(clean)
            cursor += 1
        text = " ".join(text_lines)
        if text and (not cues or text != cues[-1][1]):
            cues.append((seconds, text))
    buckets: dict[int, list[str]] = {}
    for seconds, text in cues:
        bucket = seconds // 60
        if not buckets.get(bucket) or text not in buckets[bucket][-1]:
            buckets.setdefault(bucket, []).append(text)
    return "\n".join(f"[{minute:02d}:00] {' '.join(parts)}" for minute, parts in buckets.items())


def _run_json(command: list[str]) -> dict:
    output = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    return json.loads(output)


def _search_ids(limit: int) -> list[str]:
    ids: list[str] = []
    for query in SEARCHES:
        payload = _run_json(["yt-dlp", "--ignore-errors", "--flat-playlist", "--dump-single-json",
                             f"ytsearch60:{query}"])
        for item in payload.get("entries", []):
            video_id = item.get("id")
            if video_id and video_id not in ids:
                ids.append(video_id)
            if len(ids) >= limit * 5:
                return ids
    return ids


def _video_with_subtitles(video_id: str, directory: Path) -> tuple[dict, str]:
    url = f"https://www.youtube.com/watch?v={video_id}"
    metadata = _run_json(["yt-dlp", "--skip-download", "--dump-single-json", url])
    subprocess.run([
        "yt-dlp", "--skip-download", "--write-auto-subs", "--sub-langs", "en-orig,en",
        "--sub-format", "vtt", "-o", str(directory / "%(id)s.%(ext)s"), url,
    ], check=False, capture_output=True, text=True)
    candidates = sorted(directory.glob(f"{video_id}*.vtt"))
    transcript = vtt_to_minute_transcript(candidates[0].read_text(errors="replace")) if candidates else ""
    return metadata, transcript


def video_document(metadata: dict, transcript: str) -> dict:
    cfg = load_yaml_json(KB_PATH)
    voice, speakers = classify_voice(
        metadata.get("channel", ""), metadata.get("channel_id", ""), metadata.get("title", ""),
        metadata.get("description", ""), transcript, cfg,
    )
    uploaded = metadata.get("upload_date") or ""
    published = f"{uploaded[:4]}-{uploaded[4:6]}-{uploaded[6:8]}" if len(uploaded) == 8 else None
    url = f"https://www.youtube.com/watch?v={metadata['id']}"
    text = f"{metadata.get('description', '').strip()}\n\nTranscript\n{transcript}".strip()
    first_party = voice in {"first_party_channel", "employee_on_third_party"}
    attribution = speakers[0]["name"] if speakers else metadata.get("channel", "Unknown source")
    return {
        "url": url, "final_url": url, "title": metadata.get("title") or metadata["id"],
        "text": text, "category": "video", "tier": 1 if first_party else 2, "language": "en",
        "seed": False, "discovered_from": "youtube_search", "published_at": published,
        "modified_at": None, "fetched_at": datetime.now(timezone.utc).isoformat(), "status": 200,
        "content_type": "text/vtt", "sha256": hashlib.sha256(text.encode()).hexdigest(),
        "youtube": {"id": metadata["id"], "channel": metadata.get("channel"),
                    "channel_id": metadata.get("channel_id"), "duration": metadata.get("duration"),
                    "view_count": metadata.get("view_count"), "subtitles": "auto:en-orig/en"},
        "voice": voice, "speakers": speakers, "authority": cfg["voice_authority"][voice],
        "attribution": attribution, "provenance": "stated" if first_party else "reported",
        "trust_penalty": 1.0, "trust_penalty_reason": None,
    }


def discover_youtube(limit: int = 40, corpus: Path = CORPUS_PATH) -> dict:
    existing = [json.loads(line) for line in corpus.read_text().splitlines() if line.strip()]
    known = {row["url"] for row in existing}
    accepted, rejected = [], []
    with tempfile.TemporaryDirectory(prefix="everstake-youtube-") as folder:
        directory = Path(folder)
        for video_id in _search_ids(limit):
            if len(accepted) >= limit:
                break
            try:
                metadata, transcript = _video_with_subtitles(video_id, directory)
                ok, reason = relevant_video(metadata, transcript)
                if not ok:
                    rejected.append({"id": video_id, "reason": reason})
                    continue
                document = video_document(metadata, transcript)
                if document["url"] not in known:
                    accepted.append(document)
                    known.add(document["url"])
            except (subprocess.CalledProcessError, json.JSONDecodeError, OSError) as error:
                rejected.append({"id": video_id, "reason": type(error).__name__})
    if accepted:
        with corpus.open("a") as handle:
            for document in accepted:
                handle.write(json.dumps(document, ensure_ascii=False) + "\n")
    voices = {voice: sum(row["voice"] == voice for row in accepted) for voice in
              ("first_party_channel", "employee_on_third_party", "third_party")}
    result = {"found": len(accepted) + len(rejected), "accepted": len(accepted),
              "rejected": len(rejected), "voices": voices, "rejections": rejected}
    DISCOVERY_PATH.write_text(json.dumps(result, indent=2))
    return result


def propose_people(corpus: Path = CORPUS_PATH) -> dict:
    """Propose, never auto-accept, capitalised names near roles on current About pages."""
    roles = r"CEO|COO|CFO|CMO|CIO|CBDO|CCDO|Head of [A-Za-z& ]+"
    pattern = re.compile(rf"\b([A-Z][a-z]+ [A-Z][a-z]+)\s+({roles})\b")
    registered = {person["name"] for person in people_registry()}
    proposed = []
    for row in map(json.loads, corpus.read_text().splitlines()):
        if "/company/about" not in row["url"]:
            continue
        proposed.extend({"name": name, "role": role} for name, role in pattern.findall(row["text"])
                        if name not in registered)
    result = {"proposals": proposed, "applied": False}
    (ROOT / "data/people-proposals.json").write_text(json.dumps(result, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("discover", "people-sync"))
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()
    result = discover_youtube(args.limit) if args.command == "discover" else propose_people()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
