#!/usr/bin/env python3
"""Recover the EMBEDDED ASSETS from a bun --compile single-file executable.

WHY THIS EXISTS
---------------
`extract_chunks.py` recovers the JS chunks. It never recovered the *assets* --
the `.md` / `.txt` / `.node` / `.min.js` files that upstream embeds with
`import x from "..." with { type: "file" }`. A binary rebuilt from chunks alone
therefore contains the code that loads them but not the bytes, and dies at:

    embedded text asset is missing or corrupt

on the first `et26()` call (see `_unmatched/0207_h4t.js`: the loader is a plain
`fs.readFileSync("/$bunfs/root/<name>")`, so the file must exist in bun's VFS
under EXACTLY that name).

HOW NAME -> PAYLOAD IS ATTRIBUTED  (the whole problem)
------------------------------------------------------
Names and payloads are stored in two different places and are NOT adjacent:

  * NAMES live in the standalone-module-graph string pool, NUL-separated, as
    `/$bunfs/root/<name>`. The pool holds the 1642 `chunk-*.js` entries first
    (each listed TWICE), then a contiguous tail of asset entries.
  * PAYLOADS live in one blob much earlier in the file, packed back-to-back
    with a single NUL between members and no names of any kind.

Bun's own offset table was NOT used: it stores blob-relative u32s whose base is
not recoverable by scanning (every candidate base found by voting was a
coincidence -- checked, and rejected, against all 3479 pool paths).

Instead the attribution is POSITIONAL-BUT-VERIFIED: blob members are walked in
order and zipped against the pool's asset tail in order, and then every pair is
CHECKED against content. That check is what makes this trustworthy rather than
assumed -- a naive ordering hypothesis was tried first and FALSIFIED by it
(source-literal order scored 47/106 and mapped `chart.umd.min.js` onto mermaid
content), which is why the pool order is used and why the check is retained
here as a permanent gate rather than deleted once it passed.

Predicate, per asset: take the significant tokens of the filename (dropping the
8-hex content hash and generic words like `SKILL`/`template`/`README` that
cannot discriminate) and require at least one to appear in the decompressed
body. Assets whose name yields no discriminating token are reported separately
and are NOT counted as confirmations -- so the reported figure carries its true
denominator instead of being inflated by the un-checkable ones.

`--verify` makes any mismatch fatal. The build calls it that way.
"""

import argparse
import os
import platform
import re
import struct
import subprocess
import sys

# `/$bunfs/root/<name>` as it appears in the module-graph string pool.
POOL_PATH_RE = re.compile(rb"/\$bunfs/root/([A-Za-z0-9_.\-]+)")

# A bundler-emitted JS chunk, as opposed to an asset. These dominate the pool.
CHUNK_NAME_RE = re.compile(r"chunk-[a-z0-9]{8}\.js\Z")

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

# Filename words that carry no discriminating power: they are shared by dozens
# of assets, so finding them in a body proves nothing about WHICH asset it is.
GENERIC_TOKENS = {
    "html", "skill", "template", "readme", "index", "composed",
    "schema", "json", "text", "file",
}

# The 8-hex-digit content hash upstream's build puts before the extension
# (`SKILL-057df712.md.zst`). Distinct from bun's own base36 asset hash.
NAME_HASH_RE = re.compile(r"-[0-9a-z]{8}(?=\.)")


def zstd_frame_length(data, off):
    """Exact on-disk length of the zstd frame at `off`, or None if malformed.

    Needed because the frames are packed back-to-back: decompressing a
    generous slice would silently succeed while swallowing the next member, so
    the frame must be measured, not guessed. Implements the frame layout from
    RFC 8878 section 3.1 (header, then block sequence, then optional checksum).
    """
    n = len(data)
    p = off + 4
    if p >= n:
        return None
    fhd = data[p]
    p += 1
    fcs_flag = fhd >> 6
    single_segment = (fhd >> 5) & 1
    has_checksum = (fhd >> 2) & 1
    dict_id_flag = fhd & 3
    if not single_segment:
        p += 1  # window descriptor
    p += (0, 1, 2, 4)[dict_id_flag]
    p += {0: (1 if single_segment else 0), 1: 2, 2: 4, 3: 8}[fcs_flag]
    while True:
        if p + 3 > n:
            return None
        hdr = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
        p += 3
        last = hdr & 1
        btype = (hdr >> 1) & 3
        size = hdr >> 3
        if btype == 0 or btype == 2:      # raw / compressed
            p += size
        elif btype == 1:                  # RLE
            p += 1
        else:                             # reserved -- not a real frame
            return None
        if p > n:
            return None
        if last:
            break
    if has_checksum:
        p += 4
    return p - off


