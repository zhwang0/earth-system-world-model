#!/usr/bin/env python3
"""Static checks for the Earth System World Model website (standard library only).

Verifies that every local file the page references actually exists, that the exported
model weights and the forest-cell chunks are exactly the size their indices promise,
and that nothing heavy is shipped under assets/ that no code ever asks for.

Usage: python3 scripts/validate_site.py [DIR] [--partial]
       DIR       defaults to the website directory; the deploy passes the copy it publishes.
       --partial treats a page that has not been written yet (no index.html / css / js)
                 as a note instead of a failure, so the checks can be run mid-build.

Exit code 1 on any failure.
"""
import json, os, re, sys

args = [a for a in sys.argv[1:] if not a.startswith('-')]
flags = {a for a in sys.argv[1:] if a.startswith('-')}
PARTIAL = '--partial' in flags
ROOT = os.path.abspath(args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

# anything bigger than this must be reachable from the page, or it is dead weight
HUGE = 300 * 1024
ASSET_RE = re.compile(r'^[\w./-]+\.(?:png|jpe?g|webp|gif|svg|ico|css|js|mjs|json|bin|txt|xml|mp4|webm|woff2?)$')

errors, notes = [], []
referenced = set()   # site-relative paths some file names outright
prefixes = set()     # literal 'assets/...' prefixes JS builds paths from at runtime


def fail(msg):
    errors.append(msg)


def absent(what, msg):
    """A part of the site that may legitimately not be written yet."""
    (notes if PARTIAL else errors).append(msg)


def is_local(ref):
    return not re.match(r'^(?:[a-z][a-z0-9+.-]*:|//|#)', ref, re.I)


def norm(path):
    return os.path.normpath(path).replace(os.sep, '/')


def need(path, where):
    """Record a reference and check the file is there."""
    path = norm(path)
    referenced.add(path)
    if path.startswith('../') or os.path.isabs(path):
        fail('%s: %s escapes the site root' % (where, path))
    elif not os.path.exists(os.path.join(ROOT, path)):
        fail('%s: missing %s' % (where, path))


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return f.read()


def walk(rel_dir, suffix):
    base = os.path.join(ROOT, rel_dir)
    for dirpath, _, names in os.walk(base):
        for n in sorted(names):
            if n.endswith(suffix):
                yield norm(os.path.relpath(os.path.join(dirpath, n), ROOT))


# ---------------------------------------------------------------- index.html
html, ids = None, set()
if os.path.exists(os.path.join(ROOT, 'index.html')):
    html = read('index.html')
    referenced.add('index.html')
    ids = set(re.findall(r'id="([^"]+)"', html))
    for ref in re.findall(r'(?:src|href)="([^"]+)"', html):
        if is_local(ref) and ref.strip():
            need(ref.split('#')[0].split('?')[0], 'index.html')
    for ref in re.findall(r'srcset="([^"]+)"', html):
        for cand in ref.split(','):
            url = cand.strip().split()[0] if cand.strip() else ''
            if url and is_local(url):
                need(url.split('?')[0], 'index.html')
    # og:image and friends, plus data-* attributes that name a file
    for ref in re.findall(r'(?:content|data-[\w-]+)="([^"\s]+)"', html):
        if is_local(ref) and ASSET_RE.match(ref) and '/' in ref:
            need(ref.split('?')[0], 'index.html')
    for ref in re.findall(r'href="#([^"]+)"', html):
        if ref and ref not in ids:
            fail('index.html: anchor #%s has no target' % ref)
else:
    absent('index.html', 'index.html not found in %s -- the page has not been written yet' % ROOT)

# ---------------------------------------------------------------------- CSS
css_files = sorted(walk('css', '.css')) if os.path.isdir(os.path.join(ROOT, 'css')) else []
if not css_files:
    absent('css', 'no stylesheet found under css/ -- not written yet')
for css in css_files:
    referenced.add(css)
    for ref in re.findall(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)', read(css)):
        if is_local(ref):
            need(os.path.join(os.path.dirname(css), ref.split('?')[0]), css)

# ----------------------------------------------------------------- JS modules
IMPORT_RE = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(|new\s+URL\s*\(\s*)['"]([^'"]+)['"]""")
LITERAL_RE = re.compile(r"""['"`](assets/[^'"`\s${}]*)['"`]""")
PREFIX_RE = re.compile(r"""['"`](assets/[^'"`\s]*?/)(?:\$\{|['"`])""")

app_js = sorted(walk('js', '.js')) if os.path.isdir(os.path.join(ROOT, 'js')) else []
if not app_js:
    absent('js', 'no modules found under js/ -- not written yet')
vendor_js = sorted(walk('assets/vendor', '.js'))

for js in app_js + vendor_js:
    referenced.add(js)
    src = read(js)
    for ref in IMPORT_RE.findall(src):
        if is_local(ref):
            need(os.path.join(os.path.dirname(js), ref.split('?')[0]), js)
    if js in vendor_js:
        continue  # minified third-party code: resolve its imports, do not mine it for strings
    for ref in LITERAL_RE.findall(src):
        need(ref, js)
    for pre in PREFIX_RE.findall(src):
        prefixes.add(norm(pre) + '/')
    for sel in re.findall(r"""getElementById\(\s*['"]([\w-]+)['"]""", src) + \
               re.findall(r"""\$\(\s*['"]#([\w-]+)['"]""", src):
        if html is not None and sel not in ids:
            fail('%s: #%s not found in index.html' % (js, sel))

# -------------------------------------------------------------- model weights
MODEL = 'assets/model/manifest.json'
if not os.path.exists(os.path.join(ROOT, MODEL)):
    fail('%s: missing' % MODEL)
else:
    referenced.add(MODEL)
    try:
        man = json.loads(read(MODEL))
    except ValueError as e:
        man = None
        fail('%s: not valid JSON (%s)' % (MODEL, e))
    if man is not None:
        n_floats = 0
        for i, p in enumerate(man['params']):
            count = 1
            for s in p['shape']:
                count *= s
            if count != p['count']:
                fail('%s: %s shape %s is %d floats, count says %d' % (MODEL, p['name'], p['shape'], count, p['count']))
            if p['offset'] != n_floats:
                fail('%s: %s starts at %d, the running offset is %d' % (MODEL, p['name'], p['offset'], n_floats))
            n_floats += p['count']
        for key, n in (('x_mean', man['n_forcing']), ('x_std', man['n_forcing']),
                       ('y_mean', len(man['bands'])), ('y_std', len(man['bands'])),
                       ('floors', len(man['bands']))):
            if len(man[key]) != n:
                fail('%s: %s has %d entries, expected %d' % (MODEL, key, len(man[key]), n))
        for age, entry in sorted(man['ages'].items()):
            path = 'assets/model/' + entry['file']
            need(path, '%s age %s' % (MODEL, age))
            if entry.get('floats', n_floats) != n_floats:
                fail('%s age %s: floats %d, the parameter list totals %d' % (MODEL, age, entry['floats'], n_floats))
            full = os.path.join(ROOT, path)
            if os.path.exists(full):
                want = n_floats * 4
                got = os.path.getsize(full)
                if got != want:
                    fail('%s: %d bytes, expected %d (%d float32)' % (path, got, want, n_floats))
            for key in ('age_mean_n', 'age_slope_n'):
                if len(entry[key]) != len(man['bands']):
                    fail('%s age %s: %s has %d entries, expected %d'
                         % (MODEL, age, key, len(entry[key]), len(man['bands'])))

# --------------------------------------------------------------- forest cells
CELLS = 'assets/cells/index.json'
if not os.path.exists(os.path.join(ROOT, CELLS)):
    absent('cells', '%s not found -- the cell export has not been written yet' % CELLS)
else:
    referenced.add(CELLS)
    try:
        idx = json.loads(read(CELLS))
    except ValueError as e:
        idx = None
        fail('%s: not valid JSON (%s)' % (CELLS, e))

    def pick(d, *names):
        for n in names:
            if n in d:
                return d[n], n
        return None, None

    if idx is not None:
        default_bytes, _ = pick(idx, 'cell_bytes', 'bytes_per_cell', 'stride')
        chunks, _ = pick(idx, 'chunks', 'files')
        if chunks is None and pick(idx, 'file', 'path')[0] is not None:
            chunks = [idx]          # a single payload rather than a chunk list
        if chunks is None:
            fail('%s: no "chunks" list and no "file" -- cannot check the payloads' % CELLS)
            chunks = []
        total = 0
        for i, ch in enumerate(chunks):
            where = '%s chunk %d' % (CELLS, i)
            name, _ = pick(ch, 'file', 'path', 'name')
            count, ckey = pick(ch, 'count', 'n', 'cells', 'n_cells')
            cb = ch.get('cell_bytes', default_bytes)
            if name is None:
                fail('%s: no "file"' % where)
                continue
            path = norm('assets/cells/' + name) if '/' not in name else norm(name)
            need(path, where)
            if count is None or cb is None:
                fail('%s: need a cell count and cell_bytes to check %s' % (where, path))
                continue
            total += count
            full = os.path.join(ROOT, path)
            if os.path.exists(full):
                want = cb * count
                got = os.path.getsize(full)
                if got != want:
                    fail('%s: %d bytes, expected %d (%d cells x %d bytes)' % (path, got, want, count, cb))
        declared, dkey = pick(idx, 'count', 'n_cells', 'total')
        if declared is not None and chunks and declared != total:
            fail('%s: %s says %d cells, the chunks hold %d' % (CELLS, dkey, declared, total))

# ------------------------------------------------- nothing heavy and unasked-for
def is_referenced(path):
    if path in referenced:
        return True
    return any(path.startswith(p.rstrip('/') + '/') for p in prefixes)


if html is None:
    notes.append('skipped the unreferenced-asset scan: with no index.html there is nothing that could reference them yet')
elif os.path.isdir(os.path.join(ROOT, 'assets')):
    by_stem = {}
    for path in walk('assets', ''):
        by_stem.setdefault(os.path.splitext(path)[0], []).append(path)
    for path in sorted(walk('assets', '')):
        size = os.path.getsize(os.path.join(ROOT, path))
        if size <= HUGE or is_referenced(path):
            continue
        siblings = [p for p in by_stem[os.path.splitext(path)[0]] if p != path and is_referenced(p)]
        if siblings:
            notes.append('%s: %d kB, unused -- %s is the one the page loads' % (path, size // 1024, siblings[0]))
        else:
            fail('%s: %d kB and nothing references it' % (path, size // 1024))

# ------------------------------------------------------------------- verdict
for n in notes:
    print('note: ' + n)
if errors:
    print('\n'.join(errors))
    print('FAILED: %d problem%s in %s' % (len(errors), '' if len(errors) == 1 else 's', ROOT))
    sys.exit(1)
print('OK: %d referenced files, %d modules, model weights and cell chunks all the right size.'
      % (len(referenced), len(app_js)))
