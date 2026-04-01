#!/usr/bin/env python3
"""
Split a bundled Claude Code JS source into individual module files.

Parses the esbuild bundle format, identifying:
- Runtime preamble (helper functions)
- CJS modules: CommonJS-style lazy module factories (auto-detected)
- ESM modules: ESM-style lazy initializers (auto-detected)
- Glue code: top-level declarations and functions between modules
- Tail: entry point code after the last module

Wrapper function names are detected automatically from the preamble,
so this doesn't need updating when esbuild minification changes them.

Outputs numbered section files + a manifest.json for reassembly.
"""

import json
import os
import re
import sys


def find_matching_paren(data, open_pos):
    """Find the ) that matches the ( at open_pos.

    Properly handles:
    - Single/double quoted strings with escapes
    - Template literals with nested ${expressions}
    - Regular expressions (with character classes)
    - Line and block comments
    """
    paren_depth = 0
    i = open_pos

    # Context stack: 'sq', 'dq', 'tpl', 'tpl_expr', 'brace'
    stack = []

    while i < len(data):
        c = data[i]
        top = stack[-1] if stack else None

        # --- Inside single-quoted string ---
        if top == "sq":
            if c == "\\":
                i += 2
                continue
            if c == "'":
                stack.pop()
            i += 1
            continue

        # --- Inside double-quoted string ---
        if top == "dq":
            if c == "\\":
                i += 2
                continue
            if c == '"':
                stack.pop()
            i += 1
            continue

        # --- Inside template literal ---
        if top == "tpl":
            if c == "\\":
                i += 2
                continue
            if c == "`":
                stack.pop()
                i += 1
                continue
            if c == "$" and i + 1 < len(data) and data[i + 1] == "{":
                stack.append("tpl_expr")
                i += 2
                continue
            i += 1
            continue

        # --- Inside template expression ${...} or nested brace ---
        if top in ("tpl_expr", "brace"):
            if c == "'":
                stack.append("sq")
                i += 1
                continue
            if c == '"':
                stack.append("dq")
                i += 1
                continue
            if c == "`":
                stack.append("tpl")
                i += 1
                continue
            if c == "/" and i + 1 < len(data):
                if data[i + 1] == "/":
                    nl = data.find("\n", i)
                    i = nl + 1 if nl != -1 else len(data)
                    continue
                if data[i + 1] == "*":
                    end = data.find("*/", i + 2)
                    i = end + 2 if end != -1 else len(data)
                    continue
                if _is_regex_start(data, i):
                    i = _skip_regex(data, i)
                    continue
            if c == "{":
                stack.append("brace")
                i += 1
                continue
            if c == "}":
                stack.pop()
                i += 1
                continue
            i += 1
            continue

        # --- Top-level parsing ---
        if c == "'":
            stack.append("sq")
            i += 1
            continue
        if c == '"':
            stack.append("dq")
            i += 1
            continue
        if c == "`":
            stack.append("tpl")
            i += 1
            continue

        # Comments
        if c == "/" and i + 1 < len(data):
            if data[i + 1] == "/":
                nl = data.find("\n", i)
                i = nl + 1 if nl != -1 else len(data)
                continue
            if data[i + 1] == "*":
                end = data.find("*/", i + 2)
                i = end + 2 if end != -1 else len(data)
                continue
            if _is_regex_start(data, i):
                i = _skip_regex(data, i)
                continue

        if c == "(":
            paren_depth += 1
        elif c == ")":
            paren_depth -= 1
            if paren_depth == 0:
                return i

        i += 1
    return -1


def _is_regex_start(data, pos):
    """Check if / at pos starts a regex literal (not division)."""
    j = pos - 1
    while j >= 0 and data[j] in " \t\n\r":
        j -= 1
    if j < 0:
        return True
    c = data[j]
    if c in "(,=:;[!&|?{+->~^%<":
        return True
    for kw in (
        "return", "typeof", "void", "delete", "throw",
        "new", "case", "instanceof", "in",
    ):
        end = j + 1
        start = end - len(kw)
        if start >= 0 and data[start:end] == kw:
            before = start - 1
            if before < 0 or not (data[before].isalnum() or data[before] in "_$"):
                return True
    return False


