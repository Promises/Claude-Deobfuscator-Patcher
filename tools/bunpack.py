#!/usr/bin/env python3
"""Read and rewrite the module graph embedded in a `bun build --compile` binary.

WHY THIS EXISTS. From Claude Code 2.1.278 the TUI calls Bun.ant.CellSegmenter,
which lives only in Anthropic's private bun fork (@anthropic-ai/bun-internal,
404 on the public registry). A binary we recompile with public bun therefore
compiles, answers --version, and then dies at REPL start. Measured: bun 1.3.11
and 1.4.2 fail identically, and 2.1.263 does not reference the symbol at all.

So instead of rebuilding the binary, we edit the one Anthropic ship: replace the
JS of specific modules inside their executable and keep THEIR runtime. That
sidesteps the private fork entirely and is version-independent.

FORMAT (bun's own, oven-sh/bun src/StandaloneModuleGraph.zig; Rust rewrite in
1.4.x keeps the wire format). On macOS the graph lives in Mach-O segment __BUN,
section __bun, as `u64 payload_len` followed by the blob:

    [ heap: names, contents, sourcemaps, bytecode, ... ]
    [ module table: N x 52-byte records ]
    [ optional 1.4 records (e.g. per-module u32 source hashes) ]
    [ compile_exec_argv, NUL-terminated ]
    [ Offsets: 32 bytes ]
    [ "\n---- Bun! ----\n" ]

Every StringPointer is an absolute offset into the blob, so changing any
length shifts everything after it — the blob is REBUILT, never patched in place.

🔴 TWO HAZARDS, both of which produce a binary that looks fine and is wrong:
  1. SOURCE HASHES. 1.4.x stores each module's precomputed source hash so the
     runtime never has to hash the text. Replace the source and leave the hash
     and JSC still matches the OLD source, so the OLD bytecode runs — a patch
     that "applies" and does nothing. The reader guards on `hash != 0`, so we
     zero the hash of every module we touch.
  2. GROWTH. The __bun section is mapped; it can only grow into the slack the
     segment already has (measured ~7 KB on the 2.1.280 binary). Past that the
     Mach-O must be rebuilt — dyld reports "malformed import table" instead of
     anything helpful. We refuse rather than emit such a binary.
"""
import struct, subprocess, sys

MAGIC = b"\n---- Bun! ----\n"
OFFSETS_SIZE = 32
RECORD_SIZE = 52          # 6 StringPointers + 4 u8 (bun >= 1.3.9)
FLAG_HAS_SOURCE_HASHES = 1 << 5


class Section:
    """The __bun section's location and the room available to grow it."""
    def __init__(self, path):
        self.path = path
        out = subprocess.run(["otool", "-l", path], capture_output=True, text=True).stdout
        seg = out.split("segname __BUN", 1)[1]
        def field(name, text):
            for line in text.splitlines():
                p = line.split()
                if len(p) >= 2 and p[0] == name:
                    return int(p[1], 0)
            raise KeyError(name)
        self.seg_fileoff = field("fileoff", seg)
        self.seg_filesize = field("filesize", seg)
        sec = seg.split("sectname __bun", 1)[1]
        self.offset = field("offset", sec)
        self.size = field("size", sec)
        self.slack = self.seg_fileoff + self.seg_filesize - (self.offset + self.size)


class Module:
    __slots__ = ("name", "contents", "sourcemap", "bytecode", "module_info",
                 "bytecode_origin_path", "tail", "index")

    def __repr__(self):
        return f"<{self.index} {self.name[:60]} {len(self.contents)}B>"


class Graph:
    def __init__(self, path):
        self.path = path
        self.sec = Section(path)
        with open(path, "rb") as fh:
            self.raw = fh.read()
        payload_len = struct.unpack_from("<Q", self.raw, self.sec.offset)[0]
        start = self.sec.offset + 8
        self.blob = self.raw[start : start + payload_len]
        self.blob_start = start

        end = self.blob.rfind(MAGIC)
        if end < 0:
            raise SystemExit("bun trailer magic not found — not a compiled bun binary?")
        o = end - OFFSETS_SIZE
        (self.byte_count, moff, mlen, self.entry_point_id,
         self.argv_off, self.argv_len, self.flags) = struct.unpack_from("<QIIIIII", self.blob, o)
        if mlen % RECORD_SIZE:
            raise SystemExit(f"module table {mlen} not a multiple of {RECORD_SIZE}")
        self.modules_off, self.count = moff, mlen // RECORD_SIZE

        def sp(base, k):
            off, ln = struct.unpack_from("<II", self.blob, base + k * 8)
            return off, ln

        self.modules = []
        for i in range(self.count):
            b = moff + i * RECORD_SIZE
            m = Module(); m.index = i
            m.name = self._s(*sp(b, 0)).decode("utf-8", "replace")
            for k, attr in enumerate(("contents", "sourcemap", "bytecode",
                                      "module_info", "bytecode_origin_path"), start=1):
                setattr(m, attr, self._s(*sp(b, k)))
            m.tail = self.blob[b + 48 : b + 52]
            self.modules.append(m)

        # Per-module u32 source hashes sit immediately after the module table
        # when the flag is set. They must be zeroed for any module we rewrite.
        self.hashes_off = moff + mlen if (self.flags & FLAG_HAS_SOURCE_HASHES) else None

    def _s(self, off, ln):
        return self.blob[off : off + ln]

    def summary(self):
        print(f"  file            {self.path}")
        print(f"  __bun section   offset {self.sec.offset:,}  size {self.sec.size:,}")
        print(f"  segment slack   {self.sec.slack:,} bytes")
        print(f"  blob            {len(self.blob):,} bytes")
        print(f"  modules         {self.count:,}")
        print(f"  entry point     [{self.entry_point_id}] "
              f"{self.modules[self.entry_point_id].name if self.entry_point_id < self.count else '??'}")
        print(f"  flags           0x{self.flags:x}"
              f"{'  (HAS_SOURCE_HASHES)' if self.hashes_off else ''}")
        with_bc = sum(1 for m in self.modules if m.bytecode)
        print(f"  with bytecode   {with_bc:,}")


