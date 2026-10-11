#!/usr/bin/env python3
"""Everwake — stamp the shared page chrome into every page.

The header, footer, contact form and <head> live once, in src/partials/.
Each page marks where they go:

    <!-- ew:head -->     ...     <!-- /ew:head -->
    <!-- ew:header -->   ...     <!-- /ew:header -->
    <!-- ew:contact -->  ...     <!-- /ew:contact -->   (optional)
    <!-- ew:footer -->   ...     <!-- /ew:footer -->

Run after changing anything in src/partials/:

    python3 tools/sync_chrome.py

Everything between the markers is replaced. Everything outside them — the
page's own content — is never touched. Each page keeps its own <title> and
description: they are read from the page before the head is rebuilt, so edit
them in the page as normal.

The script finishes by checking every internal link and #anchor on the site
and exits non-zero if any is broken.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PARTIALS = ROOT / "src" / "partials"
SITE = "https://everwake.tech"
LANGS = ["ar", "es", "fr"]

# Line icons for the eight services, shared by the menu and the pages.
_ICON_PATHS = {
    "voice":      '<path d="M5 4h3.2l1.8 4.6-2.3 1.5a11.5 11.5 0 0 0 6.2 6.2l1.5-2.3L20 15.8V19a2 2 0 0 1-2.2 2A17 17 0 0 1 3 6.2 2 2 0 0 1 5 4z"/>',
    "chat":       '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/><path d="M8.5 10h.01M12 10h.01M15.5 10h.01"/>',
    "automation": '<path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9"/><path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9"/><path d="M18 3.5v4h-4"/><path d="M6 20.5v-4h4"/>',
    "custom":     '<path d="M12 3.5l1.7 4.6 4.8 1.7-4.8 1.7L12 16.2l-1.7-4.7-4.8-1.7 4.8-1.7z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    "web":        '<rect x="3" y="4.5" width="18" height="15" rx="1.5"/><path d="M3 9h18"/><path d="M6 6.8h.01M8.5 6.8h.01"/><path d="M7 13h6M7 16h4"/>',
    "smart":      '<path d="M4 20V11M9.3 20V6M14.7 20v-6M20 20V9"/><path d="M2.5 20.5h19"/>',
    "marketing":  '<path d="M4 10.5v3a1 1 0 0 0 1 1h2l5.5 4V5.5L7 9.5H5a1 1 0 0 0-1 1z"/><path d="M15.5 9a3.5 3.5 0 0 1 0 6"/><path d="M18 6.5a7 7 0 0 1 0 11"/>',
    "consulting": '<circle cx="12" cy="12" r="8.5"/><path d="M15.4 8.6l-2 5-4.8 1.8 2-5z"/>',
}
ICONS = {
    k: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + v + "</svg>"
    for k, v in _ICON_PATHS.items()
}

# Which top-bar item is highlighted on each page.
NAV_KEY = {
    "index": "home", "services": "services", "agent": "services", "pricing": "pricing",
    "faq": "faq", "blog": "blog", "about": "about", "contact": "contact",
}


def nav_key(rel):
    return "blog" if rel.parts[0] == "blog" else NAV_KEY.get(rel.stem, "")


def clean_url(rel):
    """The address Cloudflare serves the page at (it drops .html)."""
    path = rel.as_posix()[:-len(".html")]
    if path == "index":
        return SITE + "/"
    return SITE + "/" + path


def render(name, root, **values):
    text = (PARTIALS / (name + ".html")).read_text()
    text = text.replace("{{root}}", root)
    text = re.sub(r"\{\{icon:(\w+)\}\}", lambda m: ICONS[m.group(1)], text)
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text.strip("\n")


def set_region(page, name, content):
    pattern = re.compile(r"(<!-- ew:%s -->).*?(<!-- /ew:%s -->)" % (name, name), re.S)
    if not pattern.search(page):
        return page, False
    return pattern.sub(lambda m: m.group(1) + "\n" + content + "\n" + m.group(2), page), True


def seo_block(rel):
    if rel.name == "404.html":
        return '<meta name="robots" content="noindex">'
    url = clean_url(rel)
    lines = [
        '<link rel="canonical" href="%s">' % url,
        '<meta property="og:url" content="%s">' % url,
        '<link rel="alternate" hreflang="en" href="%s">' % url,
    ]
    lines += ['<link rel="alternate" hreflang="%s" href="%s?lang=%s">' % (l, url, l) for l in LANGS]
    lines.append('<link rel="alternate" hreflang="x-default" href="%s">' % url)
    return "\n".join(lines)


def sync_page(path):
    rel = path.relative_to(WEB)
    # The 404 page is served at whatever address was mistyped, so relative
    # paths would break; it alone uses absolute ones.
    root = "/" if rel.name == "404.html" else "../" * (len(rel.parts) - 1)
    page = path.read_text()

    title = re.search(r"<title>(.*?)</title>", page, re.S)
    desc = re.search(r'<meta name="description" content="([^"]*)"', page)
    if not title or not desc:
        raise SystemExit("%s: needs a <title> and a meta description" % rel)

    head = render("head", root, title=title.group(1).strip(),
                  description=desc.group(1), seo=seo_block(rel))
    header = render("header", root)
    key = nav_key(rel)
    if key:
        header = header.replace('data-nav="%s"' % key, 'data-nav="%s" aria-current="page"' % key)

    updated = page
    for name, content in (("head", head), ("header", header),
                          ("contact", render("contact", root)),
                          ("footer", render("footer", root))):
        updated, found = set_region(updated, name, content)
        if not found and name in ("head", "header", "footer"):
            raise SystemExit("%s: missing <!-- ew:%s --> marker" % (rel, name))

    if updated != page:
        path.write_text(updated)
        return True
    return False


def check_links(pages):
    """Every relative href/src must exist, and every #anchor must exist on its page."""
    ids = {}
    for p in pages:
        ids[p.resolve()] = set(re.findall(r'\sid="([^"]+)"', p.read_text()))
    broken = []
    for p in pages:
        for attr, target in re.findall(r'\s(href|src)="([^"]+)"', p.read_text()):
            if re.match(r"(https?:|mailto:|tel:|data:|javascript:|//)", target) or "{{" in target:
                continue
            file_part, _, anchor = target.partition("#")
            file_part = file_part.split("?")[0]
            if file_part.startswith("/"):          # site-absolute: resolve from web/
                dest = (WEB / file_part.lstrip("/")).resolve()
            else:
                dest = (p.parent / file_part).resolve() if file_part else p.resolve()
            if not dest.exists():
                broken.append("%s → %s (missing file)" % (p.relative_to(WEB), target))
            elif anchor and dest.suffix == ".html" and anchor not in ids.get(dest, set()):
                broken.append("%s → %s (missing #%s)" % (p.relative_to(WEB), target, anchor))
    return broken


def main():
    pages = sorted(WEB.rglob("*.html"))
    changed = [p for p in pages if sync_page(p)]
    for p in changed:
        print("  synced", p.relative_to(WEB))
    print("%d pages, %d updated" % (len(pages), len(changed)))
    broken = check_links(pages)
    if broken:
        print("\nBROKEN LINKS:")
        for b in broken:
            print("  " + b)
        sys.exit(1)
    print("All internal links and anchors resolve.")


if __name__ == "__main__":
    main()