def _skip_regex(data, pos):
    """Skip past a regex literal /.../ including flags."""
    i = pos + 1
    in_class = False
    while i < len(data):
        c = data[i]
        if c == "\\":
            i += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
            i += 1
            continue
        if c == "[":
            in_class = True
            i += 1
            continue
        if c == "/":
            i += 1
            while i < len(data) and data[i].isalpha():
                i += 1
            return i
        i += 1
    return i


def extract_hints(data, body_text, max_strings=10):
    """Extract hints about a module's purpose from its content."""
    hints = {}

    # require() calls
    requires = re.findall(r'require\("([^"]+)"\)', body_text[:5000])
    if requires:
        hints["requires"] = list(dict.fromkeys(requires))[:10]

    # Significant string literals (skip very short/generic ones)
    strings = re.findall(r'"([A-Za-z][\w\-\./ ]{5,80})"', body_text[:10000])
    # Deduplicate, keep order
    seen = set()
    unique = []
    for s in strings:
        if s not in seen and s not in ("object", "function", "string", "number", "create"):
            seen.add(s)
            unique.append(s)
    if unique:
        hints["strings"] = unique[:max_strings]

    # Error messages
    errors = re.findall(r'(?:Error|throw|error)\s*\(\s*["`]([^"`]{10,100})', body_text[:10000])
    if errors:
        hints["errors"] = list(dict.fromkeys(errors))[:5]

    return hints


def detect_wrapper_names(data, preamble_size=5000):
    """Auto-detect the CJS and ESM module wrapper function names from the preamble.

    CJS pattern: varname=(a,b)=>()=>(b||a((b={exports:{}}).exports,b),b.exports)
    ESM pattern: varname=(a,b)=>()=>(a&&(b=a(a=0)),b)
    """
    preamble = data[:preamble_size]

    V = r'[\w$]{1,3}'  # JS variable name (1-3 chars, includes $ and _)

    # CJS: contains {exports:{}} - the factory that creates module objects
    cjs_match = re.search(rf'({V})=\({V},{V}\)=>\(\)=>\({V}\|\|{V}\(\({V}=\{{exports:\{{', preamble)
    # ESM: the simpler lazy initializer with the &&/=0 pattern
    esm_match = re.search(rf'({V})=\({V},{V}\)=>\(\)=>\({V}&&\({V}={V}\({V}=0\)\)', preamble)

    cjs_name = cjs_match.group(1) if cjs_match else None
    esm_name = esm_match.group(1) if esm_match else None

    if not cjs_name or not esm_name:
        print(f"  WARNING: Could not auto-detect wrapper names (CJS={cjs_name}, ESM={esm_name})", file=sys.stderr)
        print(f"  Falling back to searching for most common var X=(( patterns...", file=sys.stderr)
        # Fallback: find the most common short identifiers used in var X=Y(( patterns
        from collections import Counter
        candidates = re.findall(r'var \w+=(\w{1,3})\(\(', data[:50000])
        counts = Counter(candidates).most_common(2)
        if len(counts) >= 2:
            # The more common one is ESM (more modules), less common is CJS
            esm_name = esm_name or counts[0][0]
            cjs_name = cjs_name or counts[1][0]
        elif len(counts) == 1:
            esm_name = esm_name or counts[0][0]

    print(f"  Wrapper functions: CJS={cjs_name}, ESM={esm_name}")
    return cjs_name, esm_name