if __name__ == "__main__":
    g = Graph(sys.argv[1])
    g.summary()
    if len(sys.argv) > 2:
        pat = sys.argv[2]
        hits = [m for m in g.modules if pat in m.name]
        print(f"\n  modules matching {pat!r}: {len(hits)}")
        for m in hits[:10]:
            print(f"    [{m.index}] {m.name}  contents={len(m.contents):,}B "
                  f"bytecode={len(m.bytecode):,}B")


def repack(g, edits, out_path):
    """🔴 BROKEN — DO NOT USE. See MEASURED note at the bottom of this docstring.

    Rebuild the blob with `edits` = {module_index: new_contents_bytes}.

    The blob is rebuilt wholesale: every StringPointer is an absolute offset, so
    changing one length shifts everything after it. Patching in place is not an
    option.

    🔴 MEASURED, 2.1.280: THIS REBUILD IS LOSSY AND ITS OUTPUT DOES NOT RUN.
    Only 129,179,758 of the blob's 148,613,024 bytes are reachable through the
    six StringPointers plus the module table and source hashes. 19,433,266
    bytes — 13% of the payload — are NOT, and this function drops them, so the
    "rebuilt" payload comes out 19.5 MB SMALLER than the original. The loss is
    in the heap, not the 18,468-byte gap between module table and argv, so it
    is most likely the builtin-bytecode and string-table records that
    flags=0x1fff advertises (HAS_BUILTIN_BYTECODE, HAS_BYTECODE_STRING_TABLE,
    HAS_MODULE_INFO_STRING_TABLE, CROSS_COMPILED_BYTECODE).

    Finishing this means decoding those 1.4-era optional records. They are the
    part of the format that could only be read from bun's source, never tested
    — and this binary is built by Anthropic's fork, which may differ again.

    The surgical alternative — leave the blob byte-identical and just repoint
    one module's `contents` into free space — does not rescue it either: the
    entry module is 21,482 bytes against 6,232 bytes of segment slack, and
    module contents are packed with no gap to grow into.
    """
    heap = bytearray()
    def put(b):
        """Append to the heap and return a StringPointer. A NUL always follows:
        the reader takes a sentinel-terminated slice, and length EXCLUDES it."""
        if not b:
            return (len(heap), 0)
        off = len(heap)
        heap.extend(b)
        heap.extend(b"\0")
        return (off, len(b))

    ptrs = []
    for m in g.modules:
        contents = edits.get(m.index, m.contents)
        # ⛔ Drop bytecode for any module we rewrite. Keeping it risks the stale
        # -bytecode hazard, and its 128-byte alignment requirement is not worth
        # preserving for a handful of modules. Untouched modules keep theirs.
        bytecode = b"" if m.index in edits else m.bytecode
        ptrs.append((put(m.name.encode()), put(contents), put(m.sourcemap),
                     put(bytecode), put(m.module_info), put(m.bytecode_origin_path)))

    modules_off = len(heap)
    table = bytearray()
    for (name, contents, smap, bc, minfo, bop), m in zip(ptrs, g.modules):
        for off, ln in (name, contents, smap, bc, minfo, bop):
            table += struct.pack("<II", off, ln)
        table += m.tail
    heap.extend(table)

    if g.hashes_off is not None:
        # 🔴 ZERO THE HASH OF EVERY MODULE WE REWROTE. The runtime trusts this
        # precomputed hash instead of hashing the text, so a stale hash makes
        # JSC match the OLD source and run the OLD bytecode — the patch would
        # apply and silently do nothing. `hash != 0` is the reader's guard.
        old = g.blob[g.hashes_off : g.hashes_off + g.count * 4]
        hashes = bytearray(old)
        for i in edits:
            struct.pack_into("<I", hashes, i * 4, 0)
        heap.extend(hashes)

    argv_ptr = put(b"")
    byte_count = len(heap)
    heap.extend(struct.pack("<QIIIIII", byte_count, modules_off, len(table),
                        g.entry_point_id, argv_ptr[0], argv_ptr[1], g.flags))
    heap.extend(MAGIC)

    grown = len(heap) - len(g.blob)
    if grown > g.sec.slack:
        raise SystemExit(
            f"payload grew {grown:,} bytes but only {g.sec.slack:,} of segment slack "
            f"exist. Beyond this the Mach-O must be rebuilt — dyld reports "
            f"'malformed import table', not a useful error. Shrink the injection.")

    # ⛔ WRITE IN PLACE — THE FILE LAYOUT MUST NOT MOVE. Mach-O load commands,
    # every later segment and the code signature all carry absolute file
    # offsets. Splicing in a different-length blob shifts all of them, and the
    # result is a binary codesign rejects and dyld cannot load. The section is a
    # fixed window: write the blob into it, zero-pad the rest, and change only
    # the u64 length header. (First version of this spliced, and codesign
    # failed — which is the cheap way to find out, rather than a mystery
    # segfault later.)
    window = g.sec.offset + g.sec.size - g.blob_start
    if len(heap) > window:
        raise SystemExit(f"blob {len(heap):,} exceeds the section window {window:,}")
    raw = bytearray(g.raw)
    struct.pack_into("<Q", raw, g.sec.offset, len(heap))
    raw[g.blob_start : g.blob_start + window] = heap + b"\0" * (window - len(heap))
    assert len(raw) == len(g.raw), "file size must not change"
    with open(out_path, "wb") as fh:
        fh.write(raw)
    subprocess.run(["chmod", "+x", out_path], check=True)
    # Any byte change invalidates the signature; ad-hoc re-signing is enough
    # locally (our own bun-built binaries are ad-hoc signed and run fine).
    r = subprocess.run(["codesign", "-f", "-s", "-", out_path],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"codesign failed: {r.stderr.strip()}")
    print(f"  wrote {out_path}  (payload {grown:+,} bytes, slack {g.sec.slack:,})")


