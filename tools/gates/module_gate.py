"""Module gate for a cvinject build.
  python3 tools/gates/module_gate.py <workdir> <live-binary> <control-rebuild> <stock-new> <patched-new>
CONTROL: <control-rebuild> (cvinject on the live version's stock binary) must
equal <live-binary> module for module (expect 0), or this cvinject is not
what built live. Then every module the patched build changes must pass
`node --check` wherever its stock version does; a seeded syntax error proves
the check can fail."""
import sys, subprocess, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from cvinject import Graph
S = sys.argv[1]
LIVE, CONTROL, STOCK, NEW = sys.argv[2:6]

def diff(a, b):
    ga, gb = Graph(a), Graph(b)
    assert len(ga.modules) == len(gb.modules), "module count differs"
    return ga, gb, [i for i, (x, y) in enumerate(zip(ga.modules, gb.modules)) if x.contents != y.contents]

def check(src, name):
    p = os.path.join(S, name)
    open(p, "wb").write(src)
    return subprocess.run(["node", "--check", p], capture_output=True, text=True).returncode == 0

_, _, d = diff(LIVE, CONTROL)
print(f"CONTROL live vs rebuilt: {len(d)} differing modules (expect 0)")

stock, new, d = diff(STOCK, NEW)
print(f"stock vs patched: {len(d)} differing modules: {d}")
bad = 0
for i in d:
    s_ok = check(stock.modules[i].contents, f"m{i}-stock.mjs")
    n_ok = check(new.modules[i].contents, f"m{i}-new.mjs")
    flag = "OK" if (n_ok or not s_ok) else "BROKEN"
    bad += flag == "BROKEN"
    print(f"  module[{i}] {stock.modules[i].name[:50]}: stock {'pass' if s_ok else 'FAIL'} -> patched {'pass' if n_ok else 'FAIL'}  {flag}")
i = d[0]
seeded = new.modules[i].contents.replace(b"//", b"}{//", 1)
print(f"SEEDED control (syntax error in module[{i}]): node --check {'passed — GATE CANNOT FAIL' if check(seeded, 'seeded.mjs') else 'failed, as it must'}")
print("GATE:", "PASS" if bad == 0 else f"FAIL ({bad} broken)")