def split_source(source_path, output_dir):
    """Split source.js into individual section files."""
    print(f"Reading {source_path}...")
    data = open(source_path, "r").read()
    print(f"  {len(data):,} chars")

    # Auto-detect module wrapper function names from the preamble
    cjs_name, esm_name = detect_wrapper_names(data)
    wrapper_names = "|".join(filter(None, [re.escape(cjs_name) if cjs_name else None,
                                            re.escape(esm_name) if esm_name else None]))
    if not wrapper_names:
        print("  ERROR: No wrapper functions detected, cannot split.", file=sys.stderr)
        sys.exit(1)

    module_pattern = re.compile(rf"var (\w+)=({wrapper_names})\(\(")
    matches = list(module_pattern.finditer(data))
    print(f"  {len(matches)} modules found")

    # Build segment list
    segments = []
    pos = 0

    for m in matches:
        open_paren = m.end() - 2  # outer ( of F(( or G((
        close_paren = find_matching_paren(data, open_paren)
        if close_paren == -1:
            print(f"  WARNING: Failed to parse module {m.group(1)} at {m.start()}", file=sys.stderr)
            continue

        mod_end = close_paren + 1
        if mod_end < len(data) and data[mod_end] == ";":
            mod_end += 1

        if m.start() > pos:
            segments.append({"type": "glue", "start": pos, "end": m.start()})

        segments.append({
            "type": "module",
            "name": m.group(1),
            "kind": m.group(2),
            "start": m.start(),
            "end": mod_end,
        })
        pos = mod_end

    if pos < len(data):
        segments.append({"type": "tail", "start": pos, "end": len(data)})

    # Group into sections: [glue] + [module]
    # First glue is always preamble; subsequent glues merge with their module
    sections = []
    i = 0
    while i < len(segments):
        seg = segments[i]
        if seg["type"] == "glue":
            if i == 0 and seg["start"] == 0:
                # First glue is always preamble
                sections.append({
                    "type": "preamble",
                    "start": seg["start"],
                    "end": seg["end"],
                })
                i += 1
            elif i + 1 < len(segments) and segments[i + 1]["type"] == "module":
                mod = segments[i + 1]
                sections.append({
                    "type": "section",
                    "glue_start": seg["start"],
                    "glue_end": seg["end"],
                    "module_name": mod["name"],
                    "module_kind": mod["kind"],
                    "start": seg["start"],
                    "end": mod["end"],
                })
                i += 2
            else:
                # Standalone glue (orphan)
                sections.append({
                    "type": "preamble",
                    "start": seg["start"],
                    "end": seg["end"],
                })
                i += 1
        elif seg["type"] == "module":
            # Module with no preceding glue
            sections.append({
                "type": "section",
                "glue_start": None,
                "glue_end": None,
                "module_name": seg["name"],
                "module_kind": seg["kind"],
                "start": seg["start"],
                "end": seg["end"],
            })
            i += 1
        elif seg["type"] == "tail":
            sections.append({
                "type": "tail",
                "start": seg["start"],
                "end": seg["end"],
            })
            i += 1
        else:
            i += 1

    # Verify complete coverage
    total = sum(s["end"] - s["start"] for s in sections)
    assert total == len(data), f"Coverage mismatch: {total} vs {len(data)}"

    # Verify contiguity
    for j in range(len(sections) - 1):
        assert sections[j]["end"] == sections[j + 1]["start"], \
            f"Gap between sections {j} and {j+1}: {sections[j]['end']} != {sections[j+1]['start']}"

    # Write section files
    os.makedirs(output_dir, exist_ok=True)

    manifest = {
        "source_file": os.path.basename(source_path),
        "source_size": len(data),
        "section_count": len(sections),
        "sections": [],
    }

    for idx, section in enumerate(sections):
        body = data[section["start"]:section["end"]]
        sec_type = section["type"]

        if sec_type == "preamble":
            filename = f"{idx:04d}_preamble.js"
        elif sec_type == "tail":
            filename = f"{idx:04d}_tail.js"
        else:
            mod_name = section.get("module_name", "unknown")
            mod_kind = section.get("module_kind", "?")
            filename = f"{idx:04d}_{mod_name}.js"

        filepath = os.path.join(output_dir, filename)
        open(filepath, "w").write(body)

        entry = {
            "index": idx,
            "filename": filename,
            "type": sec_type,
            "size": len(body),
        }

        if sec_type == "section":
            entry["module_name"] = section["module_name"]
            entry["module_kind"] = section["module_kind"]
            entry["has_glue"] = section["glue_start"] is not None
            if section["glue_start"] is not None:
                entry["glue_size"] = section["glue_end"] - section["glue_start"]

            # Extract hints
            hints = extract_hints(data, body)
            if hints:
                entry["hints"] = hints

        manifest["sections"].append(entry)

    # Write manifest
    manifest_path = os.path.join(output_dir, "_manifest.json")
    open(manifest_path, "w").write(json.dumps(manifest, indent=2))

    print(f"\nWrote {len(sections)} sections to {output_dir}/")
    print(f"  Preamble: {sum(1 for s in sections if s['type'] == 'preamble')}")
    print(f"  Modules: {sum(1 for s in sections if s['type'] == 'section')}")
    print(f"  Tail: {sum(1 for s in sections if s['type'] == 'tail')}")
    print(f"  Manifest: {manifest_path}")

    return manifest


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <source.js> [output_dir]")
        sys.exit(1)

    source = sys.argv[1]
    output = sys.argv[2] if len(sys.argv) > 2 else "modules"
    split_source(source, output)