# ---------------------------------------------------------------------------
# LENGTH-NEUTRAL IN-PLACE PATCHING — the approach that actually works.
#
# repack() above is unusable: 13% of the blob is not reachable through the
# StringPointers, so rebuilding it drops 19.4 MB. But none of that matters if
# no length ever changes — then every offset stays valid and the undecodable
# records ride along untouched.
#
# The bytes to trade come from the licence banner every chunk carries: 1,997 of
# 2,213 modules on 2.1.280 begin with one, ~600 usable bytes each. Inject code,
# pad the remainder back to a comment, total length unchanged.
#
# PROVEN on versionref/2.1.280-bin: injected a stderr marker into the entry
# module, re-signed ad-hoc, and the binary printed the marker, answered
# --version, AND started the full TUI. That last part is the point — it keeps
# Anthropic's runtime, so Bun.ant.CellSegmenter is present and the REPL lives,
# which is exactly what a public-bun rebuild cannot do.
#
# Zeroing the source hash is load-bearing: the first attempt proved the source
# really executes, because a deliberate syntax error in the injection surfaced
# as a SyntaxError instead of being masked by stale bytecode.
# ---------------------------------------------------------------------------

def banner_slab(contents):
    """Byte range of the leading comment banner, EXCLUDING the first line.

    The first line carries pragmas (`// @bun @bytecode`) that the runtime reads,
    so it is never touched. Everything after it up to the first real code line
    is licence prose — expendable, and the only place we can take bytes from to
    keep an edit length-neutral.
    """
    lines = contents.split(b"\n")
    run = 0
    for i, l in enumerate(lines):
        if l.startswith(b"//") or not l.strip():
            run = i + 1
        else:
            break
    start = len(lines[0]) + 1
    stop = sum(len(l) + 1 for l in lines[:run])
    return start, stop

def inject(contents, code):
    """Splice `code` into the banner, padding so the length is unchanged."""
    start, stop = banner_slab(contents)
    room = stop - start
    if len(code) + 4 > room:
        raise SystemExit(f"injection {len(code)}B exceeds banner room {room}B")
    pad = room - len(code) - 3            # "//" + filler + "\n"
    out = contents[:start] + code + b"//" + b" " * pad + b"\n" + contents[stop:]
    assert len(out) == len(contents), (len(out), len(contents))
    return out

def patch_in_place(g, edits, out_path):
    raw = bytearray(g.raw)
    for i, new in edits.items():
        m = g.modules[i]
        assert len(new) == len(m.contents)
        off, ln = struct.unpack_from("<II", g.blob, g.modules_off + i * 52 + 8)
        raw[g.blob_start + off : g.blob_start + off + ln] = new
        if g.hashes_off is not None:
            struct.pack_into("<I", raw, g.blob_start + g.hashes_off + i * 4, 0)
    assert len(raw) == len(g.raw)
    open(out_path, "wb").write(raw)
    subprocess.run(["chmod", "+x", out_path], check=True)
    r = subprocess.run(["codesign", "-f", "-s", "-", out_path], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("codesign: " + r.stderr.strip())
    print(f"  wrote {out_path} ({len(edits)} module(s), length-neutral)")