def asset_names(data):
    """The pool's asset tail, in pool order.

    The pool lists every `chunk-*.js` first (twice each), then the assets once
    each. Returning the tail preserves the order the payload blob uses.
    """
    pool_names = [m.group(1).decode() for m in POOL_PATH_RE.finditer(data)]
    # The asset tail is the final run containing no chunk names. Walk back from
    # the end while entries are non-chunk to find where it starts.
    end = len(pool_names)
    start = end
    while start > 0 and not CHUNK_NAME_RE.match(pool_names[start - 1]):
        start -= 1
    return pool_names[start:end]


def decompress(blob):
    proc = subprocess.run(
        ["zstd", "-d", "-q", "-c"], input=blob, capture_output=True
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def discriminating_tokens(name):
    stem = NAME_HASH_RE.sub("", name)
    for suffix in (".min.js", ".md.zst", ".txt.zst", ".md", ".txt", ".zst"):
        stem = stem.replace(suffix, "")
    # Also drop bun's own base36 asset hash (`SKILL-9ddmsnpa`, `tui-93b0fcsh`).
    # It is not a word and would otherwise be treated as a strong token that no
    # body can ever contain, turning every such asset into a false MISMATCH.
    stem = re.sub(r"-[0-9a-z]{8}\Z", "", stem)
    # camelCase carries the real words for names like
    # `loopAutonomousPreamble`; without splitting it the whole name becomes one
    # token that appears in no document body.
    stem = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", stem)
    return [
        t
        for t in re.split(r"[^A-Za-z0-9]+", stem.lower())
        if len(t) > 3 and t not in GENERIC_TOKENS
    ]


def content_supports(name, body, strict=False):
    """Tri-state: True confirmed, False contradicted, None un-checkable.

    None is a distinct outcome on purpose. Folding it into True is exactly how
    a coverage number gets inflated past its real denominator.

    `strict` requires EVERY token rather than any one of them, and returns a
    plain bool. The loose form is right for CHECKING an already-established
    pairing (one hit is evidence the pair is not absurd); it is far too weak for
    ESTABLISHING one, where a single common word like "loop" matched 10 different
    candidate names against the same body. Claiming is done under `strict`.
    """
    tokens = discriminating_tokens(name)
    if not tokens:
        return False if strict else None
    # Scan the WHOLE body, not a prefix. A prefix window produced a false
    # MISMATCH on permissions_external-0f27b1d1.txt.zst, whose body says
    # "permission" 11 times but not within the first 4 KB.
    flat = re.sub(rb"[^a-z0-9]", b"", body.lower())
    if strict:
        return all(t.encode() in flat for t in tokens)
    return any(t.encode() in flat for t in tokens)


def macho_length(data, off):
    """On-disk length of the 64-bit Mach-O at `off`, or None if not one.

    Needed because a Mach-O member must be stepped OVER by its own size. The
    previous rule -- skip to the next zstd frame -- silently discarded every
    plain member that shares a gap with a `.node`, which is the whole reason
    the plan templates were classed as unrecoverable (see `plain_members`).

    The length is the maximum `fileoff + filesize` over the LC_SEGMENT_64 load
    commands, which is how the linker lays the image out.
    """
    if data[off : off + 4] != b"\xcf\xfa\xed\xfe":
        return None
    try:
        ncmds = struct.unpack_from("<I", data, off + 16)[0]
    except struct.error:
        return None
    # A plausible header only. Absurd values mean the magic was a coincidence
    # inside unrelated bytes, and walking them would run off the buffer.
    if not 0 < ncmds < 1024:
        return None
    pos = off + 32
    end = 0
    for _ in range(ncmds):
        try:
            cmd, cmdsize = struct.unpack_from("<II", data, pos)
        except struct.error:
            return None
        if not 0 < cmdsize <= 0x10000:
            return None
        if cmd == 0x19:  # LC_SEGMENT_64
            try:
                fileoff, filesize = struct.unpack_from("<QQ", data, pos + 40)
            except struct.error:
                return None
            end = max(end, fileoff + filesize)
        pos += cmdsize
    return end or None


def plain_members(data, frames, blob_start, blob_end):
    """Uncompressed blob members, in file order.

    Not every asset is zstd-compressed: 75 `.md`/`.txt` files are stored
    verbatim, NUL-separated, in the gaps BETWEEN the zstd frames. Two shapes
    occur and both are handled: plain UTF-8, and UTF-16LE (bun stores some
    templates that way -- they show up as `-\\x00-\\x00-\\x00` runs).

    The `.node` members are Mach-O and are deliberately NOT returned: they are
    full of NUL-separated printable symbol names, so a NUL split inside one
    yields thousands of fragments that look like tiny text assets. They are
    excluded by skipping any member starting with a Mach-O magic and by
    requiring a member to be big enough and clean enough to be a document.

    🔴 A Mach-O is stepped over by its OWN measured length, never by jumping to
    the next zstd frame. MEASURED: the gap 196523378..196967833 opens with a
    438064-byte `.node` and holds THREE plain templates immediately after it
    (simple_plan / visual_plan / three_subagents_with_critique). Skipping to
    the frame boundary discarded that entire 444 KB tail, which is why those
    three were reported unrecoverable while sitting in plain UTF-8 in the file.
    The sizing is self-validating: the implied slice starts with a Mach-O magic
    and ends exactly one NUL before the next member, and `file(1)` accepts the
    carved bytes as a standalone arm64 dylib.
    """
    macho_magic = (b"\xca\xfe\xba\xbe", b"\xcf\xfa\xed\xfe")
    covered = [(off, off + length) for off, length in frames]
    members = []
    pos = blob_start
    ci = 0
    while pos < blob_end:
        # Skip over any zstd frame starting here.
        while ci < len(covered) and covered[ci][1] <= pos:
            ci += 1
        if ci < len(covered) and covered[ci][0] <= pos < covered[ci][1]:
            pos = covered[ci][1]
            continue
        limit = covered[ci][0] if ci < len(covered) else blob_end
        if data[pos : pos + 4] in macho_magic:
            size = macho_length(data, pos)
            # Fall back to the old frame-boundary skip only when the header
            # cannot be parsed. A wrong size here would resynchronise the walk
            # mid-binary and emit garbage members, so an unparseable header
            # must not be guessed past.
            pos = pos + size if size else limit
            continue
        # UTF-16LE members are NUL-rich by construction, so the plain
        # "read to the next NUL" rule would cut them after one character.
        # Detect them structurally -- every second byte NUL across a long run --
        # and take the whole run.
        if (
            pos + 40 < limit
            and data[pos + 1] == 0
            and data[pos + 3] == 0
            and data[pos + 5] == 0
            and all(data[pos + 1 + 2 * k] == 0 for k in range(16))
        ):
            # Walk UTF-16 code units. The terminator is a NUL *code unit*
            # (00 00), not a NUL byte: a non-ASCII character such as an em-dash
            # (U+2014 -> 14 20) has a non-zero high byte, so a "high byte must
            # be 00" rule ends the member in the middle of a sentence. That is
            # what split one 14 KB template into eight fragments and left the
            # member count wrong.
            end = pos
            while end + 1 < limit and (data[end] != 0 or data[end + 1] != 0):
                end += 2
            chunk = data[pos:end]
            if len(chunk) >= 100:
                members.append((pos, chunk))
            pos = end + 1
            continue
        end = data.find(b"\x00", pos, limit)
        if end < 0:
            end = limit
        chunk = data[pos:end]
        if len(chunk) >= 100:
            members.append((pos, chunk))
        pos = end + 1
    return members


def decode_member(chunk):
    """UTF-8, or UTF-16LE when the member is stored that way. None if neither.

    UTF-16 is detected by structure (NUL in every other byte), not guessed:
    a UTF-8 document simply does not look like that.
    """
    try:
        chunk.decode("utf-8")
        return chunk
    except UnicodeDecodeError:
        pass
    if len(chunk) >= 4 and chunk[1] == 0 and chunk[3] == 0:
        try:
            # Return the DECODED text for matching. The caller writes the
            # original bytes, so the on-disk asset keeps its exact encoding.
            return chunk.decode("utf-16-le").encode("utf-8")
        except UnicodeDecodeError:
            return None
    return None


def extract(binary_path):
    data = open(binary_path, "rb").read()
    names = asset_names(data)
    if not names:
        raise SystemExit(
            f"{binary_path}: no asset names found in the module-graph pool "
            "-- is this a chunked bun --compile binary?"
        )

    # Compressed members are the zstd frames, in file order. Restrict to the
    # asset region: bun's OWN runtime polyfills are zstd-compressed too and sit
    # much earlier in the file, so an unrestricted scan mixes them in.
    frames = []
    for m in re.finditer(re.escape(ZSTD_MAGIC), data):
        off = m.start()
        if off < 100_000_000:
            continue
        length = zstd_frame_length(data, off)
        if length is None:
            continue
        frames.append((off, length))
    # Drop any frame nested inside another (magic bytes occurring by chance
    # within compressed data would otherwise be read as a member).
    frames.sort()
    top = []
    reach = 0
    for off, length in frames:
        if off >= reach:
            top.append((off, length))
            reach = off + length
    frames = top

    compressed_names = [
        n for n in names if n.endswith(".zst") or n.endswith(".min.js")
    ]
    plain_names = [n for n in names if n not in set(compressed_names)]

    # The blob can hold MORE frames than the pool names: measured on 2.1.259 it
    # holds one extra (a "Claude API - C#" doc) that no pool entry and no source
    # literal references -- an orphan the bundler embedded but nothing loads.
    # Rather than hardcode its index, find the surplus by walking both sequences
    # and dropping any frame the CONTENT check says the current name rejects
    # while the next frame satisfies it. If the counts already agree this loop
    # changes nothing.
    if len(frames) > len(compressed_names):
        bodies = [decompress(data[o : o + L]) for o, L in frames]
        kept, orphans = [], []
        i = j = 0
        while i < len(compressed_names) and j < len(frames):
            if (
                content_supports(compressed_names[i], bodies[j] or b"") is False
                and j + 1 < len(frames)
                and content_supports(compressed_names[i], bodies[j + 1] or b"")
                is True
            ):
                orphans.append(j)
                j += 1
                continue
            kept.append(frames[j])
            i += 1
            j += 1
        kept.extend(frames[j:])
        if len(kept) == len(compressed_names):
            frames = kept

    if len(compressed_names) != len(frames):
        raise SystemExit(
            f"{binary_path}: {len(compressed_names)} compressed asset names in "
            f"the pool but {len(frames)} zstd frames in the asset region -- the "
            "pool tail and the payload blob disagree, so positional pairing is "
            "not safe. Refusing to emit a guessed mapping."
        )

    assets = []
    confirmed = contradicted = uncheckable = 0
    mismatches = []
    for name, (off, length) in zip(compressed_names, frames):
        raw = data[off : off + length]
        body = decompress(raw)
        if body is None:
            raise SystemExit(f"{name}: zstd frame at {off} failed to decompress")
        verdict = content_supports(name, body)
        if verdict is True:
            confirmed += 1
        elif verdict is False:
            contradicted += 1
            mismatches.append((name, body[:70]))
        else:
            uncheckable += 1
        assets.append({"name": name, "bytes": raw, "offset": off})

    # ---- uncompressed members -------------------------------------------
    #
    # These are paired by CONTENT, not by position. Position was tried for the
    # compressed set and works there because the two sequences are the same
    # length; for the plain set the blob also holds Mach-O `.node` members and
    # UTF-16 templates, so the sequences do NOT correspond one-to-one and a
    # positional zip silently mis-pairs (observed: a `.node` name landing on a
    # JS body). A plain member is claimed by a name only when that name's
    # discriminating tokens appear in it, and only when exactly ONE unclaimed
    # name matches -- an ambiguous member is left out rather than guessed.
    blob_start = frames[0][0] if frames else 0
    blob_end = frames[-1][0] + frames[-1][1] if frames else 0
    # The blob opens with a `.node` member that precedes the first frame; start
    # the walk from the earliest Mach-O magic before it so those gaps are seen.
    for magic in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        first = data.find(magic, 185_000_000, blob_start)
        if first != -1:
            blob_start = min(blob_start, first)

    plain_text_names = [n for n in plain_names if not n.endswith(".node")]
    unclaimed = list(plain_text_names)
    plain_confirmed = 0

    # ---- native `.node` addons -------------------------------------------
    #
    # These are Mach-O dylibs, so no token in their NAME appears in their bytes
    # and the text rules above cannot touch them. They are attributed instead by
    # the API THE CONSUMER CALLS ON THEM, read out of the deobfuscated tree, and
    # then disambiguated by CPU type -- both of which are properties of the
    # payload rather than of its position in the file.
    #
    # MEASURED: the binary ships each addon TWICE, once x86_64 and once arm64
    # (7 Mach-O members, 4 distinct addons). Position alone therefore cannot
    # name them, and an earlier positional guess mapped `computer-use-swift`
    # onto the AUDIO addon -- caught only because the carved bytes advertise
    # `start_recording`/`microphone_authorization_status`, which computer-use
    # does not use. Hence signatures, not offsets.
    NODE_SIGNATURES = {
        # `escHotkey` calls `_drainMainRunLoop` and `hotkey.registerEscape`.
        "computer-use-swift.node": (b"_drainMainRunLoop", b"registerEscape"),
        # `computerUse/executor.js` calls `moveMouse`, `key`, `keys`.
        "computer-use-input.node": (b"moveMouse", b"type_text"),
        "audio-capture.node": (b"start_recording", b"microphone_authorization_status"),
        "image-processor.node": (b"read_clipboard_image", b"process_image"),
        "url-handler.node": (b"wait_for_url_event",),
    }
    # This build targets the host, so the host's architecture is the one whose
    # bytes must be embedded. Shipping the x86_64 twin would load and then fail
    # at dlopen, which is a worse failure than not shipping it.
    HOST_CPU = 0x100000C if platform.machine() == "arm64" else 0x1000007

    node_names = [n for n in plain_names if n.endswith(".node")]
    node_confirmed = 0
    macho_members = []
    pos = blob_start
    # Scanned to the START OF THE NAME POOL, not to `blob_end`. The text walk
    # stops at the last zstd frame because a plain member cannot follow one;
    # a `.node` can, and one does -- MEASURED: `url-handler.node` begins at
    # 199071317, past the final frame at 199060405, so the text bound would
    # drop it. The pool is the first `/$bunfs/root/` run after the payloads and
    # is a hard upper bound on where any payload can live.
    node_scan_end = data.find(b"/$bunfs/root/", blob_end)
    if node_scan_end == -1:
        node_scan_end = len(data)
    while True:
        pos = data.find(b"\xcf\xfa\xed\xfe", pos, node_scan_end)
        if pos == -1:
            break
        size = macho_length(data, pos)
        # Ignore tiny or unparseable hits: the magic occurs by chance inside
        # compressed data, and a 4-byte coincidence is not an addon.
        if size and size > 50_000:
            macho_members.append((pos, size))
            pos += size
        else:
            pos += 4

    for name in node_names:
        sig = NODE_SIGNATURES.get(name)
        if not sig:
            continue
        hits = [
            (off, size)
            for off, size in macho_members
            if struct.unpack_from("<I", data, off + 4)[0] == HOST_CPU
            and all(tag in data[off : off + size] for tag in sig)
        ]
        # Exactly one host-architecture member may carry the signature. Two
        # would mean the signature does not identify the addon, and picking
        # either would be a guess.
        if len(hits) == 1:
            off, size = hits[0]
            assets.append({"name": name, "bytes": data[off : off + size], "offset": off})
            node_confirmed += 1

    members = []
    for _off, chunk in plain_members(data, frames, blob_start, blob_end):
        body = decode_member(chunk)
        if body is not None:
            members.append((_off, chunk, body))

    def claim(name, off, chunk):
        nonlocal plain_confirmed
        unclaimed.remove(name)
        assets.append({"name": name, "bytes": chunk, "offset": off})
        plain_confirmed += 1

    # A name whose tokens are a strict SUBSET of another name's cannot be
    # claimed on a strict match alone: the superset name's body satisfies the
    # subset name too, so "exactly one strict hit" is not evidence of identity.
    # MEASURED -- without this, `loopAutonomousPreamble` claimed the 5380-byte
    # body that actually belongs to `loopAutonomousPreamblePersistent`, because
    # the persistent name was excluded by an unrelated token and left the
    # shorter name looking unique. Siblings are handled in pass 2 instead.
    token_sets = {n: set(discriminating_tokens(n)) for n in plain_text_names}

    def has_sibling(name):
        mine = token_sets[name]
        if not mine:
            return False
        return any(
            mine < other for key, other in token_sets.items() if key != name
        )

    # Pass 1 -- unambiguous strict matches. Every token of exactly one unclaimed
    # name appears in the body, and that name has no superset sibling.
    for off, chunk, body in members:
        hits = [n for n in unclaimed if content_supports(n, body, strict=True)]
        if len(hits) == 1 and not has_sibling(hits[0]):
            claim(hits[0], off, chunk)

    # Pass 2 -- SIBLING names, where one name's token set is a strict superset
    # of another's (`loopAutonomousPreamble` vs `...Persistent`). Neither can be
    # claimed in pass 1: the shorter name matches both bodies, so nothing is
    # unique. They are separated on the EXTRA tokens only -- the body that
    # contains them is the longer name's, the body that does not is the
    # shorter's -- and a pair is claimed only when that split is clean both
    # ways, so an ambiguous pair is still declined.
    # Sibling PAIRS are enumerated from the NAMES, not discovered from a body:
    # a body loosely matches many unrelated names (measured: 10 for the loop
    # preamble), so "exactly two loose hits" never fires. Only names in a real
    # subset/superset relation are considered here.
    sibling_pairs = [
        (a, b)
        for a in plain_text_names
        for b in plain_text_names
        if token_sets[a] and token_sets[a] < token_sets[b]
    ]
    for a, b in sibling_pairs:
        if a not in unclaimed or b not in unclaimed:
            continue
        ta, tb = token_sets[a], token_sets[b]
        extra = tb - ta
        # Bodies that satisfy the shared PREFIX tokens. Deliberately NOT the
        # shorter name's full token set: a filename word need not appear in the
        # text it names (MEASURED -- neither loop-preamble body contains the
        # word "persistent", and only one contains "preamble"), so requiring the
        # full set discards the very pair this pass exists to resolve. The
        # shared tokens are what the two siblings genuinely have in common.
        # Narrow to the shared tokens that are actually DISCRIMINATING over the
        # member set: a shared token absent from one of the pair's own bodies
        # (here "preamble", missing from the non-persistent text) would exclude
        # that body and leave a single candidate, collapsing the pair.
        shared = ta & tb
        cands = []
        while shared:
            cands = []
            for off, chunk, body in members:
                flat = re.sub(rb"[^a-z0-9]", b"", body.lower())
                if all(t.encode() in flat for t in shared):
                    cands.append((off, chunk, body))
            if len(cands) >= 2:
                break
            # Drop the rarest shared token and retry; stop before `shared`
            # empties, since an empty set matches every member and proves
            # nothing.
            rarest = min(
                shared,
                key=lambda t: sum(
                    1
                    for _o, _c, bd in members
                    if t.encode() in re.sub(rb"[^a-z0-9]", b"", bd.lower())
                ),
            )
            shared = shared - {rarest}
        if not shared:
            continue
        if len(cands) != 2:
            continue
        # Split the two on the extra token. Exact presence is tried first; when
        # neither body contains it literally, fall back to the token's STEM
        # (`persistent` -> `persist`), which is how the concept actually shows
        # up in prose ("Persistence is the point of autonomous mode"). The
        # fallback only ever runs on a two-candidate set that is already known
        # to be this sibling pair, and it must still separate them 1-and-1 --
        # if it does not, the pair is declined rather than guessed.
        def score(body, needles):
            flat = re.sub(rb"[^a-z0-9]", b"", body.lower())
            return sum(1 for t in needles if t.encode() in flat)

        for needles in (extra, {t[:6] for t in extra if len(t) > 6}):
            if not needles:
                continue
            scored = [(score(body, needles), off, chunk) for off, chunk, body in cands]
            hi = max(s for s, _, _ in scored)
            lo = min(s for s, _, _ in scored)
            if hi == lo:
                continue
            longer = [c for c in scored if c[0] == hi]
            shorter = [c for c in scored if c[0] == lo]
            if len(longer) == 1 and len(shorter) == 1:
                claim(b, longer[0][1], longer[0][2])
                claim(a, shorter[0][1], shorter[0][2])
                break

    # Pass 3 -- the ULTRAPLAN cohort, which no token rule can reach.
    #
    # `simple_plan` / `visual_plan` / `three_subagents_with_critique` are prompt
    # templates whose own text never contains the words "simple", "visual" or
    # "three" (MEASURED -- every strict AND loose token test scores 0 on all
    # three bodies), so passes 1 and 2 cannot claim them even now that the
    # Mach-O walk surfaces them. Positional zip is not an acceptable fallback:
    # it is the hypothesis this module already falsified for the compressed set.
    #
    # They are instead separated on discriminators taken from the CONSUMER
    # code, not invented here. The bundle's own metadata gives
    # `three_subagents_with_critique` the pipeline "Scope -> Critique -> Edit"
    # while the other two share a description, and the only structural
    # difference between the remaining pair is that one instructs a mermaid
    # diagram. So:
    #   critique agent   -> three_subagents_with_critique
    #   mermaid/diagram  -> visual_plan
    #   neither          -> simple_plan
    # Each predicate is required to hit EXACTLY ONE member across the whole
    # plain set (measured: 1 and 1 out of 73), and the cohort is claimed only
    # when all three resolve to distinct members -- so a future build that
    # blurs the distinction declines instead of mis-pairing.
    ultraplan = {
        "three_subagents_with_critique": lambda b: b"critique" in b.lower(),
        "visual_plan": lambda b: b"mermaid" in b.lower(),
    }
    cohort = [n for n in unclaimed if n.split("-")[0] in (
        "simple_plan", "visual_plan", "three_subagents_with_critique"
    )]
    if len(cohort) == 3:
        by_stem = {n.split("-")[0]: n for n in cohort}
        # Candidate pool: members that look like these templates at all. The
        # system-reminder wrapper is upstream's own marker for a prompt
        # template, so it bounds the search without naming any one asset.
        pool = [
            (off, chunk, body)
            for off, chunk, body in members
            if b"<system-reminder>" in body and b"ExitPlanMode" in body
        ]
        picks = {}
        for stem, pred in ultraplan.items():
            hits = [m for m in pool if pred(m[2])]
            if len(hits) == 1:
                picks[stem] = hits[0]
        rest = [m for m in pool if m[0] not in {p[0] for p in picks.values()}]
        if len(picks) == 2 and len(rest) == 1:
            picks["simple_plan"] = rest[0]
            for stem, (off, chunk, _body) in picks.items():
                claim(by_stem[stem], off, chunk)

    return {
        "assets": assets,
        "plain_names": plain_names,
        "stats": {
            "confirmed": confirmed,
            "contradicted": contradicted,
            "uncheckable": uncheckable,
            "compressed": len(compressed_names),
            "plain": len(plain_names),
            "plain_text": len(plain_text_names),
            "plain_recovered": plain_confirmed,
            "node_total": len(node_names),
            "node_recovered": node_confirmed,
        },
        "mismatches": mismatches,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("binary")
    ap.add_argument("-o", "--outdir", required=True)
    ap.add_argument(
        "--verify",
        action="store_true",
        help="exit non-zero if any name/payload pair is contradicted by content",
    )
    args = ap.parse_args()

    result = extract(args.binary)
    stats = result["stats"]

    os.makedirs(args.outdir, exist_ok=True)
    for asset in result["assets"]:
        with open(os.path.join(args.outdir, asset["name"]), "wb") as fh:
            fh.write(asset["bytes"])

    print(
        f"assets: {stats['compressed']} compressed written to {args.outdir}"
    )
    print(
        f"  content-verified: {stats['confirmed']} confirmed, "
        f"{stats['contradicted']} contradicted, "
        f"{stats['uncheckable']} carry no discriminating token "
        f"(denominator {stats['compressed']})"
    )
    print(
        f"  uncompressed: {stats['plain_recovered']}/{stats['plain_text']} "
        "text assets recovered by content match"
    )
    print(
        f"  native: {stats['node_recovered']}/{stats['node_total']} .node addons "
        "recovered by exported-API signature + host CPU type"
    )
    for name, head in result["mismatches"][:20]:
        print(f"  MISMATCH {name}: {head!r}", file=sys.stderr)

    if args.verify and stats["contradicted"]:
        raise SystemExit(
            f"{stats['contradicted']} asset(s) contradicted by content -- "
            "the name/payload pairing is wrong, refusing to proceed"
        )


if __name__ == "__main__":
    main()
